import { createProcessingJob, setJobQueueId } from '@rag/database';
import { QUEUES, refreshIndexedAct, syncCatalogSite, type CatalogRefreshRequest, type IngestionJobData, type Runtime } from '@rag/rag';
import { Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

export const CATALOG_QUEUES = {
  sync: 'catalog-sync',
  refresh: 'catalog-refresh',
} as const;

const SYNC_EVERY_MS = 15 * 60 * 1000;

function jobSuffix(etag: string | null): string {
  return (etag ?? 'file').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'file';
}

export function createCatalogQueues(connection: Redis, prefix: string) {
  const opts = { connection, prefix };
  const sync = new Queue(CATALOG_QUEUES.sync, opts);
  const refresh = new Queue<CatalogRefreshRequest>(CATALOG_QUEUES.refresh, opts);
  const ingestion = new Queue<IngestionJobData>(QUEUES.ingestion, opts);
  return { sync, refresh, ingestion };
}

export async function scheduleCatalogSync(sync: Queue): Promise<void> {
  await sync.upsertJobScheduler('catalog-sync', { every: SYNC_EVERY_MS }, { name: 'sync' });
}

export function enqueueCatalogRefresh(refresh: Queue<CatalogRefreshRequest>) {
  return async (request: CatalogRefreshRequest) => {
    const jobId =
      request.reason === 'align'
        ? `align-${request.source}-${request.externalId}`
        : `refresh-${request.source}-${request.externalId}-${jobSuffix(request.etag)}`;
    try {
      await refresh.add('refresh', request, {
        jobId,
        attempts: 2,
        backoff: { type: 'fixed', delay: 30_000 },
        removeOnComplete: 200,
        removeOnFail: 50,
      });
    } catch (err) {
      if (err instanceof Error && /already exists|job/i.test(err.message)) return;
      throw err;
    }
  };
}

export function processCatalogSync(runtime: Runtime, refresh: Queue<CatalogRefreshRequest>) {
  return (job: Job, _token?: string, signal?: AbortSignal) =>
    syncCatalogSite({
      db: runtime.db,
      signal,
      enqueueRefresh: enqueueCatalogRefresh(refresh),
    }).then((stats) => {
      runtime.logger.info({ jobId: job.id, ...stats }, 'catalog sync finished');
      return stats;
    });
}

export function processCatalogRefresh(runtime: Runtime, ingestion: Queue<IngestionJobData>) {
  return async (job: Job<CatalogRefreshRequest>) => {
    const result = await refreshIndexedAct(runtime, job.data.source, job.data.externalId);
    if (!result?.versionId) return result;
    const jobId = await createProcessingJob(runtime.db, result.versionId, 'ingest');
    const data: IngestionJobData = { jobId, versionId: result.versionId };
    await ingestion.add(QUEUES.ingestion, data, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    });
    await setJobQueueId(runtime.db, jobId, jobId);
    runtime.logger.info({ externalId: job.data.externalId, versionId: result.versionId }, 'catalog act queued for reindex');
    return result;
  };
}
