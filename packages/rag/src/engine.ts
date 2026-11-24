import {
  estimateCostUsd,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamChunk,
  type EmbeddingProvider,
  type Reranker,
} from '@rag/ai';
import { getActiveEmbeddingModel, type Database, type EmbeddingModelRow } from '@rag/database';
import {
  AppError,
  NO_EVIDENCE_MESSAGE,
  type AnswerType,
  type CitationDto,
  type GroundingReportDto,
  type Principal,
  type RagSettings,
  type RetrievalFilters,
  type SourceDto,
} from '@rag/shared';
import { Stopwatch, type Logger } from '@rag/shared/server';
import { trace } from '@opentelemetry/api';
import { createHash } from 'node:crypto';
import { buildContext, toSourceDto, type ContextSource } from './generation/context';
import { classifyAnswer, toCitationRecords } from './generation/citations';
import { verifyGrounding } from './generation/grounding';
import { buildUserPrompt, PROMPT_VERSION, SYSTEM_PROMPT } from './generation/prompts';
import { isHistoricalQuestion, type EffectiveFilters } from './retrieval/filters';
import { rewriteQuery, selectHistory, type HistoryTurn } from './retrieval/query-rewrite';
import { ementaListQuery, formatEmentaAnswer, searchActsByEmenta, EMENTA_LIST_LIMIT } from './retrieval/ementa-search';
import { retrieve, type RetrievalStats } from './retrieval/retriever';
import { detectPromptInjection } from './security/injection';

const tracer = trace.getTracer('rag.engine');

export type EngineEvent =
  | { type: 'status'; stage: 'rewriting' | 'retrieving' | 'reranking' | 'generating' | 'verifying' }
  | { type: 'rewrite'; rewrittenQuery: string }
  | { type: 'sources'; sources: SourceDto[] }
  | { type: 'token'; text: string };

export interface EngineResult {
  content: string;
  answerType: AnswerType;
  rewrittenQuery: string | null;
  searchQuery: string;
  includeHistorical: boolean;
  sources: SourceDto[];
  contextSources: ContextSource[];
  citations: Omit<CitationDto, 'id' | 'documentTitle' | 'documentNumber' | 'available'>[];
  grounding: GroundingReportDto | null;
  retrieval: RetrievalStats;
  /** Candidatos ordenados (antes do corte de contexto), para avaliação. */
  rankedChunkIds: string[];
  rankedCandidates: { chunkId: string; documentId: string; documentNumber: string | null; accessLevel: string; content: string; pageStart: number | null }[];
  timings: Record<string, number>;
  usage: { tokensIn: number; tokensOut: number; costUsd: number };
  model: string;
  embeddingModelId: string;
  evidenceScore: number | null;
  promptVersion: string;
  questionFlags: string[];
}

/** Envolve um provedor de chat somando o uso de tokens da requisição atual. */
class UsageCollector implements ChatProvider {
  tokensIn = 0;
  tokensOut = 0;
  costUsd = 0;
  readonly name: string;

  constructor(private readonly inner: ChatProvider) {
    this.name = inner.name;
  }

  private add(req: ChatRequest, r: ChatResult) {
    this.tokensIn += r.usage.tokensIn;
    this.tokensOut += r.usage.tokensOut;
    this.costUsd += estimateCostUsd(this.inner.name, req.model, r.usage.tokensIn, r.usage.tokensOut);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const r = await this.inner.chat(req);
    this.add(req, r);
    return r;
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    for await (const chunk of this.inner.stream(req)) {
      if (chunk.type === 'done') this.add(req, chunk.result);
      yield chunk;
    }
  }
}

/**
 * Armazena respostas geradas pela entrada exata do LLM (pergunta normalizada + contexto recuperado).
 * Como a chave inclui o texto dos trechos, alterações, desativações e restrições de acesso
 * mudam a chave sem necessidade de invalidação explícita.
 */
export interface AnswerCache {
  get(key: string): Promise<string | null>;
  set(key: string, content: string): Promise<void>;
}

export interface EngineDeps {
  db: Database;
  chat: ChatProvider;
  embeddingProviderFor: (model: EmbeddingModelRow) => EmbeddingProvider;
  rerankerFor: (settings: RagSettings, chat: ChatProvider) => Reranker;
  getSettings: () => Promise<RagSettings>;
  logger: Logger;
  answerCache?: AnswerCache;
}

export function normalizeQuestionForCache(question: string): string {
  return question.normalize('NFC').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').replace(/[\s?!.;:]+$/u, '').trim();
}

export function answerCacheKey(parts: { model: string; temperature: number; maxTokens: number; system: string; user: string }): string {
  const h = createHash('sha256');
  for (const v of [PROMPT_VERSION, parts.model, String(parts.temperature), String(parts.maxTokens), parts.system, parts.user]) {
    h.update(v).update('\u0000');
  }
  return `answer:${h.digest('hex')}`;
}

export interface AnswerInput {
  question: string;
  history: HistoryTurn[];
  filters?: RetrievalFilters;
  principal: Principal;
  signal?: AbortSignal;
  /** Sobrescritas para experimentos (não persistidas). */
  settingsOverride?: (s: RagSettings) => RagSettings;
  /** Interrompe após a recuperação (experimentos de recuperação; não gera resposta). */
  retrievalOnly?: boolean;
  /**
   * 'bypass' ignora o cache (avaliações e experimentos); 'refresh' gera de novo e substitui a entrada
   * (regeneração pedida pelo usuário). Padrão: lê e grava.
   */
  answerCacheMode?: 'default' | 'refresh' | 'bypass';
}

export class RagEngine {
  constructor(private readonly deps: EngineDeps) {}

  async *answer(input: AnswerInput): AsyncGenerator<EngineEvent, EngineResult> {
    const span = tracer.startSpan('rag.answer');
    try {
      return yield* this.run(input);
    } finally {
      span.end();
    }
  }

  private async *run(input: AnswerInput): AsyncGenerator<EngineEvent, EngineResult> {
    const sw = new Stopwatch();
    const base = await this.deps.getSettings();
    const settings = input.settingsOverride ? input.settingsOverride(base) : base;
    const model = await getActiveEmbeddingModel(this.deps.db);
    if (!model) throw new AppError('INTERNAL_ERROR', 'Nenhum modelo de embedding ativo');
    const chat = new UsageCollector(this.deps.chat);
    const embeddingProvider = this.deps.embeddingProviderFor(model);
    const reranker = this.deps.rerankerFor(settings, chat);
    const questionFlags: string[] = [];
    if (detectPromptInjection(input.question).suspicious) questionFlags.push('possible_prompt_injection');

    // 1. Contexto da conversa e reformulação
    const history = selectHistory(input.history, settings.rewrite.historyMessages, settings.rewrite.historyTokenBudget);
    let searchQuery = input.question;
    let rewrittenQuery: string | null = null;
    if (history.length > 0 && settings.rewrite.enabled) {
      yield { type: 'status', stage: 'rewriting' };
      const rw = await sw.measure('rewrite', () =>
        rewriteQuery({ provider: chat, model: settings.rewrite.model, question: input.question, history, enabled: true, signal: input.signal }),
      );
      if (rw.rewritten) {
        searchQuery = rw.query;
        rewrittenQuery = rw.query;
        yield { type: 'rewrite', rewrittenQuery: rw.query };
      }
    }

    // 2. Recuperação híbrida + reranking
    const includeHistorical = input.filters?.includeHistorical ?? (isHistoricalQuestion(input.question) || isHistoricalQuestion(searchQuery));
    const filters: EffectiveFilters = { ...(input.filters ?? {}), clearance: input.principal.clearance, includeHistorical };
    yield { type: 'status', stage: 'retrieving' };
    const earlierUser = [...history].reverse().find((turn) => turn.role === 'user')?.content ?? '';
    const ementaQuery = ementaListQuery(input.question, earlierUser) ?? (searchQuery !== input.question ? ementaListQuery(searchQuery) : null);
    if (ementaQuery) {
      const hits = await sw.measure('ementaSearch', () => searchActsByEmenta(this.deps.db, ementaQuery, filters));
      if (hits.length > 0) {
        const formatted = formatEmentaAnswer(hits, hits.length > EMENTA_LIST_LIMIT, ementaQuery.documentType);
        const sources = formatted.sources.map(toSourceDto);
        yield { type: 'sources', sources };
        yield { type: 'status', stage: 'generating' };
        yield { type: 'token', text: formatted.text };
        yield { type: 'status', stage: 'verifying' };
        const g = await sw.measure('grounding', () =>
          verifyGrounding({
            answer: formatted.text,
            sources: formatted.sources,
            minSupportScore: settings.grounding.minSupportScore,
            llmVerifier: undefined,
          }),
        );
        const grounding: GroundingReportDto | null = settings.grounding.enabled ? g.report : null;
        const claimFor = (idx: number) => g.claims.find((c) => idx >= c.start && idx < c.end)?.text ?? '';
        return {
          rewrittenQuery,
          searchQuery,
          includeHistorical,
          retrieval: { vectorCandidates: 0, lexicalCandidates: 0, fusedCandidates: hits.length, rerankedCandidates: 0, rerankFailed: false, rerankSkipped: true },
          rankedChunkIds: formatted.sources.map((s) => s.chunkId),
          rankedCandidates: [],
          model: settings.generation.chatModel,
          embeddingModelId: model.id,
          evidenceScore: 1,
          promptVersion: PROMPT_VERSION,
          questionFlags,
          content: formatted.text,
          answerType: 'answered',
          sources,
          contextSources: formatted.sources,
          citations: toCitationRecords(g.checks, claimFor, g.supportByCitation),
          grounding,
          timings: sw.toJSON(),
          usage: { tokensIn: chat.tokensIn, tokensOut: chat.tokensOut, costUsd: chat.costUsd },
        };
      }
    }
    const retrieval = await retrieve(
      { db: this.deps.db, embeddingModel: model, embeddingProvider, reranker },
      { query: searchQuery, filters, settings, signal: input.signal },
    );
    for (const [k, v] of Object.entries(retrieval.timings)) if (k !== 'total') sw.record(k, v);

    const base_result = {
      rewrittenQuery,
      searchQuery,
      includeHistorical,
      retrieval: retrieval.stats,
      rankedChunkIds: retrieval.ranked.map((c) => c.chunkId),
      rankedCandidates: retrieval.ranked.slice(0, 20).map((c) => ({
        chunkId: c.chunkId,
        documentId: c.documentId,
        documentNumber: c.documentNumber,
        accessLevel: c.accessLevel,
        content: c.content,
        pageStart: c.pageStart,
      })),
      model: settings.generation.chatModel,
      embeddingModelId: model.id,
      evidenceScore: retrieval.evidenceScore,
      promptVersion: PROMPT_VERSION,
      questionFlags,
    };

    const insufficient =
      retrieval.ranked.length === 0 ||
      (!retrieval.stats.rerankSkipped && !retrieval.stats.rerankFailed && (retrieval.evidenceScore ?? 0) < settings.grounding.minEvidenceScore);

    if (input.retrievalOnly) {
      const context = buildContext(retrieval.ranked, {
        topK: settings.retrieval.finalTopK,
        maxTokens: settings.retrieval.maxContextTokens,
        maxChunksPerDocument: settings.retrieval.maxChunksPerDocument,
      });
      return {
        ...base_result,
        content: '',
        answerType: insufficient ? 'insufficient_evidence' : 'answered',
        sources: insufficient ? [] : context.sources.map(toSourceDto),
        contextSources: insufficient ? [] : context.sources,
        citations: [],
        grounding: null,
        timings: sw.toJSON(),
        usage: { tokensIn: chat.tokensIn, tokensOut: chat.tokensOut, costUsd: chat.costUsd },
      };
    }

    if (insufficient) {
      yield { type: 'sources', sources: [] };
      yield { type: 'token', text: NO_EVIDENCE_MESSAGE };
      return {
        ...base_result,
        content: NO_EVIDENCE_MESSAGE,
        answerType: 'insufficient_evidence',
        sources: [],
        contextSources: [],
        citations: [],
        grounding: null,
        timings: sw.toJSON(),
        usage: { tokensIn: chat.tokensIn, tokensOut: chat.tokensOut, costUsd: chat.costUsd },
      };
    }

    // 3. Contexto e geração
    const context = buildContext(retrieval.ranked, {
      topK: settings.retrieval.finalTopK,
      maxTokens: settings.retrieval.maxContextTokens,
      maxChunksPerDocument: settings.retrieval.maxChunksPerDocument,
    });
    const sources = context.sources.map(toSourceDto);
    yield { type: 'sources', sources };
    yield { type: 'status', stage: 'generating' };

    const genHistory = history.slice(-4);
    const cacheMode = input.settingsOverride ? 'bypass' : (input.answerCacheMode ?? 'default');
    const cache = cacheMode === 'bypass' ? undefined : this.deps.answerCache;
    const cacheKey = cache
      ? answerCacheKey({
          model: settings.generation.chatModel,
          temperature: settings.generation.temperature,
          maxTokens: settings.generation.maxOutputTokens,
          system: SYSTEM_PROMPT,
          user: buildUserPrompt({ question: normalizeQuestionForCache(input.question), contextText: context.text, history: genHistory }),
        })
      : null;
    let content = '';
    const tGen = performance.now();
    let firstToken: number | null = null;
    const cached =
      cache && cacheKey && cacheMode === 'default' ? await cache.get(cacheKey).catch((err) => this.cacheError(err, 'get')) : null;
    if (cached) {
      firstToken = performance.now();
      content = cached;
      yield { type: 'token', text: cached };
    } else {
      for await (const chunk of chat.stream({
        model: settings.generation.chatModel,
        operation: 'chat',
        temperature: settings.generation.temperature,
        maxTokens: settings.generation.maxOutputTokens,
        signal: input.signal,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt({ question: input.question, contextText: context.text, history: genHistory }) },
        ],
      })) {
        if (chunk.type === 'delta') {
          firstToken ??= performance.now();
          content += chunk.text;
          yield { type: 'token', text: chunk.text };
        }
      }
    }
    sw.record('generation', performance.now() - tGen);
    if (firstToken !== null) sw.record('timeToFirstToken', firstToken - tGen);
    if (cache) sw.record('answerCacheHit', cached ? 1 : 0);
    content = content.trim();

    // 4. Verificação de citações (sempre) e relatório de grounding (configurável)
    const answerType = classifyAnswer(content, context.sources);
    if (cache && cacheKey && content && answerType !== 'error') {
      await cache.set(cacheKey, content).catch((err) => this.cacheError(err, 'set'));
    }
    yield { type: 'status', stage: 'verifying' };
    const g = await sw.measure('grounding', () =>
      verifyGrounding({
        answer: content,
        sources: context.sources,
        minSupportScore: settings.grounding.minSupportScore,
        llmVerifier:
          settings.grounding.enabled && settings.grounding.useLlmVerifier
            ? { provider: chat, model: settings.rewrite.model, signal: input.signal }
            : undefined,
      }),
    );
    const grounding: GroundingReportDto | null = settings.grounding.enabled ? g.report : null;
    const claimFor = (idx: number) => g.claims.find((c) => idx >= c.start && idx < c.end)?.text ?? '';
    const citations = toCitationRecords(g.checks, claimFor, g.supportByCitation);

    return {
      ...base_result,
      content,
      answerType,
      sources,
      contextSources: context.sources,
      citations,
      grounding,
      timings: sw.toJSON(),
      usage: { tokensIn: chat.tokensIn, tokensOut: chat.tokensOut, costUsd: chat.costUsd },
    };
  }

  /** Falhas do cache não interrompem a resposta: seguem como ausência de cache. */
  private cacheError(err: unknown, op: 'get' | 'set'): null {
    this.deps.logger.warn({ err: err instanceof Error ? err.message : err, op }, 'answer cache unavailable');
    return null;
  }
}
