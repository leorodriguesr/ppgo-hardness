import type { DocumentType, ValidityStatus } from './domain';

const MONTHS: Record<string, string> = {
  janeiro: '01',
  fevereiro: '02',
  marco: '03',
  março: '03',
  abril: '04',
  maio: '05',
  junho: '06',
  julho: '07',
  agosto: '08',
  setembro: '09',
  outubro: '10',
  novembro: '11',
  dezembro: '12',
};

const ACT_RE =
  /\b(portaria|resolu[cç][aã]o|instru[cç][aã]o normativa|decreto|of[ií]cio|extrato|edital|lei)\b[^.\d]{0,24}?(\d{1,5})\s*(?:\/\s*(\d{4})|(?:\s*,)?\s*de\s+(\d{1,2})\s+de\s+([a-zçã]+)\s+de\s+(\d{4}))/iu;

const REVOKED_RE = /\(\s*revogad[oa]\s+pel[oa]\s+([^)]+?)\s*\)/iu;

export interface WpPostInput {
  id: number;
  link: string;
  modified: string;
  title: string;
  html: string;
  categories: string[];
}

export interface ParsedSiteAct {
  wpPostId: number;
  modified: string;
  pageUrl: string;
  title: string;
  documentType: DocumentType;
  documentNumber: string | null;
  publicationDate: string | null;
  description: string | null;
  legislaId: number | null;
  pdfUrl: string | null;
  revokedBy: string | null;
  category: string | null;
  /** Texto usado para saber se a página do site mudou. O hash fica a cargo de quem grava. */
  fingerprint: string;
}

export interface StoredSiteAct {
  source: 'legisla' | 'site';
  externalId: number;
  fileKind: 'legisla' | 'pdf' | null;
  contentHash: string | null;
  validityStatus: ValidityStatus;
  revokedBy: string | null;
  status: string;
  documentId: string | null;
}

export interface SiteActDecision {
  source: 'legisla' | 'site';
  externalId: number;
  fileKind: 'legisla' | 'pdf' | null;
  fileUrl: string | null;
  validityStatus: ValidityStatus;
  revokedBy: string | null;
  /** Baixar de novo um ato que já está indexado, porque o PDF do site mudou. */
  refresh: boolean;
  /** A página avisa que o ato foi revogado e já existe documento indexado. */
  revokeDocument: boolean;
}

export function decodeWpText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function documentTypeOf(title: string): DocumentType {
  if (/^\s*extrato\b/iu.test(title) || /^\s*edital\b/iu.test(title)) return 'outro';
  if (/\bportaria\b/iu.test(title)) return 'portaria';
  if (/\bresolu[cç][aã]o\b/iu.test(title)) return 'resolucao';
  if (/\binstru[cç][aã]o normativa\b/iu.test(title)) return 'instrucao_normativa';
  if (/\bdecreto\b/iu.test(title)) return 'decreto';
  if (/\bof[ií]cio\b/iu.test(title)) return 'oficio';
  if (/\blei\b/iu.test(title)) return 'lei';
  return 'outro';
}

function publicationDate(day: string | undefined, monthName: string | undefined, year: string | undefined): string | null {
  if (!day || !monthName || !year) return null;
  const month = MONTHS[monthName.toLocaleLowerCase('pt-BR')];
  if (!month) return null;
  const iso = `${year}-${month}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(day)) return null;
  return iso;
}

function ementaOf(text: string, title: string, revokedBy: string | null): string | null {
  let body = text;
  if (title && body.toLocaleLowerCase('pt-BR').startsWith(title.toLocaleLowerCase('pt-BR'))) body = body.slice(title.length);
  body = body.replace(/\bESTADO DE GOI[AÁ]S\b/giu, ' ').replace(/\bDIRETORIA-GERAL DE POL[IÍ]CIA PENAL\b/giu, ' ');
  if (revokedBy) body = body.replace(REVOKED_RE, ' ');
  const stop = body.search(/\b(?:O|A)\s+DIRETOR|\bCONSIDERANDO\b|\bRESOLVE\b/iu);
  const slice = (stop > 40 ? body.slice(0, stop) : body).replace(/\s+/g, ' ').trim();
  const ementa = clean(slice, 4000);
  return ementa.length >= 20 ? ementa : null;
}

function pdfUrlOf(html: string, extrato: boolean): string | null {
  const hrefs = [...html.matchAll(/https?:\/\/www\.policiapenal\.go\.gov\.br\/wp-content\/uploads\/[^"'\\\s>]+\.pdf/gi)].map((match) =>
    match[0].replace(/&amp;/g, '&'),
  );
  if (hrefs.length === 0) return null;
  const ranked = [...hrefs].sort((a, b) => {
    const aExtrato = /extrato/i.test(a) ? 1 : 0;
    const bExtrato = /extrato/i.test(b) ? 1 : 0;
    return extrato ? bExtrato - aExtrato : aExtrato - bExtrato;
  });
  return ranked[0] ?? null;
}

function categoryOf(categories: string[]): string | null {
  const useful = categories.filter((name) => !/^(atos normativos|sem categoria|uncategorized)$/iu.test(name.trim()));
  return useful[0]?.trim() || categories[0]?.trim() || null;
}

/** O link do próprio ato traz o número no endereço. Um link para outra portaria é só citação. */
function legislaIdOf(html: string, documentNumber: string | null): number | null {
  const links = [...html.matchAll(/pesquisa_ato_infralegal\/[a-z0-9_-]+\/(\d+)(?:\/([^"'?#\s]*))?/gi)];
  if (links.length === 0) return null;
  const number = documentNumber?.split('/')[0];
  if (number) {
    const owned = new RegExp(`(?:^|\\D)${Number(number)}(?:\\D|$)`);
    const own = links.find((link) => owned.test(decodeURIComponent(link[2] ?? '')));
    if (own) return Number(own[1]);
    return null;
  }
  return links.length === 1 ? Number(links[0]?.[1]) : null;
}

/** Lê uma publicação do site da Polícia Penal. Não baixa o arquivo. */
export function parseWpPost(post: WpPostInput): ParsedSiteAct {
  const title = clean(decodeWpText(post.title), 500);
  const text = decodeWpText(post.html);
  const documentType = documentTypeOf(title);
  const match = ACT_RE.exec(title) ?? ACT_RE.exec(text.slice(0, 400));
  const year = match?.[3] ?? match?.[6] ?? null;
  const documentNumber = match && year ? `${Number(match[2])}/${year}` : null;
  const revoked = REVOKED_RE.exec(text);
  const revokedBy = revoked ? clean(revoked[1] ?? '', 300) : null;
  const legislaId = legislaIdOf(post.html, documentNumber);
  const extrato = documentType === 'outro' && /^\s*extrato\b/iu.test(title);
  return {
    wpPostId: post.id,
    modified: post.modified,
    pageUrl: post.link,
    title: title || `Ato ${post.id}`,
    documentType,
    documentNumber,
    publicationDate: publicationDate(match?.[4], match?.[5], match?.[6]),
    description: ementaOf(text, title, revokedBy),
    legislaId,
    pdfUrl: pdfUrlOf(post.html, extrato),
    revokedBy,
    category: categoryOf(post.categories),
    fingerprint: `${post.modified}\n${post.html}`,
  };
}

const YEAR_ONLY_CITE = /portaria\s+n[ºo°.]*\s*\d{1,5}\s*,\s*de\s*20\d{2}(?!\d)/iu;
const FULL_DATE_CITE = /portaria\s+n[ºo°.]*\s*\d{1,5}\s*,?\s*de\s+\d{1,2}\s+de\s+[a-zçã]+\s+de\s+20\d{2}/iu;

/**
 * O resumo da página às vezes troca o número ("nº 44, de 2024").
 * A ementa já confirmada no PDF, com dia e mês, não é substituída por esse resumo.
 */
export function preferDescription(existing: string | null, incoming: string | null): string | null {
  if (!incoming) return existing;
  if (existing && FULL_DATE_CITE.test(existing) && YEAR_ONLY_CITE.test(incoming) && !FULL_DATE_CITE.test(incoming)) return existing;
  return incoming;
}

/**
 * Decide o que gravar quando a publicação chega em cima de um ato já cadastrado.
 * A revogação avisada no site permanece. A primeira indexação não é disparada daqui.
 */
export function decideSiteUpdate(existing: StoredSiteAct | null, act: ParsedSiteAct, contentHash: string): SiteActDecision {
  const source = act.legislaId ? 'legisla' : (existing?.source ?? 'site');
  const externalId = act.legislaId ?? existing?.externalId ?? act.wpPostId;
  const keepLegisla = existing?.fileKind === 'legisla' && !act.legislaId;
  const fileKind = act.legislaId ? 'legisla' : keepLegisla ? 'legisla' : act.pdfUrl ? 'pdf' : existing?.fileKind ?? null;
  const fileUrl = fileKind === 'pdf' ? act.pdfUrl ?? null : act.legislaId ? `https://legisla.casacivil.go.gov.br/pesquisa_ato_infralegal/dgpp/${act.legislaId}` : null;
  const revoked = Boolean(act.revokedBy) || existing?.validityStatus === 'revogado';
  const validityStatus: ValidityStatus = revoked ? 'revogado' : existing?.validityStatus === 'expirado' || existing?.validityStatus === 'substituido' ? existing.validityStatus : 'vigente';
  const indexed = existing?.status === 'ingerido' && !!existing.documentId;
  const pdfChanged = fileKind === 'pdf' && !!existing?.contentHash && existing.contentHash !== contentHash;
  return {
    source,
    externalId,
    fileKind,
    fileUrl,
    validityStatus,
    revokedBy: act.revokedBy ?? existing?.revokedBy ?? null,
    refresh: indexed && validityStatus !== 'revogado' && pdfChanged,
    revokeDocument: indexed && Boolean(act.revokedBy),
  };
}
