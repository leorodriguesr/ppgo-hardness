import type { DocumentType } from './domain';

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

const CITE_RE =
  /\b(portaria|resolu[cç][aã]o|instru[cç][aã]o normativa|decreto)\b(?:\s+[A-Za-z]{2,12})?(?:\s*n[ºo°.]*\s*)?(\d{1,5})\s*(?:\/\s*(\d{4})|(?:\s*,)?\s*de\s+(\d{1,2})\s+de\s+([a-zçã]+)\s+de\s+(\d{4})|,\s*de\s+(\d{4}))/giu;

const OWN_TITLE_RE =
  /^(?:portaria|resolu[cç][aã]o|instru[cç][aã]o normativa|decreto)\s+n[ºo°.]*\s*\d{1,5}\s*,?\s*(?:de\s+\d{1,2}\s+de\s+[a-zçã]+\s+de\s+\d{4}|de\s+[a-zçã]+\s+de\s+\d{4}|\/\s*\d{4})\s+/iu;

const SECOND_ACTION_RE = /\s+e\s+(?:designa|institui|nomeia|concede|cria|homologa|disp[oõ]e|autoriza|estabelece|declara|exonera|revoga|altera)\b/iu;

export type ActLinkKind = 'alteracao' | 'revogacao';

export interface ActRelationInput {
  source: 'legisla' | 'site';
  externalId: number;
  documentType: string;
  documentNumber: string | null;
  description: string | null;
  revokedBy: string | null;
  fileKind: 'legisla' | 'pdf' | null;
  validityStatus: string;
}

export interface ActRelationLink {
  parentSource: 'legisla' | 'site';
  parentExternalId: number;
  childSource: 'legisla' | 'site';
  childExternalId: number;
  kind: ActLinkKind;
  incorporated: boolean;
  origin: 'ementa' | 'revoked_by';
}

interface CitedAct {
  documentType: DocumentType;
  documentNumber: string;
}

/** Tira o título repetido no começo da ementa ("PORTARIA Nº 163, DE ... Altera..."). */
function operativeText(ementa: string): string {
  let text = ementa.trim().replace(/^[-–•]\s*/, '');
  text = text.replace(/^(?:portaria publicada no portal legisla[^.]*\.\s*)+/iu, '');
  text = text.replace(OWN_TITLE_RE, '');
  return text.trim();
}

/** A ementa só trata de mudar outro ato. "que designa" descreve o ato citado; "e designa" é outro assunto. */
export function amendmentOnly(ementa: string | null): boolean {
  const text = operativeText(ementa ?? '');
  if (!/^(?:altera|acrescenta|inclui|revoga\s+(?:o|a|os|as)\s+(?:anexo|art(?:igo)?|§))/iu.test(text)) return false;
  return !SECOND_ACTION_RE.test(text);
}

function documentTypeOf(word: string): DocumentType | null {
  const name = word.toLocaleLowerCase('pt-BR');
  if (name === 'portaria') return 'portaria';
  if (name.startsWith('resolu')) return 'resolucao';
  if (name.startsWith('instru')) return 'instrucao_normativa';
  if (name === 'decreto') return 'decreto';
  return null;
}

function yearOf(slashYear: string | undefined, day: string | undefined, monthName: string | undefined, year: string | undefined, yearOnly: string | undefined): string | null {
  if (slashYear) return slashYear;
  if (yearOnly) return yearOnly;
  if (!day || !monthName || !year) return null;
  const month = MONTHS[monthName.toLocaleLowerCase('pt-BR')];
  if (!month) return null;
  const iso = `${year}-${month}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(day)) return null;
  return year;
}

/** Trecho em que as citações são ação deste ato. O "que..." seguinte só descreve o ato citado. */
function relationText(ementa: string): string {
  const trimmed = operativeText(ementa);
  if (/^(?:altera|acrescenta|inclui|revoga)\b/iu.test(trimmed)) {
    const relative = trimmed.search(/\s+que\s+/iu);
    if (relative > 0) return trimmed.slice(0, relative);
  }
  return trimmed;
}

function citedActs(text: string): CitedAct[] {
  const found: CitedAct[] = [];
  for (const match of text.matchAll(CITE_RE)) {
    const documentType = documentTypeOf(match[1] ?? '');
    const year = yearOf(match[3], match[4], match[5], match[6], match[7]);
    if (!documentType || !year || !match[2]) continue;
    found.push({ documentType, documentNumber: `${Number(match[2])}/${year}` });
  }
  return found;
}

type Verb = 'altera' | 'revoga' | 'parcial';

function verbIn(gap: string): Verb | null {
  const window = gap.slice(-240);
  if (/revog[a-zà-ú]*\s+(?:o|a|os|as)\s+(?:anexo|art(?:igo)?\.?|§|par[aá]grafo|inciso|item|cap[ií]tulo|caput)\b/iu.test(window)) return 'parcial';
  const lower = window.toLocaleLowerCase('pt-BR');
  const revoga = lower.lastIndexOf('revog');
  const altera = Math.max(lower.lastIndexOf('alter'), lower.lastIndexOf('acrescent'), lower.lastIndexOf('inclu'));
  if (revoga < 0 && altera < 0) return null;
  return revoga > altera ? 'revoga' : 'altera';
}

interface DirectedCite extends CitedAct {
  kind: ActLinkKind;
}

function directedCites(text: string): DirectedCite[] {
  const cites: DirectedCite[] = [];
  let previous = 0;
  let inherited: Verb | null = null;
  for (const match of text.matchAll(CITE_RE)) {
    const documentType = documentTypeOf(match[1] ?? '');
    const year = yearOf(match[3], match[4], match[5], match[6], match[7]);
    const start = match.index ?? 0;
    const found = verbIn(text.slice(previous, start));
    const verb: Verb | null = found ?? inherited;
    previous = start + match[0].length;
    if (found) inherited = found;
    if (!documentType || !year || !match[2] || !verb) continue;
    cites.push({
      documentType,
      documentNumber: `${Number(match[2])}/${year}`,
      kind: verb === 'revoga' ? 'revogacao' : 'alteracao',
    });
  }
  return cites;
}

function rank(act: ActRelationInput): number {
  return (act.source === 'legisla' ? 4 : 0) + (act.fileKind === 'legisla' ? 2 : 0) + (act.validityStatus === 'vigente' ? 1 : 0);
}

function keyOf(source: string, externalId: number): string {
  return `${source}:${externalId}`;
}

/** Monta os vínculos a partir das ementas e da faixa "revogado por". Sem efeito colateral. */
export function buildActLinks(acts: ActRelationInput[]): ActRelationLink[] {
  const byNumber = new Map<string, ActRelationInput>();
  for (const act of acts) {
    if (!act.documentNumber) continue;
    const key = `${act.documentType}|${act.documentNumber}`;
    const current = byNumber.get(key);
    if (!current || rank(act) > rank(current)) byNumber.set(key, act);
  }

  const links = new Map<string, ActRelationLink>();
  const add = (parent: ActRelationInput, child: ActRelationInput, kind: ActLinkKind, origin: ActRelationLink['origin']) => {
    if (parent.source === child.source && parent.externalId === child.externalId) return;
    const id = `${parent.source}:${parent.externalId}>${child.source}:${child.externalId}:${kind}`;
    const existing = links.get(id);
    if (existing && existing.origin === 'ementa') return;
    links.set(id, {
      parentSource: parent.source,
      parentExternalId: parent.externalId,
      childSource: child.source,
      childExternalId: child.externalId,
      kind,
      incorporated: false,
      origin,
    });
  };

  for (const act of acts) {
    if (act.description) {
      for (const cite of directedCites(relationText(act.description))) {
        if (cite.documentNumber === act.documentNumber && cite.documentType === act.documentType) continue;
        const target = byNumber.get(`${cite.documentType}|${cite.documentNumber}`);
        if (!target) continue;
        if (cite.kind === 'revogacao') add(act, target, 'revogacao', 'ementa');
        else add(target, act, 'alteracao', 'ementa');
      }
    }
    if (act.revokedBy) {
      for (const cite of citedActs(act.revokedBy)) {
        const parent = byNumber.get(`${cite.documentType}|${cite.documentNumber}`);
        if (parent) add(parent, act, 'revogacao', 'revoked_by');
      }
    }
  }

  const alterations = new Map<string, ActRelationLink[]>();
  for (const link of links.values()) {
    if (link.kind !== 'alteracao') continue;
    const id = keyOf(link.childSource, link.childExternalId);
    const group = alterations.get(id) ?? [];
    group.push(link);
    alterations.set(id, group);
  }
  const byIdentity = new Map(acts.map((act) => [keyOf(act.source, act.externalId), act]));
  for (const [childId, group] of alterations) {
    if (group.length !== 1) continue;
    const link = group[0];
    if (!link) continue;
    const child = byIdentity.get(childId);
    const parent = byIdentity.get(keyOf(link.parentSource, link.parentExternalId));
    if (!child || !parent) continue;
    if (child.validityStatus === 'revogado' || parent.fileKind !== 'legisla') continue;
    if (!amendmentOnly(child.description)) continue;
    link.incorporated = true;
  }

  return [...links.values()];
}
