import { fetchWithRetry, type RetryOptions } from '../http';
import { estimateCostUsd } from '../pricing';
import { RateLimiter } from '../rate-limiter';
import { countTokens } from '../tokens';
import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  ChatStreamChunk,
  EmbeddingProvider,
  EmbeddingResult,
  UsageSink,
} from '../types';
import { readSseEvents } from './sse';

export interface OpenAIOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  onUsage?: UsageSink;
  retry?: Partial<RetryOptions>;
  providerName?: string;
  reasoningEffort?: string;
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'rag-institucional' };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

function buildBody(req: ChatRequest, stream: boolean, reasoningEffort?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0,
    stream,
  };
  if (req.maxTokens) body.max_completion_tokens = req.maxTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (stream) body.stream_options = { include_usage: true };
  if (req.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
    };
  }
  return body;
}

export class OpenAIChatProvider implements ChatProvider {
  readonly name: string;

  constructor(private readonly opts: OpenAIOptions) {
    this.name = opts.providerName ?? 'openai';
  }

  private report(req: ChatRequest, result: Omit<ChatResult, 'content'> | null, latencyMs: number) {
    this.opts.onUsage?.({
      operation: req.operation,
      provider: this.name,
      model: req.model,
      tokensIn: result?.usage.tokensIn ?? 0,
      tokensOut: result?.usage.tokensOut ?? 0,
      costUsd: result ? estimateCostUsd(this.name, req.model, result.usage.tokensIn, result.usage.tokensOut) : 0,
      latencyMs,
      success: result !== null,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const started = performance.now();
    try {
      const res = await fetchWithRetry(
        `${this.opts.baseUrl}/chat/completions`,
        { method: 'POST', headers: headers(this.opts.apiKey), body: JSON.stringify(buildBody(req, false, this.opts.reasoningEffort)) },
        { ...this.opts.retry, timeoutMs: this.opts.timeoutMs, signal: req.signal },
      );
      const json = (await res.json()) as {
        choices: { message: { content: string | null }; finish_reason: string | null }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
        model: string;
      };
      const content = json.choices[0]?.message.content ?? '';
      const result: ChatResult = {
        content,
        model: json.model ?? req.model,
        finishReason: json.choices[0]?.finish_reason ?? null,
        usage: json.usage
          ? { tokensIn: json.usage.prompt_tokens, tokensOut: json.usage.completion_tokens, estimated: false }
          : { tokensIn: countTokens(req.messages.map((m) => m.content).join('\n')), tokensOut: countTokens(content), estimated: true },
        latencyMs: Math.round(performance.now() - started),
      };
      this.report(req, result, result.latencyMs);
      return result;
    } catch (err) {
      this.report(req, null, Math.round(performance.now() - started));
      throw err;
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const started = performance.now();
    let content = '';
    let usage: ChatResult['usage'] | null = null;
    let finishReason: string | null = null;
    let ok = false;
    try {
      const res = await fetchWithRetry(
        `${this.opts.baseUrl}/chat/completions`,
        { method: 'POST', headers: headers(this.opts.apiKey), body: JSON.stringify(buildBody(req, true, this.opts.reasoningEffort)) },
        { ...this.opts.retry, timeoutMs: this.opts.timeoutMs, signal: req.signal },
      );
      for await (const data of readSseEvents(res.body!, req.signal)) {
        if (data === '[DONE]') break;
        const evt = JSON.parse(data) as {
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
          usage?: { prompt_tokens: number; completion_tokens: number } | null;
        };
        const delta = evt.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          yield { type: 'delta', text: delta };
        }
        if (evt.choices?.[0]?.finish_reason) finishReason = evt.choices[0].finish_reason;
        if (evt.usage) usage = { tokensIn: evt.usage.prompt_tokens, tokensOut: evt.usage.completion_tokens, estimated: false };
      }
      ok = true;
      const result: ChatResult = {
        content,
        model: req.model,
        finishReason,
        usage: usage ?? {
          tokensIn: countTokens(req.messages.map((m) => m.content).join('\n')),
          tokensOut: countTokens(content),
          estimated: true,
        },
        latencyMs: Math.round(performance.now() - started),
      };
      this.report(req, result, result.latencyMs);
      yield { type: 'done', result };
    } finally {
      if (!ok) this.report(req, null, Math.round(performance.now() - started));
    }
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly opts: OpenAIOptions & { maxRpm: number },
    readonly model: string,
    readonly dimensions: number,
  ) {
    this.name = opts.providerName ?? 'openai';
    this.limiter = new RateLimiter(opts.maxRpm);
  }

  async embed(texts: string[], o: { signal?: AbortSignal; operation?: string } = {}): Promise<EmbeddingResult> {
    await this.limiter.acquire();
    const started = performance.now();
    const body: Record<string, unknown> = { model: this.model, input: texts, encoding_format: 'float', dimensions: this.dimensions };
    try {
      const res = await fetchWithRetry(
        `${this.opts.baseUrl}/embeddings`,
        { method: 'POST', headers: headers(this.opts.apiKey), body: JSON.stringify(body) },
        { ...this.opts.retry, timeoutMs: this.opts.timeoutMs, signal: o.signal },
      );
      const json = (await res.json()) as { data: { embedding: number[]; index: number }[]; usage?: { prompt_tokens: number } };
      const vectors = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      validateVectors(vectors, texts.length, this.dimensions);
      const tokensIn = json.usage?.prompt_tokens ?? texts.reduce((s, t) => s + countTokens(t), 0);
      const latencyMs = Math.round(performance.now() - started);
      this.opts.onUsage?.({
        operation: o.operation ?? 'embedding',
        provider: this.name,
        model: this.model,
        tokensIn,
        tokensOut: 0,
        costUsd: estimateCostUsd(this.name, this.model, tokensIn, 0),
        latencyMs,
        success: true,
      });
      return { vectors, usage: { tokensIn, tokensOut: 0, estimated: !json.usage }, latencyMs };
    } catch (err) {
      this.opts.onUsage?.({
        operation: o.operation ?? 'embedding',
        provider: this.name,
        model: this.model,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: Math.round(performance.now() - started),
        success: false,
      });
      throw err;
    }
  }
}

export function validateVectors(vectors: number[][], expected: number, dimensions: number): void {
  if (vectors.length !== expected) {
    throw new Error(`Provedor retornou ${vectors.length} embeddings para ${expected} textos`);
  }
  for (const v of vectors) {
    if (v.length !== dimensions) {
      throw new Error(`Dimensão do embedding (${v.length}) difere da configurada (${dimensions})`);
    }
    if (v.some((x) => !Number.isFinite(x))) throw new Error('Embedding contém valores não finitos');
  }
}
