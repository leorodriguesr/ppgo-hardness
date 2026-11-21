import { AppError } from '@rag/shared';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injeção para testes. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_RETRY: RetryOptions = { retries: 4, baseDelayMs: 500, maxDelayMs: 20_000, timeoutMs: 180_000 };

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Provedor respondeu HTTP ${status}`);
    this.name = 'ProviderHttpError';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Backoff exponencial com jitter completo. */
export function backoffDelay(attempt: number, base: number, max: number, random = Math.random): number {
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
  );
}

/**
 * fetch com timeout, retry com backoff exponencial para erros transitórios
 * (rede, 429, 5xx) e respeito ao cabeçalho Retry-After. Não repete após cancelamento.
 */
export async function fetchWithRetry(url: string, init: RequestInit, opts: Partial<RetryOptions> = {}): Promise<Response> {
  const o = { ...DEFAULT_RETRY, ...opts };
  const sleep = o.sleep ?? defaultSleep;
  const doFetch = o.fetchImpl ?? fetch;
  let lastError: unknown;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    if (o.signal?.aborted) throw o.signal.reason ?? new DOMException('Cancelado', 'AbortError');
    const timeout = AbortSignal.timeout(o.timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    try {
      const res = await doFetch(url, { ...init, signal });
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      lastError = new ProviderHttpError(res.status, body.slice(0, 500));
      if (!isRetryableStatus(res.status) || attempt === o.retries) throw lastError;
      const wait = parseRetryAfter(res.headers.get('retry-after')) ?? backoffDelay(attempt, o.baseDelayMs, o.maxDelayMs);
      await sleep(Math.min(wait, o.maxDelayMs), o.signal);
    } catch (err) {
      if (o.signal?.aborted) throw err;
      if (err instanceof ProviderHttpError) {
        if (!isRetryableStatus(err.status) || attempt === o.retries) throw err;
        continue;
      }
      lastError = err;
      if (attempt === o.retries) break;
      await sleep(backoffDelay(attempt, o.baseDelayMs, o.maxDelayMs), o.signal);
    }
  }
  throw new AppError('PROVIDER_ERROR', 'Falha ao comunicar com o provedor de IA', undefined, { cause: lastError });
}
