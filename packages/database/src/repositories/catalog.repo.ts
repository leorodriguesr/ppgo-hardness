import type { AccessLevel, CatalogActDraft, CatalogActDto, CatalogListDto, CatalogListQuery, CatalogRelationAct, CatalogRelationsDto, CatalogStatus, CatalogSyncDto, DocumentType, ValidityStatus } from '@rag/shared';
import { buildActLinks, CATALOG_STATUSES, decideSiteUpdate, preferDescription, type ParsedSiteAct } from '@rag/shared';
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { sqlArray } from '../sql-helpers';
import { catalogActLinks, catalogActs, catalogSyncState, documentVersions, documents } from '../schema';
import { toVersionDto } from './mappers';

const SOURCE = 'legisla';

export async function upsertCatalogActs(db: Database, rows: CatalogActDraft[]): Promise<number> {
  const size = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    if (batch.length === 0) continue;
    await db
      .insert(catalogActs)
      .values(batch)
      .onConflictDoUpdate({
        target: [catalogActs.source, catalogActs.externalId],
        set: {
          title: sql`excluded.title`,
          documentType: sql`excluded.document_type`,
          documentNumber: sql`excluded.document_number`,
          issuingBody: sql`excluded.issuing_body`,
          publicationDate: sql`excluded.publication_date`,
          effectiveDate: sql`excluded.effective_date`,
          validityStatus: sql`CASE WHEN catalog_acts.revoked_by IS NOT NULL THEN catalog_acts.validity_status ELSE excluded.validity_status END`,
          accessLevel: sql`excluded.access_level`,
          description: sql`excluded.description`,
          updatedAt: new Date(),
        },
      });
    written += batch.length;
  }
  return written;
}

type LibraryRow = {
  origin: 'catalog' | 'upload';
  source: string | null;
  external_id: number | null;
  revoked_by: string | null;
  page_url: string | null;
  file_kind: string | null;
  document_id: string | null;
  title: string;
  document_type: string;
  document_number: string | null;
  issuing_body: string | null;
  publication_date: string | null;
  effective_date: string | null;
  validity_status: string;
  access_level: string;
  description: string | null;
  status: string;
  error_message: string | null;
  is_active: boolean;
  current_version_id: string | null;
  amendments: number;
  revocations: number;
  incorporated_into: string | null;
};

function likeTerm(q: string | undefined): string | null {
  if (!q) return null;
  return `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

function libraryQuery(q: CatalogListQuery, allowedLevels: readonly AccessLevel[] | undefined, paged: boolean): SQL {
  const levels = allowedLevels ?? ['publico', 'interno', 'restrito', 'sigiloso'];
  const access = sqlArray(levels, 'text');
  const term = likeTerm(q.q);
  const catalogSearch = term ? sql`(c.title ILIKE ${term} OR c.document_number ILIKE ${term} OR c.description ILIKE ${term})` : sql`true`;
  const uploadSearch = term ? sql`(d.title ILIKE ${term} OR d.document_number ILIKE ${term} OR d.description ILIKE ${term})` : sql`true`;
  const shownStatus = () => sql`CASE WHEN c.status = 'ingerido' AND d.id IS NULL THEN 'pendente' ELSE c.status END`;
  const catalogStatus = q.status ? sql`${shownStatus()} = ${q.status}` : sql`true`;
  const uploadStatus =
    q.status === 'pendente' || q.status === 'baixando'
      ? sql`false`
      : q.status === 'erro'
        ? sql`v.status = 'error'`
        : q.status === 'ingerido'
          ? sql`coalesce(v.status, '') <> 'error'`
          : sql`true`;
  const hideLinked = !term && q.vinculos !== 'mostrar';
  const linkedAway = sql`EXISTS (
    SELECT 1 FROM catalog_act_links l
    WHERE l.child_source = c.source AND l.child_external_id = c.external_id
      AND (l.incorporated OR (l.kind = 'revogacao' AND c.validity_status = 'revogado'))
  )`;
  const page = paged ? sql`ORDER BY publication_date DESC NULLS LAST, external_id DESC NULLS LAST, document_id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}` : sql``;
  return sql`
    SELECT * FROM (
      SELECT
        'catalog'::text AS origin,
        c.source,
        c.external_id,
        c.revoked_by,
        c.page_url,
        c.file_kind,
        d.id AS document_id,
        c.title,
        c.document_type,
        c.document_number,
        c.issuing_body,
        c.publication_date::text AS publication_date,
        c.effective_date::text AS effective_date,
        c.validity_status,
        c.access_level,
        c.description,
        ${shownStatus()} AS status,
        c.error_message,
        coalesce(d.is_active, true) AS is_active,
        d.current_version_id,
        (SELECT count(*)::int FROM catalog_act_links l WHERE l.parent_source = c.source AND l.parent_external_id = c.external_id AND l.kind = 'alteracao') AS amendments,
        (SELECT count(*)::int FROM catalog_act_links l WHERE l.parent_source = c.source AND l.parent_external_id = c.external_id AND l.kind = 'revogacao') AS revocations,
        (SELECT p.title FROM catalog_act_links l JOIN catalog_acts p ON p.source = l.parent_source AND p.external_id = l.parent_external_id WHERE l.child_source = c.source AND l.child_external_id = c.external_id AND l.incorporated LIMIT 1) AS incorporated_into
      FROM catalog_acts c
      LEFT JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL
      WHERE c.source IN ('legisla', 'site')
        AND c.access_level = ANY(${access})
        AND ${catalogStatus}
        AND ${catalogSearch}
        AND ${hideLinked ? sql`NOT ${linkedAway}` : sql`true`}
      UNION ALL
      SELECT
        'upload'::text,
        NULL::text,
        NULL::int,
        NULL::text,
        NULL::text,
        NULL::text,
        d.id,
        d.title,
        d.document_type,
        d.document_number,
        d.issuing_body,
        d.publication_date::text,
        d.effective_date::text,
        d.validity_status,
        d.access_level,
        d.description,
        CASE WHEN v.status = 'error' THEN 'erro' ELSE 'ingerido' END,
        CASE WHEN v.status = 'error' THEN v.error_message ELSE NULL END,
        d.is_active,
        d.current_version_id,
        0::int,
        0::int,
        NULL::text
      FROM documents d
      LEFT JOIN document_versions v ON v.id = d.current_version_id
      WHERE d.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM catalog_acts ca WHERE ca.document_id = d.id)
        AND d.access_level = ANY(${access})
        AND ${uploadStatus}
        AND ${uploadSearch}
    ) library
    ${page}`;
}

export async function listCatalogActs(db: Database, q: CatalogListQuery, allowedLevels?: readonly AccessLevel[]): Promise<CatalogListDto> {
  const levels = allowedLevels ?? ['publico', 'interno', 'restrito', 'sigiloso'];
  const access = sqlArray(levels, 'text');
  const [rows, [totalRow], countRows, [uploadRow], [nestedRow]] = await Promise.all([
    db.execute<LibraryRow>(libraryQuery(q, allowedLevels, true)),
    db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM (${libraryQuery(q, allowedLevels, false)}) counted`),
    db.execute<{ status: string; total: number }>(sql`
      SELECT CASE WHEN c.status = 'ingerido' AND d.id IS NULL THEN 'pendente' ELSE c.status END AS status,
             count(*)::int AS total
      FROM catalog_acts c
      LEFT JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL
      WHERE c.source IN ('legisla', 'site') AND c.access_level = ANY(${access})
      GROUP BY 1`),
    db.execute<{ indexed: number; failed: number }>(sql`
      SELECT
        count(*) FILTER (WHERE coalesce(v.status, '') <> 'error')::int AS indexed,
        count(*) FILTER (WHERE v.status = 'error')::int AS failed
      FROM documents d
      LEFT JOIN document_versions v ON v.id = d.current_version_id
      WHERE d.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM catalog_acts ca WHERE ca.document_id = d.id)
        AND d.access_level = ANY(${access})`),
    db.execute<{ nested: number }>(sql`
      SELECT count(*)::int AS nested
      FROM catalog_acts c
      WHERE c.source IN ('legisla', 'site') AND c.access_level = ANY(${access})
        AND EXISTS (
          SELECT 1 FROM catalog_act_links l
          WHERE l.child_source = c.source AND l.child_external_id = c.external_id
            AND (l.incorporated OR (l.kind = 'revogacao' AND c.validity_status = 'revogado'))
        )`),
  ]);
  const versionIds = [...new Set(rows.map((row) => row.current_version_id).filter((id): id is string => !!id))];
  const versions = versionIds.length
    ? await db.select().from(documentVersions).where(inArray(documentVersions.id, versionIds))
    : [];
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const counts = Object.fromEntries(CATALOG_STATUSES.map((status) => [status, 0])) as Record<CatalogStatus, number>;
  for (const row of countRows) counts[row.status as CatalogStatus] = Number(row.total);
  counts.ingerido += Number(uploadRow?.indexed ?? 0);
  counts.erro += Number(uploadRow?.failed ?? 0);
  return {
    items: rows.map((row) => toCatalogDto(row, row.current_version_id ? versionById.get(row.current_version_id) ?? null : null)),
    page: q.page,
    pageSize: q.pageSize,
    total: Number(totalRow?.total ?? 0),
    counts,
    nested: Number(nestedRow?.nested ?? 0),
  };
}

function toCatalogDto(row: LibraryRow, version: typeof documentVersions.$inferSelect | null): CatalogActDto {
  return {
    origin: row.origin,
    source: row.source === 'legisla' || row.source === 'site' ? row.source : null,
    externalId: row.external_id === null ? null : Number(row.external_id),
    revokedBy: row.revoked_by,
    pageUrl: row.page_url,
    fileKind: row.file_kind === 'legisla' || row.file_kind === 'pdf' ? row.file_kind : null,
    title: row.title,
    documentType: row.document_type as DocumentType,
    documentNumber: row.document_number,
    issuingBody: row.issuing_body,
    publicationDate: row.publication_date,
    effectiveDate: row.effective_date,
    validityStatus: row.validity_status as ValidityStatus,
    accessLevel: row.access_level as AccessLevel,
    description: row.description,
    status: row.status as CatalogStatus,
    errorMessage: row.error_message,
    documentId: row.document_id,
    isActive: row.is_active,
    currentVersion: version ? toVersionDto(version) : null,
    amendments: Number(row.amendments ?? 0),
    revocations: Number(row.revocations ?? 0),
    incorporatedInto: row.incorporated_into,
  };
}

export async function getCatalogAct(db: Database, externalId: number, source = SOURCE) {
  const [row] = await db
    .select()
    .from(catalogActs)
    .where(and(eq(catalogActs.source, source), eq(catalogActs.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

/**
 * Reserva o ato para download. Pendente, erro e indexação órfã (documento apagado) podem ser
 * reivindicados. Um download interrompido há mais de 10 minutos também volta a ficar livre.
 */
export async function claimCatalogAct(db: Database, externalId: number, source = SOURCE) {
  const [row] = await db
    .update(catalogActs)
    .set({ status: 'baixando', errorMessage: null, updatedAt: new Date() })
    .where(
      and(
        eq(catalogActs.source, source),
        eq(catalogActs.externalId, externalId),
        or(
          inArray(catalogActs.status, ['pendente', 'erro']),
          and(eq(catalogActs.status, 'ingerido'), isNull(catalogActs.documentId)),
          and(eq(catalogActs.status, 'baixando'), sql`${catalogActs.updatedAt} < now() - interval '10 minutes'`),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

export async function markCatalogIngested(db: Database, externalId: number, documentId: string, source = SOURCE, fileEtag?: string | null): Promise<void> {
  await db
    .update(catalogActs)
    .set({ status: 'ingerido', documentId, errorMessage: null, ...(fileEtag !== undefined ? { fileEtag } : {}), updatedAt: new Date() })
    .where(and(eq(catalogActs.source, source), eq(catalogActs.externalId, externalId)));
}

export async function markCatalogError(db: Database, externalId: number, message: string, source = SOURCE): Promise<void> {
  await db
    .update(catalogActs)
    .set({ status: 'erro', errorMessage: message.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(catalogActs.source, source), eq(catalogActs.externalId, externalId), eq(catalogActs.status, 'baixando')));
}

/** Tira o arquivo do índice e devolve o ato do site para "não indexado". O cadastro permanece. */
export async function detachCatalogDocument(db: Database, documentId: string): Promise<number> {
  const rows = await db
    .update(catalogActs)
    .set({ status: 'pendente', documentId: null, errorMessage: null, fileEtag: null, updatedAt: new Date() })
    .where(eq(catalogActs.documentId, documentId))
    .returning({ id: catalogActs.id });
  return rows.length;
}

export async function markCatalogRefreshFailed(db: Database, source: string, externalId: number, message: string): Promise<void> {
  await db
    .update(catalogActs)
    .set({ status: 'ingerido', errorMessage: message.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(catalogActs.source, source), eq(catalogActs.externalId, externalId), eq(catalogActs.status, 'baixando')));
}

export async function claimCatalogRefresh(db: Database, source: string, externalId: number) {
  const [row] = await db
    .update(catalogActs)
    .set({ status: 'baixando', errorMessage: null, updatedAt: new Date() })
    .where(
      and(
        eq(catalogActs.source, source),
        eq(catalogActs.externalId, externalId),
        or(eq(catalogActs.status, 'ingerido'), and(eq(catalogActs.status, 'baixando'), sql`${catalogActs.updatedAt} < now() - interval '10 minutes'`)),
      ),
    )
    .returning();
  return row ?? null;
}

function actKey(source: string, externalId: number) {
  return and(eq(catalogActs.source, source), eq(catalogActs.externalId, externalId));
}

function sameActNumber(stored: string | null, incoming: string | null): boolean {
  if (!stored || !incoming) return true;
  return stored === incoming;
}

async function findSiteMatch(db: Database, act: ParsedSiteAct) {
  if (act.legislaId) {
    const byLegisla = await getCatalogAct(db, act.legislaId, 'legisla');
    // A publicação pode citar o Legisla de outro ato. Esse id não autoriza reescrever o cadastro.
    if (byLegisla && sameActNumber(byLegisla.documentNumber, act.documentNumber)) return byLegisla;
  }
  const [byPost] = await db.select().from(catalogActs).where(eq(catalogActs.wpPostId, act.wpPostId)).limit(1);
  if (byPost) return byPost;
  if (!act.documentNumber) return null;
  const matches = await db
    .select()
    .from(catalogActs)
    .where(and(eq(catalogActs.documentNumber, act.documentNumber), eq(catalogActs.documentType, act.documentType), inArray(catalogActs.source, ['legisla', 'site'])))
    .limit(5);
  return matches.sort((a, b) => Number(!!b.documentId) - Number(!!a.documentId) || Number(a.source === 'site') - Number(b.source === 'site'))[0] ?? null;
}

export interface SiteActSaveResult {
  source: 'legisla' | 'site';
  externalId: number;
  created: boolean;
  documentId: string | null;
  refresh: boolean;
  revoked: boolean;
}

/** Cria ou atualiza o ato a partir de uma publicação. Não baixa o arquivo. */
export async function saveSiteAct(db: Database, act: ParsedSiteAct, contentHash: string): Promise<SiteActSaveResult> {
  const existing = await findSiteMatch(db, act);
  const decision = decideSiteUpdate(
    existing
      ? {
          source: existing.source === 'site' ? 'site' : 'legisla',
          externalId: existing.externalId,
          fileKind: existing.fileKind === 'pdf' || existing.fileKind === 'legisla' ? existing.fileKind : null,
          contentHash: existing.contentHash,
          validityStatus: existing.validityStatus as ValidityStatus,
          revokedBy: existing.revokedBy,
          status: existing.status,
          documentId: existing.documentId,
        }
      : null,
    act,
    contentHash,
  );
  await db
    .update(catalogActs)
    .set({ wpPostId: null })
    .where(and(eq(catalogActs.wpPostId, act.wpPostId), existing ? sql`${catalogActs.id} <> ${existing.id}` : sql`true`));
  const values = {
    source: decision.source,
    externalId: decision.externalId,
    title: act.documentNumber || !existing ? act.title : existing.title,
    documentType: act.documentType,
    documentNumber: act.documentNumber ?? existing?.documentNumber ?? null,
    issuingBody: 'Diretoria-Geral de Polícia Penal',
    publicationDate: act.publicationDate ?? existing?.publicationDate ?? null,
    description: preferDescription(existing?.description ?? null, act.description),
    validityStatus: decision.validityStatus,
    accessLevel: 'publico' as const,
    wpPostId: act.wpPostId,
    pageUrl: act.pageUrl,
    fileUrl: decision.fileUrl,
    fileKind: decision.fileKind,
    contentHash,
    revokedBy: decision.revokedBy,
    siteCategory: act.category,
    updatedAt: new Date(),
  };
  if (!existing) {
    await db.insert(catalogActs).values({ ...values, status: 'pendente' });
    return { source: decision.source, externalId: decision.externalId, created: true, documentId: null, refresh: false, revoked: false };
  }
  const keyChanges = existing.source !== decision.source || existing.externalId !== decision.externalId;
  if (keyChanges) {
    const occupant = await getCatalogAct(db, decision.externalId, decision.source);
    if (occupant && occupant.id !== existing.id) {
      await db.update(catalogActs).set(values).where(eq(catalogActs.id, occupant.id));
      if (!existing.documentId) await db.delete(catalogActs).where(eq(catalogActs.id, existing.id));
      return { source: decision.source, externalId: decision.externalId, created: false, documentId: occupant.documentId ?? existing.documentId, refresh: decision.refresh, revoked: decision.revokeDocument };
    }
  }
  await db.update(catalogActs).set(values).where(eq(catalogActs.id, existing.id));
  if (decision.revokeDocument && existing.documentId) {
    await db.update(documents).set({ validityStatus: 'revogado', updatedAt: new Date() }).where(eq(documents.id, existing.documentId));
  }
  if (act.legislaId && act.documentNumber) {
    await db
      .delete(catalogActs)
      .where(and(eq(catalogActs.source, 'site'), eq(catalogActs.documentNumber, act.documentNumber), eq(catalogActs.documentType, act.documentType), isNull(catalogActs.documentId)));
  }
  return {
    source: decision.source,
    externalId: decision.externalId,
    created: false,
    documentId: existing.documentId,
    refresh: decision.refresh,
    revoked: decision.revokeDocument,
  };
}

export async function getCatalogSyncState(db: Database): Promise<CatalogSyncDto> {
  const [row] = await db.select().from(catalogSyncState).where(eq(catalogSyncState.id, 'site')).limit(1);
  const stats = (row?.stats ?? {}) as CatalogSyncDto['stats'];
  return {
    cursorAt: row?.cursorModified ?? row?.cursorAt?.toISOString() ?? null,
    lastRunAt: row?.lastRunAt?.toISOString() ?? null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    stats,
  };
}

export async function markCatalogSyncRunning(db: Database): Promise<void> {
  await db.update(catalogSyncState).set({ lastRunAt: new Date(), lastError: null }).where(eq(catalogSyncState.id, 'site'));
}

export async function saveCatalogSyncCursor(db: Database, cursorModified: string): Promise<void> {
  const cursorAt = new Date(cursorModified);
  await db
    .update(catalogSyncState)
    .set({ cursorModified, cursorAt: Number.isNaN(cursorAt.getTime()) ? null : cursorAt })
    .where(eq(catalogSyncState.id, 'site'));
}

export async function finishCatalogSync(db: Database, stats: CatalogSyncDto['stats'], error: string | null): Promise<void> {
  await db
    .update(catalogSyncState)
    .set({ lastError: error, stats, lastRunAt: new Date(), ...(error ? {} : { lastSuccessAt: new Date() }) })
    .where(eq(catalogSyncState.id, 'site'));
}

export interface CatalogProbeRow {
  source: 'legisla' | 'site';
  externalId: number;
  fileKind: 'legisla' | 'pdf' | null;
  fileUrl: string | null;
  fileEtag: string | null;
  validityStatus: string;
  documentId: string | null;
}

/** Atos já indexados, os há mais tempo sem verificação primeiro. */
export async function listCatalogProbe(db: Database, limit: number): Promise<CatalogProbeRow[]> {
  const rows = await db
    .select({
      source: catalogActs.source,
      externalId: catalogActs.externalId,
      fileKind: catalogActs.fileKind,
      fileUrl: catalogActs.fileUrl,
      fileEtag: catalogActs.fileEtag,
      validityStatus: catalogActs.validityStatus,
      documentId: catalogActs.documentId,
    })
    .from(catalogActs)
    .where(and(eq(catalogActs.status, 'ingerido'), sql`${catalogActs.documentId} IS NOT NULL`))
    .orderBy(sql`${catalogActs.checkedAt} ASC NULLS FIRST`, asc(catalogActs.externalId))
    .limit(limit);
  return rows.map((row) => ({
    source: row.source === 'site' ? 'site' : 'legisla',
    externalId: row.externalId,
    fileKind: row.fileKind === 'pdf' || row.fileKind === 'legisla' ? row.fileKind : null,
    fileUrl: row.fileUrl,
    fileEtag: row.fileEtag,
    validityStatus: row.validityStatus,
    documentId: row.documentId,
  }));
}

export async function touchCatalogChecked(db: Database, source: string, externalId: number): Promise<void> {
  await db.update(catalogActs).set({ checkedAt: new Date() }).where(actKey(source, externalId));
}

/** Próximo ato indexado que ainda não teve o arquivo comparado com a fonte. */
export async function nextUnalignedCatalogAct(db: Database): Promise<CatalogProbeRow | null> {
  const [row] = await db
    .select({
      source: catalogActs.source,
      externalId: catalogActs.externalId,
      fileKind: catalogActs.fileKind,
      fileUrl: catalogActs.fileUrl,
      fileEtag: catalogActs.fileEtag,
      validityStatus: catalogActs.validityStatus,
      documentId: catalogActs.documentId,
    })
    .from(catalogActs)
    .where(and(eq(catalogActs.status, 'ingerido'), sql`${catalogActs.documentId} IS NOT NULL`, isNull(catalogActs.fileEtag), eq(catalogActs.validityStatus, 'vigente')))
    .orderBy(sql`${catalogActs.checkedAt} ASC NULLS FIRST`)
    .limit(1);
  if (!row) return null;
  return {
    source: row.source === 'site' ? 'site' : 'legisla',
    externalId: row.externalId,
    fileKind: row.fileKind === 'pdf' || row.fileKind === 'legisla' ? row.fileKind : null,
    fileUrl: row.fileUrl,
    fileEtag: null,
    validityStatus: row.validityStatus,
    documentId: row.documentId,
  };
}

/** Recalcula os vínculos a partir das ementas já gravadas. Não baixa arquivo. */
export async function rebuildCatalogLinks(db: Database): Promise<number> {
  const rows = await db
    .select({
      source: catalogActs.source,
      externalId: catalogActs.externalId,
      documentType: catalogActs.documentType,
      documentNumber: catalogActs.documentNumber,
      description: catalogActs.description,
      revokedBy: catalogActs.revokedBy,
      fileKind: catalogActs.fileKind,
      validityStatus: catalogActs.validityStatus,
    })
    .from(catalogActs)
    .where(inArray(catalogActs.source, ['legisla', 'site']));
  const links = buildActLinks(
    rows.map((row) => ({
      source: row.source === 'site' ? ('site' as const) : ('legisla' as const),
      externalId: row.externalId,
      documentType: row.documentType,
      documentNumber: row.documentNumber,
      description: row.description,
      revokedBy: row.revokedBy,
      fileKind: row.fileKind === 'pdf' || row.fileKind === 'legisla' ? row.fileKind : null,
      validityStatus: row.validityStatus,
    })),
  );
  await db.transaction(async (tx) => {
    await tx.delete(catalogActLinks);
    for (let i = 0; i < links.length; i += 400) {
      const batch = links.slice(i, i + 400);
      if (batch.length === 0) continue;
      await tx.insert(catalogActLinks).values(
        batch.map((link) => ({
          parentSource: link.parentSource,
          parentExternalId: link.parentExternalId,
          childSource: link.childSource,
          childExternalId: link.childExternalId,
          kind: link.kind,
          incorporated: link.incorporated,
          origin: link.origin,
        })),
      );
    }
  });
  return links.length;
}

type RelationRow = {
  side: string;
  kind: string;
  incorporated: boolean;
  source: string;
  external_id: number;
  title: string;
  document_number: string | null;
  publication_date: string | null;
  validity_status: string;
  status: string;
  document_id: string | null;
  file_kind: string | null;
};

/** Filhos agrupados no ato e, se ele próprio for filho, o ato principal. */
export async function getCatalogRelations(db: Database, target: { source: 'legisla' | 'site'; externalId: number } | { documentId: string }): Promise<CatalogRelationsDto> {
  let source: string;
  let externalId: number;
  if ('documentId' in target) {
    const [row] = await db
      .select({ source: catalogActs.source, externalId: catalogActs.externalId })
      .from(catalogActs)
      .where(eq(catalogActs.documentId, target.documentId))
      .limit(1);
    if (!row) return { children: [], parents: [] };
    source = row.source;
    externalId = row.externalId;
  } else {
    source = target.source;
    externalId = target.externalId;
  }
  const rows = await db.execute<RelationRow>(sql`
    SELECT 'child'::text AS side, l.kind, l.incorporated, c.source, c.external_id, c.title, c.document_number,
           c.publication_date::text AS publication_date, c.validity_status,
           CASE WHEN c.status = 'ingerido' AND d.id IS NULL THEN 'pendente' ELSE c.status END AS status,
           d.id AS document_id, c.file_kind
    FROM catalog_act_links l
    JOIN catalog_acts c ON c.source = l.child_source AND c.external_id = l.child_external_id
    LEFT JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL
    WHERE l.parent_source = ${source} AND l.parent_external_id = ${externalId}
    UNION ALL
    SELECT 'parent'::text, l.kind, l.incorporated, p.source, p.external_id, p.title, p.document_number,
           p.publication_date::text, p.validity_status,
           CASE WHEN p.status = 'ingerido' AND d.id IS NULL THEN 'pendente' ELSE p.status END,
           d.id, p.file_kind
    FROM catalog_act_links l
    JOIN catalog_acts p ON p.source = l.parent_source AND p.external_id = l.parent_external_id
    LEFT JOIN documents d ON d.id = p.document_id AND d.deleted_at IS NULL
    WHERE l.child_source = ${source} AND l.child_external_id = ${externalId}
  `);
  const toAct = (row: RelationRow): CatalogRelationAct => ({
    source: row.source === 'site' ? 'site' : 'legisla',
    externalId: Number(row.external_id),
    title: row.title,
    documentNumber: row.document_number,
    publicationDate: row.publication_date,
    validityStatus: row.validity_status as ValidityStatus,
    status: row.status as CatalogStatus,
    documentId: row.document_id,
    fileKind: row.file_kind === 'pdf' || row.file_kind === 'legisla' ? row.file_kind : null,
    linkKind: row.kind === 'revogacao' ? 'revogacao' : 'alteracao',
    incorporated: Boolean(row.incorporated),
  });
  const children = rows.filter((row) => row.side === 'child').map(toAct);
  const parents = rows.filter((row) => row.side === 'parent').map(toAct);
  children.sort((a, b) => a.linkKind.localeCompare(b.linkKind) || (a.publicationDate ?? '').localeCompare(b.publicationDate ?? ''));
  return { children, parents };
}
