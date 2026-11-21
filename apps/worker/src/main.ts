import { loadEnv } from '@rag/config';
import {
  chunksMissingEmbedding,
  ensureVectorIndex,
  finishJob,
  getActiveEmbeddingModel,
  getEmbeddingModel,
  getVersionChunksForEmbedding,
  markJobRunning,
  setEmbeddingModelStatus,
} from '@rag/database';
import {
  createRuntime,
  embedChunks,
  PermanentIngestionError,
  QUEUES,
  type EmbeddingJobData,
  type EvaluationJobData,
  type IngestionJobData,
} from '@rag/rag';
import { runWithContext } from '@rag/shared/server';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { runEvaluationJob } from './evaluation-job';

const env = loadEnv();
const runtime = createRuntime(env, 'rag-worker');
const { logger, db } = runtime;
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
const prefix = env.QUEUE_PREFIX;

const HEARTBEAT_KEY = `${prefix}:worker:heartbeat`;
const heartbeat = setInterval(() => {
  connection.set(HEARTBEAT_KEY, new Date().toISOString(), 'EX', 30).catch(() => {});
}, 10_000);
heartbeat.unref();

async function processIngestion(job: Job<IngestionJobData>, _token?: string, signal?: AbortSignal) {
  const { jobId, versionId } = job.data;
  const correlationId = job.data.correlationId ?? randomUUID();
  return runWithContext({ correlationId }, async () => {
    await markJobRunning(db, jobId, job.attemptsMade + 1);
    const timeout = AbortSignal.timeout(env.PROCESSING_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const result = await runtime.ingestion.run({ jobId, versionId, signal: combined });
      await finishJob(db, jobId, 'completed', { metrics: { ...result } });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof PermanentIngestionError;
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (permanent || lastAttempt || combined.aborted) {
        await finishJob(db, jobId, combined.aborted ? 'cancelled' : 'failed', { error: message });
      }
      if (permanent) throw new UnrecoverableError(message);
      throw err;
    }
  });
}

async function processEmbeddings(job: Job<EmbeddingJobData>, _token?: string, signal?: AbortSignal) {
  const correlationId = job.data.correlationId ?? randomUUID();
  return runWithContext({ correlationId }, async () => {
    if (job.data.kind === 'version_reembed') {
      const model = await getActiveEmbeddingModel(db);
      if (!model || !job.data.versionId) throw new UnrecoverableError('Modelo ativo ou versão ausente');
      const chunks = await getVersionChunksForEmbedding(db, job.data.versionId);
      return embedChunks({
        db,
        provider: runtime.embeddingProviderFor(model),
        modelId: model.id,
        chunks,
        batchSize: env.EMBEDDING_BATCH_SIZE,
        signal,
      });
    }

    // Migração entre modelos: gera embeddings do novo modelo sem afetar o índice ativo.
    const model = job.data.modelId ? await getEmbeddingModel(db, job.data.modelId) : null;
    if (!model) throw new UnrecoverableError('Modelo de embedding não encontrado');
    await setEmbeddingModelStatus(db, model.id, 'indexing');
    try {
      await ensureVectorIndex(runtime.database.sql, model.id, model.dimensions);
      const provider = runtime.embeddingProviderFor(model);
      let total = 0;
      for (;;) {
        if (signal?.aborted) throw signal.reason;
        const batch = await chunksMissingEmbedding(db, model.id, 256);
        if (batch.length === 0) break;
        const r = await embedChunks({ db, provider, modelId: model.id, chunks: batch, batchSize: env.EMBEDDING_BATCH_SIZE, signal });
        total += r.embedded;
        await job.updateProgress({ embedded: total });
      }
      await setEmbeddingModelStatus(db, model.id, 'ready');
      logger.info({ modelId: model.id, total }, 'embedding migration completed');
      return { embedded: total };
    } catch (err) {
      await setEmbeddingModelStatus(db, model.id, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
}

const workers = [
  new Worker<IngestionJobData>(QUEUES.ingestion, processIngestion, {
    connection,
    prefix,
    concurrency: env.WORKER_CONCURRENCY,
    lockDuration: 120_000,
    maxStalledCount: 2,
  }),
  new Worker<EmbeddingJobData>(QUEUES.embeddings, processEmbeddings, { connection, prefix, concurrency: 1, lockDuration: 300_000 }),
  new Worker<EvaluationJobData>(QUEUES.evaluation, (job, _t, signal) => runEvaluationJob(runtime, job, signal), {
    connection,
    prefix,
    concurrency: 1,
    lockDuration: 600_000,
  }),
];

for (const w of workers) {
  w.on('failed', (job, err) => logger.warn({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
  w.on('completed', (job) => logger.info({ queue: w.name, jobId: job.id }, 'job completed'));
  w.on('error', (err) => logger.error({ queue: w.name, err: err.message }, 'worker error'));
}

const ocrAvailable = await runtime.ocr.available();
logger.info({ concurrency: env.WORKER_CONCURRENCY, ocr: runtime.ocr.name, ocrAvailable }, 'worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  clearInterval(heartbeat);
  await Promise.allSettled(workers.map((w) => w.close()));
  await connection.quit().catch(() => {});
  await runtime.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
