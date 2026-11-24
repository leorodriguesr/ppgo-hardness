import { loadEnv } from '@rag/config';
import { createRuntime, QUEUES, type AnswerCache } from '@rag/rag';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import type { Queues } from './context';

const env = loadEnv();
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
const cachePrefix = `${env.QUEUE_PREFIX}:cache:`;
const answerCache: AnswerCache | undefined =
  env.ANSWER_CACHE_TTL_SECONDS > 0
    ? {
        get: (key) => redis.get(cachePrefix + key),
        set: async (key, content) => {
          await redis.set(cachePrefix + key, content, 'EX', env.ANSWER_CACHE_TTL_SECONDS);
        },
      }
    : undefined;
const runtime = createRuntime(env, 'rag-api', { answerCache });
const { logger } = runtime;

const queueOpts = { connection: redis, prefix: env.QUEUE_PREFIX };
const queues: Queues = {
  ingestion: new Queue(QUEUES.ingestion, queueOpts),
  embeddings: new Queue(QUEUES.embeddings, queueOpts),
  evaluation: new Queue(QUEUES.evaluation, queueOpts),
  catalogSync: new Queue('catalog-sync', queueOpts),
};

const app = await buildApp({ runtime, queues, redis });

if (env.API_HOST !== '127.0.0.1' && env.API_HOST !== 'localhost' && env.API_HOST !== '::1') {
  logger.warn(
    { host: env.API_HOST },
    'API exposta fora do loopback: sem autenticação institucional, mantenha-a apenas em rede interna confiável',
  );
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, 'shutting down api');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await app.close();
    await Promise.all(Object.values(queues).map((q) => q.close()));
    await redis.quit();
    await runtime.close();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
