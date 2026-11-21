import {
  AppError,
  type AccessLevel,
  type ChunkDto,
  type DocumentDetailDto,
  type DocumentDto,
  type DocumentListQuery,
  type DocumentMetadataInput,
  type DocumentUpdateInput,
  type FileFormat,
  type PageDto,
  type Paginated,
  type ProcessingEventDto,
} from '@rag/shared';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { sqlArray } from '../sql-helpers';
import {
  documentCategories,
  documentChunks,
  documentPages,
  documentProcessingEvents,
  documentVersions,
  documents,
} from '../schema';
import { toDocumentDto, toVersionDto } from './mappers';

export interface StoredFileInput {
  fileName: string;
  storageKey: string;
  format: FileFormat;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export function buildContextHeader(doc: { title: string; documentNumber: string | null; documentType: string }): string {
  return [doc.documentNumber, doc.title].filter(Boolean).join(' — ');
}

export async function findVersionBySha(db: Database, sha256: string): Promise<{ documentId: string; versionId: string } | null> {
  const [row] = await db
    .select({ documentId: documentVersions.documentId, versionId: documentVersions.id })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(and(eq(documentVersions.sha256, sha256), isNull(documents.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createDocumentWithVersion(
  db: Database,
  input: { metadata: DocumentMetadataInput; file: StoredFileInput; actorId: string },
): Promise<{ documentId: string; versionId: string }> {
  return db.transaction(async (tx) => {
    const m = input.metadata;
    const [doc] = await tx
      .insert(documents)
      .values({
        title: m.title,
        documentType: m.documentType,
        categoryId: m.categoryId ?? null,
        issuingBody: m.issuingBody ?? null,
        documentNumber: m.documentNumber ?? null,
        publicationDate: m.publicationDate ?? null,
        effectiveDate: m.effectiveDate ?? null,
        validityStatus: m.validityStatus,
        accessLevel: m.accessLevel,
        description: m.description ?? null,
        createdBy: input.actorId,
      })
      .returning({ id: documents.id });
    const [version] = await tx
      .insert(documentVersions)
      .values({ ...input.file, documentId: doc!.id, versionNumber: 1, isCurrent: true, createdBy: input.actorId })
      .returning({ id: documentVersions.id });
    await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, doc!.id));
    return { documentId: doc!.id, versionId: version!.id };
  });
}

/** Cria nova versão (substituição). Ela só passa a ser a vigente quando o processamento concluir. */
export async function addDocumentVersion(
  db: Database,
  documentId: string,
  file: StoredFileInput,
  actorId: string,
): Promise<{ versionId: string; versionNumber: number }> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
      .for('update');
    if (!doc) throw new AppError('NOT_FOUND', 'Documento não encontrado');
    const [{ max } = { max: 0 }] = await tx
      .select({ max: sql<number>`coalesce(max(${documentVersions.versionNumber}), 0)::int` })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    const versionNumber = Number(max) + 1;
    const [version] = await tx
      .insert(documentVersions)
      .values({ ...file, documentId, versionNumber, isCurrent: false, createdBy: actorId })
      .returning({ id: documentVersions.id });
    await tx.update(documents).set({ updatedAt: new Date() }).where(eq(documents.id, documentId));
    return { versionId: version!.id, versionNumber };
  });
}

/** Promove uma versão processada a vigente, rebaixando a anterior. */
export async function promoteVersion(db: Database, versionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [v] = await tx.select().from(documentVersions).where(eq(documentVersions.id, versionId)).for('update');
    if (!v) throw new AppError('NOT_FOUND', 'Versão não encontrada');
    if (v.isCurrent) return;
    await tx
      .update(documentVersions)
      .set({ isCurrent: false, supersededAt: new Date() })
      .where(and(eq(documentVersions.documentId, v.documentId), eq(documentVersions.isCurrent, true)));
    await tx.update(documentVersions).set({ isCurrent: true, supersededAt: null }).where(eq(documentVersions.id, versionId));
    await tx.update(documents).set({ currentVersionId: versionId }).where(eq(documents.id, v.documentId));
  });
}

function listFilters(q: DocumentListQuery, allowedLevels?: readonly AccessLevel[]): SQL[] {
  const filters: SQL[] = [isNull(documents.deletedAt)];
  if (allowedLevels) filters.push(inArray(documents.accessLevel, [...allowedLevels]));
  if (q.q) {
    const term = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    filters.push(
      or(
        ilike(documents.title, term),
        ilike(documents.documentNumber, term),
        sql`${documents.searchTsv} @@ websearch_to_tsquery('simple_unaccent', ${q.q})`,
      )!,
    );
  }
  if (q.documentType) filters.push(eq(documents.documentType, q.documentType));
  if (q.categoryId) filters.push(eq(documents.categoryId, q.categoryId));
  if (q.validityStatus) filters.push(eq(documents.validityStatus, q.validityStatus));
  if (q.active !== undefined) filters.push(eq(documents.isActive, q.active));
  if (q.status) filters.push(eq(documentVersions.status, q.status));
  if (q.format) filters.push(eq(documentVersions.format, q.format));
  return filters;
}

/** Lista documentos; `allowedLevels` restringe à credencial de quem consulta. */
export async function listDocuments(db: Database, q: DocumentListQuery, allowedLevels?: readonly AccessLevel[]): Promise<Paginated<DocumentDto>> {
  const where = and(...listFilters(q, allowedLevels));
  const order =
    q.sort === 'title_asc'
      ? asc(documents.title)
      : q.sort === 'created_asc'
        ? asc(documents.createdAt)
        : q.sort === 'updated_desc'
          ? desc(documents.updatedAt)
          : desc(documents.createdAt);

  const base = db
    .select({ d: documents, v: documentVersions, categoryName: documentCategories.name })
    .from(documents)
    .leftJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .leftJoin(documentCategories, eq(documentCategories.id, documents.categoryId))
    .where(where);

  const [rows, [totalRow]] = await Promise.all([
    base.orderBy(order, asc(documents.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize),
    db
      .select({ total: count() })
      .from(documents)
      .leftJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
      .where(where),
  ]);
  return {
    items: rows.map((r) => toDocumentDto(r.d, r.v, r.categoryName)),
    page: q.page,
    pageSize: q.pageSize,
    total: Number(totalRow?.total ?? 0),
  };
}

export async function getDocumentRow(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function getDocumentDetail(db: Database, id: string): Promise<DocumentDetailDto | null> {
  const [row] = await db
    .select({ d: documents, categoryName: documentCategories.name })
    .from(documents)
    .leftJoin(documentCategories, eq(documentCategories.id, documents.categoryId))
    .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
    .limit(1);
  if (!row) return null;
  const versions = await db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, id))
    .orderBy(desc(documentVersions.versionNumber));
  const current = versions.find((v) => v.id === row.d.currentVersionId) ?? null;
  return { ...toDocumentDto(row.d, current, row.categoryName), versions: versions.map(toVersionDto) };
}

export async function getVersionRow(db: Database, versionId: string) {
  const [row] = await db.select().from(documentVersions).where(eq(documentVersions.id, versionId)).limit(1);
  return row ?? null;
}

export async function updateDocumentMetadata(
  db: Database,
  id: string,
  patch: DocumentUpdateInput,
): Promise<{ headerChanged: boolean }> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
      .for('update');
    if (!doc) throw new AppError('NOT_FOUND', 'Documento não encontrado');
    if (patch.expectedUpdatedAt && new Date(patch.expectedUpdatedAt).getTime() !== doc.updatedAt.getTime()) {
      throw new AppError('CONFLICT', 'O documento foi alterado por outra sessão. Recarregue antes de salvar.');
    }
    if (patch.supersededByDocumentId === id) throw new AppError('VALIDATION_ERROR', 'Um documento não pode substituir a si mesmo');
    const { expectedUpdatedAt: _ignored, ...values } = patch;
    const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) return { headerChanged: false };
    await tx.update(documents).set(set).where(eq(documents.id, id));
    const oldHeader = buildContextHeader(doc);
    const header = buildContextHeader({
      title: patch.title ?? doc.title,
      documentNumber: patch.documentNumber !== undefined ? patch.documentNumber : doc.documentNumber,
      documentType: patch.documentType ?? doc.documentType,
    });
    if (header === oldHeader) return { headerChanged: false };
    // O cabeçalho entra no texto de embedding: os vetores serão recalculados pelo worker.
    await tx.update(documentChunks).set({ contextHeader: header }).where(eq(documentChunks.documentId, id));
    return { headerChanged: true };
  });
}

export async function softDeleteDocument(db: Database, id: string): Promise<boolean> {
  const updated = await db
    .update(documents)
    .set({ deletedAt: new Date(), isActive: false })
    .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
    .returning({ id: documents.id });
  return updated.length > 0;
}

/**
 * Exclusão definitiva: remove documento, versões, páginas, chunks e embeddings (cascade)
 * e limpa entradas de cache de embedding que ficaram órfãs. Retorna as chaves de
 * armazenamento para remoção dos arquivos.
 */
export async function hardDeleteDocument(db: Database, id: string): Promise<{ storageKeys: string[] } | null> {
  return db.transaction(async (tx) => {
    const versions = await tx
      .select({ storageKey: documentVersions.storageKey })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, id));
    const hashes = await tx
      .selectDistinct({ hash: documentChunks.embeddingInputHash })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, id));
    const deleted = await tx.delete(documents).where(eq(documents.id, id)).returning({ id: documents.id });
    if (deleted.length === 0) return null;
    if (hashes.length > 0) {
      const list = hashes.map((h) => h.hash);
      await tx.execute(sql`
        DELETE FROM embedding_cache ec
        WHERE ec.content_hash = ANY(${sqlArray(list, 'char64')})
          AND NOT EXISTS (SELECT 1 FROM document_chunks c WHERE c.embedding_input_hash = ec.content_hash)`);
    }
    return { storageKeys: versions.map((v) => v.storageKey) };
  });
}

export async function getChunkRow(db: Database, id: string) {
  const [row] = await db.select().from(documentChunks).where(eq(documentChunks.id, id)).limit(1);
  return row ?? null;
}

export async function listDocumentIdsByCreator(db: Database, createdBy: string): Promise<string[]> {
  const rows = await db.select({ id: documents.id }).from(documents).where(eq(documents.createdBy, createdBy));
  return rows.map((r) => r.id);
}

export async function listChunks(
  db: Database,
  versionId: string,
  page: number,
  pageSize: number,
): Promise<Paginated<ChunkDto>> {
  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(documentChunks)
      .where(eq(documentChunks.versionId, versionId))
      .orderBy(asc(documentChunks.chunkIndex))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(documentChunks).where(eq(documentChunks.versionId, versionId)),
  ]);
  return {
    items: rows.map((c) => ({
      id: c.id,
      chunkIndex: c.chunkIndex,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      sectionTitle: c.sectionTitle,
      headingPath: c.headingPath,
      structuralRef: c.structuralRef,
      content: c.content,
      tokenCount: c.tokenCount,
      contentHash: c.contentHash,
      flags: c.flags,
    })),
    page,
    pageSize,
    total: Number(totalRow?.total ?? 0),
  };
}

export async function listPages(db: Database, versionId: string): Promise<PageDto[]> {
  const rows = await db
    .select()
    .from(documentPages)
    .where(eq(documentPages.versionId, versionId))
    .orderBy(asc(documentPages.pageNumber));
  return rows.map((p) => ({ pageNumber: p.pageNumber, text: p.text, ocr: p.ocr, ocrConfidence: p.ocrConfidence }));
}

export async function listProcessingEvents(db: Database, documentId: string, limit = 200): Promise<ProcessingEventDto[]> {
  const rows = await db
    .select({ e: documentProcessingEvents })
    .from(documentProcessingEvents)
    .innerJoin(documentVersions, eq(documentVersions.id, documentProcessingEvents.versionId))
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentProcessingEvents.createdAt), desc(documentProcessingEvents.id))
    .limit(limit);
  return rows.map(({ e }) => ({
    id: String(e.id),
    jobId: e.jobId,
    stage: e.stage as ProcessingEventDto['stage'],
    level: e.level as ProcessingEventDto['level'],
    message: e.message,
    createdAt: e.createdAt.toISOString(),
  }));
}

export async function listCategories(db: Database) {
  return db.select().from(documentCategories).orderBy(asc(documentCategories.name));
}

export async function createCategory(db: Database, input: { name: string; description?: string | null }) {
  const slug = input.name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const [row] = await db
    .insert(documentCategories)
    .values({ name: input.name, slug: slug || 'categoria', description: input.description ?? null })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new AppError('CONFLICT', 'Já existe uma categoria com esse nome');
  return row;
}
