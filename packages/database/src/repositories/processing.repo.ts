import type { ProcessingStatus } from '@rag/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  chunkEmbeddings,
  documentChunks,
  documentPages,
  documentProcessingEvents,
  documentProcessingJobs,
  documentVersions,
  embeddingCache,
} from '../schema';

export type JobType = 'ingest' | 'reprocess' | 'reindex_embeddings';

export async function createProcessingJob(db: Database, versionId: string, jobType: JobType): Promise<string> {
  const [row] = await db
    .insert(documentProcessingJobs)
    .values({ versionId, jobType })
    .returning({ id: documentProcessingJobs.id });
  await db.insert(documentProcessingEvents).values({
    jobId: row!.id,
    versionId,
    stage: 'queued',
    message: jobType === 'ingest' ? 'Documento enfileirado para processamento' : 'Reprocessamento solicitado',
  });
  return row!.id;
}

export async function setJobQueueId(db: Database, jobId: string, queueJobId: string): Promise<void> {
  await db.update(documentProcessingJobs).set({ queueJobId }).where(eq(documentProcessingJobs.id, jobId));
}

export async function getProcessingJob(db: Database, jobId: string) {
  const [row] = await db.select().from(documentProcessingJobs).where(eq(documentProcessingJobs.id, jobId)).limit(1);
  return row ?? null;
}

export async function markJobRunning(db: Database, jobId: string, attempt: number): Promise<void> {
  await db
    .update(documentProcessingJobs)
    .set({ status: 'running', startedAt: new Date(), attempts: attempt, error: null })
    .where(eq(documentProcessingJobs.id, jobId));
}

export async function finishJob(
  db: Database,
  jobId: string,
  status: 'completed' | 'failed' | 'cancelled',
  details: { error?: string; metrics?: Record<string, unknown> } = {},
): Promise<void> {
  await db
    .update(documentProcessingJobs)
    .set({
      status,
      finishedAt: new Date(),
      error: details.error ?? null,
      metrics: details.metrics ?? {},
      progress: status === 'completed' ? 100 : sql`${documentProcessingJobs.progress}`,
    })
    .where(eq(documentProcessingJobs.id, jobId));
}

export async function updateStage(
  db: Database,
  ids: { jobId: string; versionId: string },
  stage: ProcessingStatus,
  progress: number,
  detail?: string,
): Promise<void> {
  const p = Math.max(0, Math.min(100, Math.round(progress)));
  await Promise.all([
    db
      .update(documentVersions)
      .set({ status: stage, progress: p, stageDetail: detail ?? null })
      .where(eq(documentVersions.id, ids.versionId)),
    db.update(documentProcessingJobs).set({ stage, progress: p }).where(eq(documentProcessingJobs.id, ids.jobId)),
  ]);
}

export async function addProcessingEvent(
  db: Database,
  ids: { jobId: string; versionId: string },
  stage: string,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(documentProcessingEvents).values({ ...ids, stage, message, level, data });
}

export interface PageInput {
  pageNumber: number;
  text: string;
  ocr: boolean;
  ocrConfidence: number | null;
}

export async function replacePages(db: Database, versionId: string, pages: PageInput[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(documentPages).where(eq(documentPages.versionId, versionId));
    for (let i = 0; i < pages.length; i += 200) {
      const batch = pages.slice(i, i + 200).map((p) => ({ ...p, versionId, charCount: p.text.length }));
      if (batch.length) await tx.insert(documentPages).values(batch);
    }
  });
}

export interface ChunkInput {
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  sectionTitle: string | null;
  headingPath: string[];
  structuralRef: string | null;
  contextHeader: string;
  content: string;
  contentNormalized: string;
  tokenCount: number;
  contentHash: string;
  embeddingInputHash: string;
  chunkingStrategy: string;
  flags: string[];
  metadata: Record<string, unknown>;
}

/** Substitui atomicamente os chunks de uma versão (embeddings antigos são removidos em cascata). */
export async function replaceChunks(
  db: Database,
  versionId: string,
  documentId: string,
  chunks: ChunkInput[],
): Promise<{ id: string; embeddingInputHash: string }[]> {
  return db.transaction(async (tx) => {
    await tx.delete(documentChunks).where(eq(documentChunks.versionId, versionId));
    const out: { id: string; embeddingInputHash: string }[] = [];
    for (let i = 0; i < chunks.length; i += 200) {
      const batch = chunks.slice(i, i + 200).map((c) => ({ ...c, versionId, documentId, charCount: c.content.length }));
      if (batch.length === 0) continue;
      const rows = await tx.insert(documentChunks).values(batch).returning({
        id: documentChunks.id,
        embeddingInputHash: documentChunks.embeddingInputHash,
      });
      out.push(...rows);
    }
    await tx.update(documentVersions).set({ chunkCount: chunks.length }).where(eq(documentVersions.id, versionId));
    return out;
  });
}

export interface EmbeddableChunk {
  id: string;
  embeddingInputHash: string;
  content: string;
  contextHeader: string;
  headingPath: string[];
  structuralRef: string | null;
  metadata: Record<string, unknown>;
}

export async function getVersionChunksForEmbedding(db: Database, versionId: string): Promise<EmbeddableChunk[]> {
  return db
    .select({
      id: documentChunks.id,
      embeddingInputHash: documentChunks.embeddingInputHash,
      content: documentChunks.content,
      contextHeader: documentChunks.contextHeader,
      headingPath: documentChunks.headingPath,
      structuralRef: documentChunks.structuralRef,
      metadata: documentChunks.metadata,
    })
    .from(documentChunks)
    .where(eq(documentChunks.versionId, versionId))
    .orderBy(asc(documentChunks.chunkIndex));
}

export async function getCachedEmbeddings(db: Database, modelId: string, hashes: string[]): Promise<Map<string, number[]>> {
  if (hashes.length === 0) return new Map();
  const rows = await db
    .select({ hash: embeddingCache.contentHash, embedding: embeddingCache.embedding })
    .from(embeddingCache)
    .where(and(eq(embeddingCache.embeddingModelId, modelId), inArray(embeddingCache.contentHash, hashes)));
  return new Map(rows.map((r) => [r.hash, r.embedding]));
}

export async function putCachedEmbeddings(
  db: Database,
  modelId: string,
  entries: { contentHash: string; embedding: number[] }[],
): Promise<void> {
  if (entries.length === 0) return;
  await db
    .insert(embeddingCache)
    .values(entries.map((e) => ({ embeddingModelId: modelId, ...e })))
    .onConflictDoNothing();
}

export async function upsertChunkEmbeddings(
  db: Database,
  modelId: string,
  entries: { chunkId: string; embedding: number[] }[],
): Promise<void> {
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200).map((e) => ({ embeddingModelId: modelId, ...e }));
    if (batch.length === 0) continue;
    await db
      .insert(chunkEmbeddings)
      .values(batch)
      .onConflictDoUpdate({
        target: [chunkEmbeddings.chunkId, chunkEmbeddings.embeddingModelId],
        set: { embedding: sql`excluded.embedding`, createdAt: new Date() },
      });
  }
}

export async function completeVersion(
  db: Database,
  versionId: string,
  result: {
    pageCount: number;
    extractionMethod: 'text' | 'ocr' | 'mixed';
    ocrPages: number;
    qualityFlags: string[];
    processingConfig: Record<string, unknown>;
    processingMs: number;
  },
): Promise<void> {
  await db
    .update(documentVersions)
    .set({
      ...result,
      status: 'completed',
      progress: 100,
      stageDetail: null,
      errorMessage: null,
      processedAt: new Date(),
    })
    .where(eq(documentVersions.id, versionId));
}

export async function failVersion(db: Database, versionId: string, message: string): Promise<void> {
  await db
    .update(documentVersions)
    .set({ status: 'error', errorMessage: message.slice(0, 2000), stageDetail: null })
    .where(eq(documentVersions.id, versionId));
}

export async function resetVersionForReprocess(db: Database, versionId: string): Promise<void> {
  await db
    .update(documentVersions)
    .set({ status: 'pending', progress: 0, errorMessage: null, stageDetail: null })
    .where(eq(documentVersions.id, versionId));
}

export async function setEmbeddingInputHash(db: Database, chunkId: string, hash: string): Promise<void> {
  await db.update(documentChunks).set({ embeddingInputHash: hash }).where(eq(documentChunks.id, chunkId));
}

/** Chunks de versões concluídas que ainda não têm embedding para o modelo informado. */
export async function chunksMissingEmbedding(db: Database, modelId: string, limit: number): Promise<EmbeddableChunk[]> {
  const rows = await db.execute<{
    id: string;
    embedding_input_hash: string;
    content: string;
    context_header: string;
    heading_path: string[];
    structural_ref: string | null;
    metadata: Record<string, unknown>;
  }>(sql`
    SELECT c.id, c.embedding_input_hash, c.content, c.context_header, c.heading_path, c.structural_ref, c.metadata
    FROM document_chunks c
    JOIN document_versions v ON v.id = c.version_id
    JOIN documents d ON d.id = c.document_id
    WHERE v.status = 'completed' AND d.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.embedding_model_id = ${modelId}
      )
    ORDER BY c.id
    LIMIT ${limit}`);
  return rows.map((r) => ({
    id: r.id,
    embeddingInputHash: r.embedding_input_hash,
    content: r.content,
    contextHeader: r.context_header,
    headingPath: r.heading_path,
    structuralRef: r.structural_ref,
    metadata: r.metadata,
  }));
}
