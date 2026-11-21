import { AsyncLocalStorage } from 'node:async_hooks';
import { pino, type Logger, type LoggerOptions } from 'pino';

interface RequestContext {
  correlationId: string;
  actorId?: string;
}

const contextStore = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return contextStore.run(ctx, fn);
}

/** Associa o contexto ao fluxo assíncrono atual (usado em hooks de requisição do Fastify). */
export function enterContext(ctx: RequestContext): void {
  contextStore.enterWith(ctx);
}

export function getContext(): RequestContext | undefined {
  return contextStore.getStore();
}

export function getCorrelationId(): string | undefined {
  return contextStore.getStore()?.correlationId;
}

/**
 * Campos que nunca devem chegar aos logs: segredos, conteúdo de perguntas,
 * respostas e textos de documentos (podem conter dados sensíveis).
 */
export const REDACT_PATHS = [
  'password',
  'token',
  'apiKey',
  'authorization',
  'secret',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.secret',
  'req.headers.authorization',
  'req.headers["x-admin-token"]',
  'req.headers.cookie',
  'headers.authorization',
  'headers["x-admin-token"]',
  'content',
  'question',
  'answer',
  'prompt',
  'text',
  '*.content',
  '*.question',
  '*.answer',
  '*.prompt',
  '*.text',
  'messages',
  '*.messages',
];

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info', extra: LoggerOptions = {}): Logger {
  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const ctx = contextStore.getStore();
      return ctx ? { correlationId: ctx.correlationId } : {};
    },
    formatters: { level: (label) => ({ level: label }) },
    ...extra,
  });
}

export type { Logger };
