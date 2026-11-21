import { allowedAccessLevels, type AccessLevel, type RetrievalFilters } from '@rag/shared';
import { sqlArray } from '@rag/database';
import { sql, type SQL } from 'drizzle-orm';

export interface EffectiveFilters extends RetrievalFilters {
  clearance: AccessLevel;
  includeHistorical: boolean;
}

/**
 * Condições de elegibilidade aplicadas a TODA recuperação (aliases: c = chunks, v = versões, d = documentos).
 * A autorização é feita aqui, no servidor; o frontend nunca é tratado como controle de acesso.
 */
export function eligibilitySql(f: EffectiveFilters): SQL {
  const allowed = allowedAccessLevels(f.clearance);
  const levels = f.accessLevels?.length ? f.accessLevels.filter((l) => allowed.includes(l)) : allowed;
  const parts: SQL[] = [
    sql`d.deleted_at IS NULL`,
    sql`d.is_active`,
    sql`v.status = 'completed'`,
    sql`d.access_level = ANY(${sqlArray(levels, 'text')})`,
  ];
  if (f.includeHistorical) {
    // Versões atuais e anteriores; documentos de qualquer situação de vigência
    parts.push(sql`(v.is_current OR v.superseded_at IS NOT NULL)`);
  } else {
    parts.push(sql`v.is_current`, sql`d.validity_status = 'vigente'`);
  }
  if (f.documentIds?.length) parts.push(sql`d.id = ANY(${sqlArray(f.documentIds, 'uuid')})`);
  if (f.categoryIds?.length) parts.push(sql`d.category_id = ANY(${sqlArray(f.categoryIds, 'uuid')})`);
  if (f.documentTypes?.length) parts.push(sql`d.document_type = ANY(${sqlArray(f.documentTypes, 'text')})`);
  if (f.issuingBodies?.length) parts.push(sql`d.issuing_body = ANY(${sqlArray(f.issuingBodies, 'text')})`);
  if (f.publishedFrom) parts.push(sql`d.publication_date >= ${f.publishedFrom}::date`);
  if (f.publishedTo) parts.push(sql`d.publication_date <= ${f.publishedTo}::date`);
  return sql.join(parts, sql` AND `);
}

const HISTORICAL_RE =
  /\b(revogad[aoe]s?|revoga[cç][aã]o|anteriormente|vers[aã]o\s+(?:anterior|antiga|original|\d+)|vers[oõ]es\s+anteriores|hist[oó]ric[oa]s?|antes\s+d[aeo]s?\s+(?:portaria|resolu|norma|nova|atual|altera)|vigorava|vigia|substitu[ií]d[ao]s?|regra\s+antiga|norma\s+antiga|o\s+que\s+(?:dizia|previa|estabelecia)|em\s+(?:19|20)\d{2},?\s+(?:qual|como|o\s+que))/i;

/** Detecta perguntas explicitamente históricas, que podem consultar documentos não vigentes. */
export function isHistoricalQuestion(question: string): boolean {
  return HISTORICAL_RE.test(question);
}
