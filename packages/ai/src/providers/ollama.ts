import { fetchWithRetry, type RetryOptions } from '../http';
import { RateLimiter } from '../rate-limiter';
import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  ChatStreamChunk,
  EmbeddingProvider,
  EmbeddingResult,
  UsageSink,
} from '../types';
import { validateVectors } from './openai';
import { readNdjson } from './sse';

export interface OllamaOptions {
  baseUrl: string;
  numCtx: number;
  timeoutMs: number;
  onUsage?: UsageSink;
  retry?: Partial<RetryOptions>;
}

interface OllamaChatChunk {
  model: string;
  message?: { content?: string };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Adaptador nativo do Ollama. Usa /api/chat para controlar explicitamente a janela de
 * contexto (num_ctx), evitando truncamento silencioso de prompts longos.
 */
export class OllamaChatProvider implements ChatProvider {
  readonly name = 'ollama';

  constructor(private readonly opts: OllamaOptions) {}

  private body(req: ChatRequest, stream: boolean) {
    const options: Record<string, unknown> = { temperature: req.temperature ?? 0, num_ctx: this.opts.numCtx };
    if (req.maxTokens) options.num_predict = req.maxTokens;
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream, options, keep_alive: '30m' };
    if (req.jsonSchema) body.format = req.jsonSchema.schema;
    return JSON.stringify(body);
  }

  private report(req: ChatRequest, result: ChatResult | null, latencyMs: number) {
    this.opts.onUsage?.({
      operation: req.operation,
      provider: this.name,
      model: req.model,
      tokensIn: result?.usage.tokensIn ?? 0,
      tokensOut: result?.usage.tokensOut ?? 0,
      costUsd: 0,
      latencyMs,
      success: result !== null,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const started = performance.now();
    try {
      const res = await fetchWithRetry(
        `${this.opts.baseUrl}/api/chat`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: this.body(req, false) },
        { ...this.opts.retry, timeoutMs: this.opts.timeoutMs, signal: req.signal },
      );
      const json = (await res.json()) as OllamaChatChunk;
      if (json.error) throw new Error(json.error);
      const result: ChatResult = {
        content: json.message?.content ?? '',
        model: json.model,
        finishReason: json.done_reason ?? null,
        usage: { tokensIn: json.prompt_eval_count ?? 0, tokensOut: json.eval_count ?? 0, estimated: false },
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
    let ok = false;
    try {
      const res = await fetchWithRetry(
        `${this.opts.baseUrl}/api/chat`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: this.body(req, true) },
        { ...this.opts.retry, timeoutMs: this.opts.timeoutMs, signal: req.signal },
      );
      let last: OllamaChatChunk | null = null;
      for await (const line of readNdjson(res.body!, req.signal)) {
        const chunk = JSON.parse(line) as OllamaChatChunk;
        if (chunk.error) throw new Error(chunk.error);
        const delta = chunk.message?.content;
        if (delta) {
          content += delta;
          yield { type: 'delta', text: delta };
        }
        if (chunk.done) {
          last = chunk;
          break;
        }
      }
      ok = true;
      const result: ChatResult = {
        content,
        model: last?.model ?? req.model,
        finishReason: last?.done_reason ?? null,
        usage: { tokensIn: last?.prompt_eval_count ?? 0, tokensOut: last?.eval_count ?? 0, estimated: false },
        latencyMs: Math.round(performance.now() - started),
      };
      this.report(req, result, result.latencyMs);
      yield { type: 'done', result };
    } finally {
      if (!ok) this.report(req, null, Math.round(performance.now() - started));
    }
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  private readonly limiter: RateLimiter;

  constructor(
    private readonly opts: OllamaOptions & { maxRpm: number },
    readonly model: string,
    readonly dimensions: number,
  ) {
    this.limiter = new RateLimiter(opts.maxRpm);
  }

  async embed(texts: string[], o: { signal?: AbortSignal; operation?: string } = {}): Promise<EmbeddingResult> {
    await this.limiter.acquire();
    const started = performance.now();
    try {
      const res = await fetchWithRetry(
        `${this.opts.baseUrl}/api/embed`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: texts, truncate: true, keep_alive: '30m', options: { num_ctx: 8192 } }),
        },
        { ...this.opts.retry, timeoutMs: this.opts.timeoutMs, signal: o.signal },
      );
      const json = (await res.json()) as { embeddings: number[][]; prompt_eval_count?: number; error?: string };
      if (json.error) throw new Error(json.error);
      validateVectors(json.embeddings, texts.length, this.dimensions);
      const latencyMs = Math.round(performance.now() - started);
      const tokensIn = json.prompt_eval_count ?? 0;
      this.opts.onUsage?.({
        operation: o.operation ?? 'embedding',
        provider: this.name,
        model: this.model,
        tokensIn,
        tokensOut: 0,
        costUsd: 0,
        latencyMs,
        success: true,
      });
      return { vectors: json.embeddings, usage: { tokensIn, tokensOut: 0, estimated: false }, latencyMs };
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
