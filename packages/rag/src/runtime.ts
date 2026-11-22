import {
  createChatProvider,
  createEmbeddingProvider,
  createJudgeProvider,
  HttpReranker,
  LlmReranker,
  NoopReranker,
  type ChatProvider,
  type EmbeddingProvider,
  type Reranker,
  type UsageEvent,
} from '@rag/ai';
import type { Env } from '@rag/config';
import {
  createDatabase,
  getRagSettings,
  insertUsage,
  tokensUsedSince,
  type Database,
  type DatabaseHandle,
  type EmbeddingModelRow,
} from '@rag/database';
import { AppError, defaultRagSettings, type RagSettings } from '@rag/shared';
import { createLogger, getCorrelationId, type Logger } from '@rag/shared/server';
import { createStorage, type StorageAdapter } from '@rag/storage';
import { RagEngine, type AnswerCache } from './engine';
import { defaultExtractors, type ExtractorRegistry } from './ingestion/extractors/index';
import { DisabledOcrEngine, TesseractOcrEngine, type OcrEngine } from './ingestion/ocr';
import { IngestionPipeline } from './ingestion/pipeline';

export const QUEUES = {
  ingestion: 'ingestion',
  embeddings: 'embeddings',
  evaluation: 'evaluation',
} as const;

export interface IngestionJobData {
  jobId: string;
  versionId: string;
  correlationId?: string;
}

export interface EmbeddingJobData {
  kind: 'model_migration' | 'version_reembed';
  modelId?: string;
  versionId?: string;
  correlationId?: string;
}

export interface EvaluationJobData {
  datasetId: string;
  experimentName: string;
  overrides?: Record<string, unknown>;
  runId?: string;
}

/** Cache curto das configurações para não consultar o banco a cada requisição. */
export class SettingsProvider {
  private cached: { value: RagSettings; version: number; at: number } | null = null;

  constructor(
    private readonly db: Database,
    private readonly defaults: RagSettings,
    private readonly ttlMs = 5_000,
  ) {}

  async get(): Promise<RagSettings> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.value;
    const s = await getRagSettings(this.db, this.defaults);
    this.cached = { value: s.settings, version: s.version, at: Date.now() };
    return s.settings;
  }

  invalidate(): void {
    this.cached = null;
  }

  getDefaults(): RagSettings {
    return this.defaults;
  }
}

export interface Runtime {
  env: Env;
  logger: Logger;
  database: DatabaseHandle;
  db: Database;
  storage: StorageAdapter;
  chat: ChatProvider;
  /** Provedor do juiz das avaliações, quando configurado à parte (`JUDGE_*`). */
  judgeChat?: ChatProvider;
  settings: SettingsProvider;
  extractors: ExtractorRegistry;
  ocr: OcrEngine;
  embeddingProviderFor: (model: Pick<EmbeddingModelRow, 'id' | 'provider' | 'model' | 'dimensions'>) => EmbeddingProvider;
  rerankerFor: (settings: RagSettings, chat: ChatProvider) => Reranker;
  engine: RagEngine;
  ingestion: IngestionPipeline;
  assertBudget: () => Promise<void>;
  close: () => Promise<void>;
}

export function createRuntime(env: Env, name: string, opts: { poolMax?: number; answerCache?: AnswerCache } = {}): Runtime {
  const logger = createLogger(name, env.LOG_LEVEL);
  const database = createDatabase(env.DATABASE_URL, { max: opts.poolMax ?? env.DATABASE_POOL_MAX, applicationName: name });
  const { db } = database;

  // Registro assíncrono de consumo; falhas de registro não interrompem a operação principal
  const onUsage = (e: UsageEvent) => {
    insertUsage(db, { ...e, correlationId: getCorrelationId() ?? null }).catch((err) =>
      logger.warn({ err: err instanceof Error ? err.message : err }, 'failed to record llm usage'),
    );
  };

  const chat = createChatProvider(env, onUsage);
  const judgeChat = createJudgeProvider(env, onUsage);
  const embeddingCache = new Map<string, EmbeddingProvider>();
  const embeddingProviderFor: Runtime['embeddingProviderFor'] = (model) => {
    const key = `${model.provider}:${model.model}:${model.dimensions}`;
    let p = embeddingCache.get(key);
    if (!p) {
      p = createEmbeddingProvider(env, model, onUsage);
      embeddingCache.set(key, p);
    }
    return p;
  };
  const rerankerFor: Runtime['rerankerFor'] = (settings, chatProvider) => {
    if (!settings.rerank.enabled || env.RERANK_PROVIDER === 'none') return new NoopReranker();
    if (env.RERANK_PROVIDER === 'http') {
      return new HttpReranker(env.RERANK_HTTP_URL!, env.RERANK_MODEL, env.RERANK_HTTP_API_KEY, undefined, env.RERANK_HTTP_SCORE_TYPE);
    }
    return new LlmReranker(chatProvider, settings.rerank.model);
  };

  const defaults = defaultRagSettings({ chatModel: env.CHAT_MODEL, utilityModel: env.UTILITY_MODEL, maxUploadBytes: env.UPLOAD_MAX_BYTES });
  const settings = new SettingsProvider(db, defaults);
  const storage = createStorage(env);
  const extractors = defaultExtractors();
  const ocr: OcrEngine =
    env.OCR_ENGINE === 'tesseract'
      ? new TesseractOcrEngine({
          tesseractPath: env.TESSERACT_PATH,
          pdftoppmPath: env.PDFTOPPM_PATH,
          languages: env.OCR_LANGUAGES,
          dpi: env.OCR_DPI,
          timeoutMs: env.OCR_TIMEOUT_MS,
        })
      : new DisabledOcrEngine();

  const engine = new RagEngine({
    db,
    chat,
    embeddingProviderFor,
    rerankerFor,
    getSettings: () => settings.get(),
    logger,
    answerCache: opts.answerCache,
  });
  const ingestion = new IngestionPipeline({
    db,
    sql: database.sql,
    storage,
    extractors,
    ocr,
    embeddingProviderFor,
    getSettings: () => settings.get(),
    embeddingBatchSize: env.EMBEDDING_BATCH_SIZE,
    logger,
  });

  const assertBudget = async () => {
    if (env.DAILY_TOKEN_BUDGET <= 0) return;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const used = await tokensUsedSince(db, since);
    if (used >= env.DAILY_TOKEN_BUDGET) {
      throw new AppError('BUDGET_EXCEEDED', 'O limite diário de consumo de IA foi atingido. Tente novamente amanhã ou contate o administrador.');
    }
  };

  return {
    env,
    logger,
    database,
    db,
    storage,
    chat,
    judgeChat,
    settings,
    extractors,
    ocr,
    embeddingProviderFor,
    rerankerFor,
    engine,
    ingestion,
    assertBudget,
    close: () => database.close(),
  };
}
