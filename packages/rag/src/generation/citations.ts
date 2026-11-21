import { NO_EVIDENCE_MESSAGE, type AnswerType, type CitationDto } from '@rag/shared';
import type { ContextSource } from './context';

export interface ParsedCitation {
  sourceNumber: number;
  page: number | null;
  pageEnd: number | null;
  /** Posição do marcador na resposta. */
  index: number;
  raw: string;
}

const BRACKET_RE = /\[([^\]\n]{1,200})\]/g;
const ITEM_RE = /Fontes?\s*(\d{1,3})(?:\s*[,–-]?\s*(?:p(?:á|a)g(?:ina)?s?\.?|p\.)\s*(\d{1,5})(?:\s*(?:[-–]|a|e)\s*(\d{1,5}))?)?/gi;

/** Extrai marcadores [Fonte N, página P] (aceita variações e múltiplas fontes no mesmo colchete). */
export function parseCitations(answer: string): ParsedCitation[] {
  const out: ParsedCitation[] = [];
  for (const m of answer.matchAll(BRACKET_RE)) {
    const inner = m[1]!;
    if (!/fonte/i.test(inner)) continue;
    for (const item of inner.matchAll(ITEM_RE)) {
      out.push({
        sourceNumber: Number(item[1]),
        page: item[2] ? Number(item[2]) : null,
        pageEnd: item[3] ? Number(item[3]) : null,
        index: m.index!,
        raw: m[0],
      });
    }
  }
  return out;
}

export interface CitationCheck {
  citation: ParsedCitation;
  source: ContextSource | null;
  valid: boolean;
  problem: 'unknown_source' | 'page_out_of_range' | 'missing_page' | null;
}

/** Valida cada citação: a fonte existe no contexto e a página está no intervalo do trecho. */
export function validateCitations(citations: ParsedCitation[], sources: ContextSource[]): CitationCheck[] {
  const byNumber = new Map(sources.map((s) => [s.sourceNumber, s]));
  return citations.map((c) => {
    const source = byNumber.get(c.sourceNumber) ?? null;
    if (!source) return { citation: c, source: null, valid: false, problem: 'unknown_source' };
    if (source.pageStart === null) return { citation: c, source, valid: true, problem: null };
    if (c.page === null) return { citation: c, source, valid: true, problem: 'missing_page' };
    const end = source.pageEnd ?? source.pageStart;
    const pages = [c.page, c.pageEnd ?? c.page];
    const inRange = pages.every((p) => p >= source.pageStart! && p <= end);
    return { citation: c, source, valid: inRange, problem: inRange ? null : 'page_out_of_range' };
  });
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function isNoEvidenceAnswer(answer: string): boolean {
  const a = norm(answer);
  return a.startsWith(norm(NO_EVIDENCE_MESSAGE).slice(0, 60)) || a.startsWith('nao encontrei informacoes suficientes');
}

const CONFLICT_RE = /\b(diverg[eê]ncia|divergem|divergentes|conflit(?:o|ante|antes|am)|contradi[cç][aã]o|contradit[oó]ri[ao]s?|orienta[cç][oõ]es\s+distintas)\b/i;

const NEGATED_CONFLICT_RE =
  /\b(?:n[aã]o\s+(?:h[aá]|existe|existem|foi\s+identificad[ao]|foram\s+identificad[ao]s|se\s+observa|apresenta[m]?)|sem|nenhuma?|inexist[eê]ncia\s+de)\s+(?:qualquer\s+|nenhuma?\s+)?(?:diverg[eê]ncias?|conflitos?|contradi[cç](?:[aã]o|[oõ]es))\b/gi;

/** Frases que apenas cogitam divergência ("verificar se há", "não encontrei") não a afirmam. */
const HYPOTHETICAL_CONFLICT_RE =
  /\b(?:verificar\s+se|se\s+h[aá]|caso\s+(?:haja|exista)|n[aã]o\s+(?:encontrei|identifiquei|localizei|foi\s+poss[ií]vel|[eé]\s+poss[ií]vel))\b/i;

function assertsConflict(answer: string): boolean {
  return answer
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((s) => CONFLICT_RE.test(s.replace(NEGATED_CONFLICT_RE, '')) && !HYPOTHETICAL_CONFLICT_RE.test(s));
}

/**
 * Conflito exige afirmação explícita de divergência e citação de ao menos dois documentos distintos.
 * Sem `sources`, conta-se o número de fontes distintas citadas.
 */
export function classifyAnswer(answer: string, sources?: Pick<ContextSource, 'sourceNumber' | 'documentId'>[]): AnswerType {
  if (isNoEvidenceAnswer(answer)) return 'insufficient_evidence';
  if (assertsConflict(answer)) {
    const docBySource = new Map(sources?.map((s) => [s.sourceNumber, s.documentId]));
    const cited = new Set(parseCitations(answer).map((c) => (sources ? docBySource.get(c.sourceNumber) : c.sourceNumber)).filter((d) => d !== undefined));
    if (cited.size >= 2) return 'conflict';
  }
  return 'answered';
}

/** Escolhe um trecho curto da fonte que melhor corresponde à frase citada (para exibição). */
export function bestQuote(sourceText: string, claim: string, maxChars = 400): string {
  const sentences = sourceText.split(/(?<=[.;:])\s+|\n+/).filter((s) => s.trim().length > 0);
  if (sentences.length === 0) return sourceText.slice(0, maxChars);
  const claimWords = new Set(norm(claim).split(' ').filter((w) => w.length > 3));
  let best = sentences[0]!;
  let bestScore = -1;
  for (let i = 0; i < sentences.length; i++) {
    const window = sentences.slice(i, i + 2).join(' ');
    const words = norm(window).split(' ');
    const score = words.filter((w) => claimWords.has(w)).length / Math.sqrt(words.length + 1);
    if (score > bestScore) {
      bestScore = score;
      best = window;
    }
  }
  return best.length > maxChars ? `${best.slice(0, maxChars - 1)}…` : best;
}

export function toCitationRecords(
  checks: CitationCheck[],
  claimForIndex: (index: number) => string,
  supportByIndex: Map<string, number>,
): Omit<CitationDto, 'id' | 'documentTitle' | 'documentNumber' | 'available'>[] {
  const seen = new Set<string>();
  const out: Omit<CitationDto, 'id' | 'documentTitle' | 'documentNumber' | 'available'>[] = [];
  for (const ch of checks) {
    if (!ch.source) continue;
    const key = `${ch.citation.sourceNumber}:${ch.citation.page ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const claim = claimForIndex(ch.citation.index);
    out.push({
      sourceNumber: ch.citation.sourceNumber,
      chunkId: ch.source.chunkId,
      documentId: ch.source.documentId,
      versionId: ch.source.versionId,
      page: ch.citation.page ?? ch.source.pageStart,
      pageStart: ch.source.pageStart,
      pageEnd: ch.source.pageEnd,
      quote: bestQuote(ch.source.excerpt, claim),
      valid: ch.valid,
      supportScore: supportByIndex.get(key) ?? null,
    });
  }
  return out;
}
