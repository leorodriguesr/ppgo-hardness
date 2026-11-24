import { sqlArray, type Database } from '@rag/database';
import type { AccessLevel, DocumentType, ValidityStatus } from '@rag/shared';
import { sql, type SQL } from 'drizzle-orm';
import { eligibilitySql, type EffectiveFilters } from './filters';
import { extractIdentifiers, identifierTsQuery } from './lexical-query';

export interface Candidate {
  chunkId: string;
  documentId: string;
  versionId: string;
  chunkIndex: number;
  content: string;
  contextHeader: string;
  headingPath: string[];
  sectionTitle: string | null;
  structuralRef: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  flags: string[];
  metadata: Record<string, unknown>;
  contentHash: string;
  tokenCount: number;
  documentTitle: string;
  documentNumber: string | null;
  /** Ementa cadastrada. Muitos artigos não repetem o assunto que ela traz. */
  documentDescription: string | null;
  documentType: DocumentType;
  validityStatus: ValidityStatus;
  accessLevel: AccessLevel;
  publicationDate: string | null;
  versionNumber: number;
  isCurrentVersion: boolean;
  vectorScore?: number;
  vectorRank?: number;
  lexicalScore?: number;
  lexicalRank?: number;
  referenceRank?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLUMNS = sql`
  c.id AS chunk_id, c.document_id, c.version_id, c.chunk_index, c.content, c.context_header, c.heading_path,
  c.section_title, c.structural_ref, c.page_start, c.page_end, c.flags, c.metadata, c.content_hash, c.token_count,
  d.title AS document_title, d.document_number, d.description AS document_description,
  d.document_type, d.validity_status, d.access_level,
  d.publication_date::text AS publication_date, v.version_number, v.is_current`;

type Row = Record<string, unknown>;

function toCandidate(r: Row): Candidate {
  return {
    chunkId: r.chunk_id as string,
    documentId: r.document_id as string,
    versionId: r.version_id as string,
    chunkIndex: Number(r.chunk_index),
    content: r.content as string,
    contextHeader: r.context_header as string,
    headingPath: (r.heading_path as string[]) ?? [],
    sectionTitle: (r.section_title as string | null) ?? null,
    structuralRef: (r.structural_ref as string | null) ?? null,
    pageStart: r.page_start === null ? null : Number(r.page_start),
    pageEnd: r.page_end === null ? null : Number(r.page_end),
    flags: (r.flags as string[]) ?? [],
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    contentHash: r.content_hash as string,
    tokenCount: Number(r.token_count),
    documentTitle: r.document_title as string,
    documentNumber: (r.document_number as string | null) ?? null,
    documentDescription: (r.document_description as string | null) ?? null,
    documentType: r.document_type as DocumentType,
    validityStatus: r.validity_status as ValidityStatus,
    accessLevel: r.access_level as AccessLevel,
    publicationDate: (r.publication_date as string | null) ?? null,
    versionNumber: Number(r.version_number),
    isCurrentVersion: Boolean(r.is_current),
  };
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Anexa a ementa quando o trecho não a repete. Sem isso, um artigo que altera
 * outro ato chega ao reranker sem o assunto (por exemplo, Agenda AC4) e é descartado.
 */
export function withDocumentDescription(description: string | null, content: string): string {
  const ementa = description?.replace(/\s+/g, ' ').trim();
  if (!ementa) return content;
  const probe = fold(ementa).slice(0, 48);
  if (probe.length >= 24 && fold(content).includes(probe)) return content;
  return `${ementa}\n${content}`;
}

export async function vectorSearch(
  db: Database,
  params: { embedding: number[]; modelId: string; dimensions: number; limit: number; minSimilarity: number; filters: EffectiveFilters; efSearch?: number },
): Promise<Candidate[]> {
  if (!UUID_RE.test(params.modelId)) throw new Error('ID de modelo inválido');
  if (!Number.isInteger(params.dimensions) || params.dimensions < 8 || params.dimensions > 4000) throw new Error('Dimensão inválida');
  if (params.embedding.length !== params.dimensions) throw new Error('Dimensão do embedding da consulta difere do índice');
  if (params.embedding.some((x) => !Number.isFinite(x))) throw new Error('Embedding inválido');
  const vecType = sql.raw(`vector(${params.dimensions})`);
  const modelLiteral = sql.raw(`'${params.modelId}'::uuid`);
  const qvec = `[${params.embedding.join(',')}]`;
  const ef = Math.max(params.limit, Math.min(1000, params.efSearch ?? 100));

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${ef}`));
    await tx.execute(sql.raw(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`));
    const rows = await tx.execute<Row>(sql`
      SELECT ${SELECT_COLUMNS}, 1 - (e.embedding::${vecType} <=> ${qvec}::${vecType}) AS similarity
      FROM chunk_embeddings e
      JOIN document_chunks c ON c.id = e.chunk_id
      JOIN document_versions v ON v.id = c.version_id
      JOIN documents d ON d.id = c.document_id
      WHERE e.embedding_model_id = ${modelLiteral} AND ${eligibilitySql(params.filters)}
      ORDER BY e.embedding::${vecType} <=> ${qvec}::${vecType}
      LIMIT ${params.limit}`);
    return rows
      .map((r) => ({ ...toCandidate(r), vectorScore: Number(r.similarity) }))
      .filter((c) => c.vectorScore >= params.minSimilarity)
      .sort((a, b) => b.vectorScore - a.vectorScore)
      .map((c, i) => ({ ...c, vectorRank: i + 1 }));
  });
}

/**
 * Busca lexical híbrida:
 * - consulta OR sobre lexemas com stemming em português (pt_unaccent), ranqueada por ts_rank_cd;
 * - reforço por correspondência exata de identificadores (números de atos, artigos, siglas).
 */
export async function lexicalSearch(
  db: Database,
  params: { query: string; limit: number; filters: EffectiveFilters; identifierBoost?: number },
): Promise<Candidate[]> {
  const identQuery = identifierTsQuery(extractIdentifiers(params.query));
  const boost = params.identifierBoost ?? 2;
  const identSql: SQL = identQuery ? sql`${identQuery}::tsquery` : sql`NULL::tsquery`;
  const rows = await db.execute<Row>(sql`
    WITH q AS (
      SELECT
        nullif(array_to_string(ARRAY(
          SELECT quote_literal(lex) FROM unnest(tsvector_to_array(to_tsvector('pt_unaccent', ${params.query}))) AS lex
          WHERE position(chr(92) in lex) = 0
        ), ' | '), '')::tsquery AS qpt,
        ${identSql} AS qid
    )
    SELECT ${SELECT_COLUMNS},
      coalesce(ts_rank_cd(c.tsv, q.qpt, 1), 0) + ${boost} * coalesce(ts_rank_cd(c.tsv_simple, q.qid, 1), 0) AS score
    FROM q, document_chunks c
    JOIN document_versions v ON v.id = c.version_id
    JOIN documents d ON d.id = c.document_id
    WHERE ((q.qpt IS NOT NULL AND c.tsv @@ q.qpt) OR (q.qid IS NOT NULL AND c.tsv_simple @@ q.qid))
      AND ${eligibilitySql(params.filters)}
    ORDER BY score DESC, c.id
    LIMIT ${params.limit}`);
  return rows.map((r, i) => ({ ...toCandidate(r), lexicalScore: Number(r.score), lexicalRank: i + 1 }));
}

/**
 * Canal de referências explícitas: quando a pergunta cita número de ato ("Portaria 101/2025")
 * e/ou artigo ("art. 6º"), busca por correspondência estruturada — independente da tokenização
 * do full-text (que trata "101/2025-DGPP" como um único token).
 * Com ato e artigo citados, exige ambos; só com ato, retorna os trechos iniciais do documento.
 */
export async function referenceSearch(
  db: Database,
  params: { query: string; limit: number; filters: EffectiveFilters },
): Promise<Candidate[]> {
  const ids = extractIdentifiers(params.query);
  const acts = ids.actNumbers
    .map((a) => {
      const [num, year] = a.split('/');
      const n = String(Number(num));
      const y = year!.length === 2 ? `(?:20)?${year}` : year!;
      return /^\d+$/.test(n) && /^[\d?:()]+$/.test(y) ? `(^|[^0-9])0*${n}/${y}([^0-9]|$)` : null;
    })
    .filter((x): x is string => x !== null);
  const articles = ids.articles.filter((a) => /^\d{1,4}$/.test(a));
  if (acts.length === 0 && articles.length === 0) return [];

  const actCond = acts.length ? sql.join(acts.map((re) => sql`d.document_number ~ ${re}`), sql` OR `) : sql`false`;
  const artCond = articles.length
    ? sql.join(
        articles.map((n) => sql`c.content ~* ${`(^|[^0-9a-z])art(igo)?\\.?\\s*${n}\\s*(º|°|o)?([^0-9]|$)`}`),
        sql` OR `,
      )
    : sql`false`;
  const where = acts.length && articles.length ? sql`(${actCond}) AND (${artCond})` : acts.length ? actCond : artCond;

  const rows = await db.execute<Row>(sql`
    SELECT ${SELECT_COLUMNS}
    FROM document_chunks c
    JOIN document_versions v ON v.id = c.version_id
    JOIN documents d ON d.id = c.document_id
    WHERE (${where}) AND ${eligibilitySql(params.filters)}
    ORDER BY d.id, c.chunk_index
    LIMIT ${params.limit}`);
  return rows.map((r, i) => ({ ...toCandidate(r), lexicalRank: undefined, referenceRank: i + 1 }));
}

/** Chunks vizinhos (mesma versão) para expansão de contexto. */
export async function neighborChunks(db: Database, versionId: string, indexes: number[]): Promise<Candidate[]> {
  if (indexes.length === 0) return [];
  const rows = await db.execute<Row>(sql`
    SELECT ${SELECT_COLUMNS}
    FROM document_chunks c
    JOIN document_versions v ON v.id = c.version_id
    JOIN documents d ON d.id = c.document_id
    WHERE c.version_id = ${versionId} AND c.chunk_index = ANY(${sqlArray(indexes, 'int')}) AND d.deleted_at IS NULL AND d.is_active`);
  return rows.map(toCandidate);
}
