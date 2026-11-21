import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const accessLevel = z.enum(['publico', 'interno', 'restrito', 'sigiloso']);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    REDIS_URL: z.string().url(),
    QUEUE_PREFIX: z.string().regex(/^[a-z0-9:_-]+$/).default('rag'),

    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_BASE_URL: z.string().url().default('http://127.0.0.1:4000'),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    ADMIN_API_TOKEN: z.string().min(16, 'ADMIN_API_TOKEN deve ter ao menos 16 caracteres'),
    DEFAULT_ACCESS_CLEARANCE: accessLevel.default('interno'),
    TRUST_PROXY: bool.default(false),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_ROOT: z.string().default('./storage'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool.default(true),

    UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(50 * 1024 * 1024),
    UPLOAD_MAX_FILES: z.coerce.number().int().min(1).max(100).default(20),

    LLM_PROVIDER: z.enum(['openai', 'ollama']).default('ollama'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
    OLLAMA_NUM_CTX: z.coerce.number().int().min(2048).max(131_072).default(8192),
    CHAT_MODEL: z.string().default('qwen2.5:7b'),
    UTILITY_MODEL: z.string().default('qwen2.5:3b'),
    JUDGE_MODEL: z.string().default('qwen2.5:7b'),
    LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),

    EMBEDDING_PROVIDER: z.enum(['openai', 'ollama']).default('ollama'),
    EMBEDDING_MODEL: z.string().default('bge-m3'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(8).max(4000).default(1024),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(2048).default(32),
    EMBEDDING_MAX_RPM: z.coerce.number().int().min(1).default(600),

    RERANK_PROVIDER: z.enum(['none', 'llm', 'http']).default('llm'),
    RERANK_MODEL: z.string().default('qwen2.5:3b'),
    RERANK_HTTP_URL: z.string().url().optional(),
    RERANK_HTTP_API_KEY: z.string().optional(),
    RERANK_HTTP_SCORE_TYPE: z.enum(['auto', 'logit', 'probability']).default('auto'),
    ANSWER_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(86_400),

    OCR_ENGINE: z.enum(['tesseract', 'none']).default('tesseract'),
    TESSERACT_PATH: z.string().default('tesseract'),
    PDFTOPPM_PATH: z.string().default('pdftoppm'),
    OCR_LANGUAGES: z.string().regex(/^[a-z_+]+$/).default('por'),
    OCR_DPI: z.coerce.number().int().min(72).max(600).default(300),
    OCR_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),

    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    PROCESSING_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(30 * 60_000),

    DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(0),
    CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
    API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
    MAX_QUESTION_CHARS: z.coerce.number().int().min(100).max(20_000).default(4000),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().default('rag-institucional'),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} é obrigatório com STORAGE_DRIVER=s3` });
      }
    }
    const needsOpenAI = env.LLM_PROVIDER === 'openai' || env.EMBEDDING_PROVIDER === 'openai';
    if (needsOpenAI && !env.OPENAI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'OPENAI_API_KEY é obrigatório para o provedor openai' });
    }
    if (env.RERANK_PROVIDER === 'http' && !env.RERANK_HTTP_URL) {
      ctx.addIssue({ code: 'custom', path: ['RERANK_HTTP_URL'], message: 'RERANK_HTTP_URL é obrigatório com RERANK_PROVIDER=http' });
    }
    if (env.NODE_ENV === 'production' && env.ADMIN_API_TOKEN.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['ADMIN_API_TOKEN'], message: 'Em produção, ADMIN_API_TOKEN deve ter ao menos 32 caracteres' });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

function findEnvFile(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Carrega e valida variáveis de ambiente. Falha imediatamente se houver configuração inválida. */
export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  if (cached && Object.keys(overrides).length === 0) return cached;
  const file = process.env.RAG_ENV_FILE ?? findEnvFile(process.cwd());
  if (file && existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // arquivo ilegível: segue apenas com variáveis do processo
    }
  }
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${details}`);
  }
  const baseDir = file ? dirname(file) : process.cwd();
  const env = { ...parsed.data, STORAGE_LOCAL_ROOT: resolve(baseDir, parsed.data.STORAGE_LOCAL_ROOT) };
  if (Object.keys(overrides).length === 0) cached = env;
  return env;
}

export function resetEnvCache(): void {
  cached = undefined;
}
