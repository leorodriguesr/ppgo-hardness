import { loadEnv } from '@rag/config';
import { createRuntime, QUEUES, type IngestionJobData, type Runtime } from '@rag/rag';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { buildApp, type App } from '../../apps/api/src/app';
import type { Queues } from '../../apps/api/src/context';

export interface TestApi {
  app: App;
  runtime: Runtime;
  queues: Queues;
  token: string;
  auth: (extra?: Record<string, string>) => Record<string, string>;
  /** Processa de forma síncrona os jobs de ingestão enfileirados (sem depender do worker). */
  drainIngestion: () => Promise<void>;
  close: () => Promise<void>;
}

/** API real (Postgres, Redis, provedores) com filas isoladas por prefixo de teste. */
export async function createTestApi(): Promise<TestApi> {
  const env = loadEnv({ QUEUE_PREFIX: 'ragtest', API_RATE_LIMIT_PER_MINUTE: '100000', LOG_LEVEL: 'warn' });
  const runtime = createRuntime(env, 'rag-api-test', { poolMax: 4 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const opts = { connection: redis, prefix: env.QUEUE_PREFIX };
  const queues: Queues = {
    ingestion: new Queue(QUEUES.ingestion, opts),
    embeddings: new Queue(QUEUES.embeddings, opts),
    evaluation: new Queue(QUEUES.evaluation, opts),
    catalogSync: new Queue('catalog-sync', opts),
  };
  const app = await buildApp({ runtime, queues, redis });
  await app.ready();
  const token = env.ADMIN_API_TOKEN;
  return {
    app,
    runtime,
    queues,
    token,
    auth: (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra }),
    drainIngestion: async () => {
      const jobs = await queues.ingestion.getJobs(['waiting', 'delayed', 'prioritized']);
      for (const job of jobs) {
        const data = job.data as IngestionJobData;
        await runtime.ingestion.run({ jobId: data.jobId, versionId: data.versionId });
        await job.remove();
      }
    },
    close: async () => {
      await Promise.all(Object.values(queues).map((q) => q.obliterate({ force: true }).catch(() => {})));
      await app.close();
      await Promise.all(Object.values(queues).map((q) => q.close()));
      await redis.quit();
      await runtime.close();
    },
  };
}

/** Corpo multipart/form-data (campos de texto antes do arquivo, como exige a API). */
export function multipart(fields: Record<string, string>, file?: { name: string; content: string | Buffer; type?: string }) {
  const boundary = `----rag${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
