import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../context';

type Check = { ok: boolean; latencyMs: number; detail?: string };

async function timed(fn: () => Promise<string | void>, timeoutMs = 3000): Promise<Check> {
  const t0 = performance.now();
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - t0), ...(detail ? { detail } : {}) };
  } catch (err) {
    return { ok: false, latencyMs: Math.round(performance.now() - t0), detail: err instanceof Error ? err.message.slice(0, 200) : 'erro' };
  }
}

/** Verificações de prontidão. `detailed` inclui provedores externos e worker (rota autenticada). */
export async function readinessChecks(deps: AppDeps, detailed: boolean): Promise<Record<string, Check>> {
  const { runtime, redis } = deps;
  const checks: Record<string, Promise<Check>> = {
    database: timed(async () => {
      await runtime.database.sql`SELECT 1`;
    }),
    redis: timed(async () => {
      await redis.ping();
    }),
  };
  if (detailed) {
    checks.storage = timed(async () => {
      await runtime.storage.healthCheck();
    });
    checks.worker = timed(async () => {
      const beat = await redis.get(`${runtime.env.QUEUE_PREFIX}:worker:heartbeat`);
      if (!beat) throw new Error('sem heartbeat recente do worker');
      return `último heartbeat ${beat}`;
    });
    checks.llm = timed(async () => {
      if (runtime.env.LLM_PROVIDER !== 'ollama') return 'provedor externo (não verificado para evitar custo)';
      const res = await fetch(new URL('/api/version', runtime.env.OLLAMA_BASE_URL), { signal: AbortSignal.timeout(2500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `ollama ${((await res.json()) as { version?: string }).version ?? ''}`;
    });
    if (runtime.env.RERANK_PROVIDER === 'http' && runtime.env.RERANK_HTTP_URL) {
      const url = new URL(runtime.env.RERANK_HTTP_URL);
      checks.reranker = timed(async () => {
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return 'serviço externo (não verificado para evitar custo)';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: runtime.env.RERANK_MODEL, query: 'verificação', documents: ['verificação'], texts: ['verificação'] }),
          signal: AbortSignal.timeout(2500),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return runtime.env.RERANK_MODEL;
      });
    }
    checks.ocr = timed(async () => {
      if (!(await runtime.ocr.available())) throw new Error('OCR indisponível (tesseract/pdftoppm ausentes ou desativado)');
      return runtime.ocr.name;
    });
  }
  const entries = await Promise.all(Object.entries(checks).map(async ([k, p]) => [k, await p] as const));
  return Object.fromEntries(entries);
}

export const healthRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get('/health', { config: { rateLimit: false }, schema: { hide: true } }, async () => ({ status: 'ok' }));

  app.get('/health/ready', { config: { rateLimit: false }, schema: { hide: true } }, async (_req, reply) => {
    const checks = await readinessChecks(deps, false);
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.status(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok])) });
  });
};
