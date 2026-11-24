import { sqlArray, type Database } from '@rag/database';
import { allowedAccessLevels, type AccessLevel, type DocumentType, type ValidityStatus } from '@rag/shared';
import { sql } from 'drizzle-orm';
import type { ContextSource } from '../generation/context';
import type { EffectiveFilters } from './filters';
import type { FusedCandidate } from './fusion';

const ASK_RE =
  /\b(?:quais|liste|lista|listar|relacione|quero|mostre|mostra|preciso|traga|cite)\b(?:\s+\p{L}+){0,4}\s+(portarias?|resolu[cç][õo]es|atos?\s+normativos|atos?|normas?)\b/iu;

const STOP = new Set(
  `quais qual liste lista listar relacione relacao quero mostre mostra preciso traga cite todas todos as os
   portaria portarias ato atos norma normas resolucao resolucoes normativo normativos que quem concede concedem
   conceder versa versam trata tratam tratar sobre dispoe dispoem dispor a o de do da dos das em no na nos nas
   para por um uma e ou com se ao aos vigente vigentes existe existem ha tem sao me fale fala diga mostrar
   esta estao desse deste desta deste assunto tema caso casos dgpp abaixo mencionados mencionada tambem`.split(/\s+/),
);

/** Na pergunta anterior, estes termos dizem quem, não o assunto da ementa. */
const EARLIER_STOP = new Set(
  'servidor servidores pessoa pessoas possui possuem possuir nome nomes integrante integrantes relacionado relacionados designado designados'.split(' '),
);

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export interface EmentaListQuery {
  /** Termos do assunto, já sem o pedido ("quais portarias"). Vão para a busca da ementa. */
  topic: string;
  /** Restringe o tipo quando a pergunta nomeia portaria ou resolução. */
  documentType: DocumentType | null;
}

function topicTerms(text: string, earlier = false): string[] {
  return (text.match(/\p{L}[\p{L}\p{N}]*/gu) ?? []).filter((word) => {
    const token = fold(word);
    return token.length >= 3 && !STOP.has(token) && (!earlier || !EARLIER_STOP.has(token));
  });
}

/**
 * Pergunta que pede o conjunto de atos sobre um assunto ("quais portarias concedem risco de vida").
 * Continuação ("quero todas as portarias que tratam desse assunto") usa a pergunta anterior do usuário.
 * Não dispara para uma portaria citada pelo número, nem quando não sobra assunto.
 */
export function ementaListQuery(question: string, earlierUserText = ''): EmentaListQuery | null {
  const match = question.match(ASK_RE);
  if (!match || /\b\d{1,6}\s*\/\s*\d{2,4}\b/.test(question)) return null;
  const kind = fold(match[1]!);
  const documentType: DocumentType | null = kind.startsWith('portaria') ? 'portaria' : kind.startsWith('resolu') ? 'resolucao' : null;
  const own = topicTerms(question.slice(match.index! + match[0].length));
  const terms = own.length > 0 ? own : topicTerms(earlierUserText, true);
  if (terms.length === 0) return null;
  return { topic: terms.join(' '), documentType };
}

export interface EmentaHit {
  title: string;
  documentNumber: string | null;
  documentType: DocumentType;
  description: string;
  validityStatus: ValidityStatus;
  publicationDate: string | null;
  documentId: string | null;
  accessLevel: AccessLevel;
  chunkId: string | null;
  versionId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  versionNumber: number | null;
  isCurrentVersion: boolean | null;
}

const LIST_LIMIT = 100;

/** Atos indexados cuja ementa fala do assunto, um por documento, do mais recente ao mais antigo. */
export async function searchActsByEmenta(db: Database, topic: EmentaListQuery, filters: EffectiveFilters): Promise<EmentaHit[]> {
  const allowed = allowedAccessLevels(filters.clearance);
  const levels = filters.accessLevels?.length ? filters.accessLevels.filter((l) => allowed.includes(l)) : allowed;
  const access = sqlArray(levels, 'text');
  const vigente = filters.includeHistorical ? sql`true` : sql`validity_status = 'vigente'`;
  const documentVigente = filters.includeHistorical ? sql`true` : sql`d.validity_status = 'vigente'`;
  const typeFilter = topic.documentType ? sql`document_type = ${topic.documentType}` : sql`true`;
  const documentTypeFilter = topic.documentType ? sql`d.document_type = ${topic.documentType}` : sql`true`;
  const ementaMatch = sql`description IS NOT NULL AND to_tsvector('pt_unaccent', description) @@ plainto_tsquery('pt_unaccent', ${topic.topic})`;
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT
      a.title, a.document_number, a.document_type, a.description, a.validity_status,
      a.publication_date, a.document_id, a.access_level,
      ch.chunk_id, ch.version_id, ch.page_start, ch.page_end, ch.version_number, ch.is_current
    FROM (
      SELECT title, document_number, document_type, description, validity_status,
             publication_date::text AS publication_date, document_id, access_level
      FROM catalog_acts
      WHERE access_level = ANY(${access}) AND ${vigente} AND ${typeFilter} AND ${ementaMatch}
      UNION ALL
      SELECT title, document_number, document_type, description, validity_status,
             publication_date::text, id, access_level
      FROM documents d
      WHERE d.deleted_at IS NULL AND d.is_active
        AND NOT EXISTS (SELECT 1 FROM catalog_acts ca WHERE ca.document_id = d.id)
        AND d.access_level = ANY(${access}) AND ${documentVigente}
        AND ${documentTypeFilter}
        AND d.description IS NOT NULL
        AND to_tsvector('pt_unaccent', d.description) @@ plainto_tsquery('pt_unaccent', ${topic.topic})
    ) a
    INNER JOIN LATERAL (
      SELECT c.id AS chunk_id, c.version_id, c.page_start, c.page_end, v.version_number, v.is_current
      FROM document_chunks c
      JOIN document_versions v ON v.id = c.version_id
      WHERE a.document_id IS NOT NULL AND c.document_id = a.document_id AND c.version_id = v.id
        AND v.is_current AND v.status = 'completed'
      ORDER BY c.chunk_index
      LIMIT 1
    ) ch ON true
    ORDER BY a.publication_date DESC NULLS LAST, a.document_number DESC NULLS LAST
    LIMIT ${LIST_LIMIT + 1}`);
  return rows.map((r) => ({
    title: String(r.title),
    documentNumber: (r.document_number as string | null) ?? null,
    documentType: r.document_type as DocumentType,
    description: String(r.description).replace(/\s+/g, ' ').trim(),
    validityStatus: r.validity_status as ValidityStatus,
    publicationDate: (r.publication_date as string | null) ?? null,
    documentId: (r.document_id as string | null) ?? null,
    accessLevel: r.access_level as AccessLevel,
    chunkId: (r.chunk_id as string | null) ?? null,
    versionId: (r.version_id as string | null) ?? null,
    pageStart: r.page_start == null ? null : Number(r.page_start),
    pageEnd: r.page_end == null ? null : Number(r.page_end),
    versionNumber: r.version_number == null ? null : Number(r.version_number),
    isCurrentVersion: r.is_current == null ? null : Boolean(r.is_current),
  }));
}

function cite(sourceNumber: number, page: number | null): string {
  return page !== null ? ` [Fonte ${sourceNumber}, página ${page}]` : ` [Fonte ${sourceNumber}]`;
}

/** Lista fechada: uma linha por ato, com citação só quando há arquivo indexado. */
export function formatEmentaAnswer(hits: EmentaHit[], truncated: boolean, documentType: DocumentType | null): { text: string; sources: ContextSource[] } {
  const shown = truncated ? hits.slice(0, LIST_LIMIT) : hits;
  const sources: ContextSource[] = [];
  const lines = shown.map((hit) => {
    const ementa = hit.description.replace(/[.]+$/, '');
    let marker = '';
    if (hit.chunkId && hit.documentId && hit.versionId) {
      const sourceNumber = sources.length + 1;
      sources.push(toContextSource(sourceNumber, hit));
      marker = `${cite(sourceNumber, hit.pageStart)} [Fonte ${sourceNumber}, documento]`;
    }
    return `- ${hit.title.trim()}: ${ementa}.${marker}`;
  });
  const noun = actNoun(documentType, truncated ? LIST_LIMIT + 1 : shown.length);
  const indexed = documentType === 'resolucao' ? 'as resoluções já indexadas' : documentType === 'portaria' ? 'as portarias já indexadas' : 'os atos já indexados';
  const lead = truncated
    ? `Entre ${indexed}, a ementa reúne mais de ${LIST_LIMIT} ${noun} sobre este assunto. Estas são as ${LIST_LIMIT} mais recentes:`
    : `Entre ${indexed}, a ementa reúne ${shown.length} ${actNoun(documentType, shown.length)} sobre este assunto:`;
  return { text: `${lead}\n\n${lines.join('\n')}`, sources };
}

function actNoun(documentType: DocumentType | null, count: number): string {
  if (documentType === 'portaria') return count === 1 ? 'portaria vigente' : 'portarias vigentes';
  return count === 1 ? 'ato vigente' : 'atos vigentes';
}

function toContextSource(sourceNumber: number, hit: EmentaHit): ContextSource {
  const candidate = {
    chunkId: hit.chunkId!,
    documentId: hit.documentId!,
    versionId: hit.versionId!,
    chunkIndex: 0,
    content: `${hit.title}\n${hit.description}`,
    contextHeader: '',
    headingPath: [],
    sectionTitle: null,
    structuralRef: null,
    pageStart: hit.pageStart,
    pageEnd: hit.pageEnd,
    flags: [],
    metadata: {},
    contentHash: '',
    tokenCount: 0,
    documentTitle: hit.title,
    documentNumber: hit.documentNumber,
    documentDescription: hit.description,
    documentType: hit.documentType,
    validityStatus: hit.validityStatus,
    accessLevel: hit.accessLevel,
    publicationDate: hit.publicationDate,
    versionNumber: hit.versionNumber ?? 1,
    isCurrentVersion: hit.isCurrentVersion ?? true,
    fusedScore: 1,
    rerankScore: 1,
  } satisfies FusedCandidate;
  return {
    sourceNumber,
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    versionId: candidate.versionId,
    documentTitle: hit.title,
    documentNumber: hit.documentNumber,
    documentType: hit.documentType,
    validityStatus: hit.validityStatus,
    isCurrentVersion: candidate.isCurrentVersion,
    versionNumber: candidate.versionNumber,
    pageStart: hit.pageStart,
    pageEnd: hit.pageEnd,
    sectionTitle: null,
    structuralRef: null,
    excerpt: `${hit.title}\n${hit.description}`,
    score: 1,
    candidate,
  };
}

export const EMENTA_LIST_LIMIT = LIST_LIMIT;
