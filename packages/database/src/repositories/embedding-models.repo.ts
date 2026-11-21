import { AppError, type EmbeddingModelDto, type EmbeddingModelStatus } from '@rag/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { embeddingModels } from '../schema';
import { iso } from './mappers';

export type EmbeddingModelRow = typeof embeddingModels.$inferSelect;

export async function getActiveEmbeddingModel(db: Database): Promise<EmbeddingModelRow | null> {
  const [row] = await db.select().from(embeddingModels).where(eq(embeddingModels.status, 'active')).limit(1);
  return row ?? null;
}

export async function getEmbeddingModel(db: Database, id: string): Promise<EmbeddingModelRow | null> {
  const [row] = await db.select().from(embeddingModels).where(eq(embeddingModels.id, id)).limit(1);
  return row ?? null;
}

export async function findOrCreateEmbeddingModel(
  db: Database,
  input: { provider: string; model: string; dimensions: number },
): Promise<EmbeddingModelRow> {
  await db.insert(embeddingModels).values(input).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(embeddingModels)
    .where(
      and(
        eq(embeddingModels.provider, input.provider),
        eq(embeddingModels.model, input.model),
        eq(embeddingModels.dimensions, input.dimensions),
      ),
    )
    .limit(1);
  return row!;
}

export async function setEmbeddingModelStatus(db: Database, id: string, status: EmbeddingModelStatus, error?: string): Promise<void> {
  await db.update(embeddingModels).set({ status, error: error ?? null }).where(eq(embeddingModels.id, id));
}

/** Ativa um modelo e aposenta o anterior de forma atômica. */
export async function activateEmbeddingModel(db: Database, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(embeddingModels)
      .set({ status: 'retired', retiredAt: new Date() })
      .where(eq(embeddingModels.status, 'active'));
    const updated = await tx
      .update(embeddingModels)
      .set({ status: 'active', activatedAt: new Date(), retiredAt: null })
      .where(eq(embeddingModels.id, id))
      .returning();
    if (updated.length === 0) throw new AppError('NOT_FOUND', 'Modelo de embedding não encontrado');
  });
}

/** Cobertura de embeddings: quantos chunks de versões vigentes já têm vetor para cada modelo. */
export async function listEmbeddingModels(db: Database): Promise<EmbeddingModelDto[]> {
  const rows = await db.execute<{
    id: string;
    provider: string;
    model: string;
    dimensions: number;
    status: EmbeddingModelStatus;
    created_at: Date;
    activated_at: Date | null;
    embedded: string;
    total: string;
  }>(sql`
    WITH current_chunks AS (
      SELECT c.id FROM document_chunks c
      JOIN document_versions v ON v.id = c.version_id
      JOIN documents d ON d.id = c.document_id
      WHERE v.status = 'completed' AND d.deleted_at IS NULL
    )
    SELECT m.id, m.provider, m.model, m.dimensions, m.status, m.created_at, m.activated_at,
      (SELECT count(*) FROM chunk_embeddings e JOIN current_chunks cc ON cc.id = e.chunk_id WHERE e.embedding_model_id = m.id) AS embedded,
      (SELECT count(*) FROM current_chunks) AS total
    FROM embedding_models m
    ORDER BY m.created_at DESC`);
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    dimensions: r.dimensions,
    status: r.status,
    embeddedChunks: Number(r.embedded),
    totalChunks: Number(r.total),
    createdAt: new Date(r.created_at).toISOString(),
    activatedAt: iso(r.activated_at ? new Date(r.activated_at) : null),
  }));
}
