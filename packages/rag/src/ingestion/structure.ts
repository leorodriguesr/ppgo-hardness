import type { ExtractedPage, LineKind } from './extractors/types';
import { joinWrappedLines } from './normalization';

export type ElementType = 'heading' | 'article' | 'paragraph_sign' | 'inciso' | 'alinea' | 'item' | 'text' | 'table';

export interface StructElement {
  type: ElementType;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  /** Rótulo estrutural: "Art. 12", "§ 1º", "Parágrafo único", "IV", "a)". */
  label?: string;
  /** Nível hierárquico para títulos (1 = TÍTULO/H1 ... ). */
  level?: number;
}

export interface StructUnit {
  kind: 'article' | 'section';
  headingPath: string[];
  sectionTitle: string | null;
  structuralRef: string | null;
  elements: StructElement[];
}

const ROMAN = '[IVXLCDM]+';

export const LEGAL_PATTERNS = {
  titulo: new RegExp(`^T[IÍ]TULO\\s+(${ROMAN}|\\d+)\\b`, 'i'),
  capitulo: new RegExp(`^CAP[IÍ]TULO\\s+(${ROMAN}|\\d+)\\b`, 'i'),
  secao: new RegExp(`^SE[CÇ][AÃ]O\\s+(${ROMAN}|\\d+)\\b`, 'i'),
  subsecao: new RegExp(`^SUBSE[CÇ][AÃ]O\\s+(${ROMAN}|\\d+)\\b`, 'i'),
  anexo: /^ANEXO(\s+([IVXLCDM]+|\d+|[A-Z]))?\b/,
  artigo: /^(?:Art\.?|Artigo)\s*(\d+(?:\.\d+)?)\s*(?:[º°o](?=[\s.\-–—]|$))?\s*[A-Z]?\s*[.\-–—:]?\s*/,
  paragrafo: /^(?:§\s*(\d+)\s*[º°o]?|Par[aá]grafo\s+[uú]nico)\s*[.\-–—:]?\s*/i,
  inciso: new RegExp(`^(${ROMAN})\\s*[-–—]\\s+`),
  alinea: /^([a-z])\)\s+/,
  item: /^(\d{1,2}(?:\.\d{1,2}){0,3})[.)]\s+(?=\S)/,
} as const;

const HEADING_LEVEL: Record<string, number> = { titulo: 1, anexo: 1, capitulo: 2, secao: 3, subsecao: 4 };

/**
 * Seções que se repetem em cada procedimento do POP. Ficam abaixo do nome do
 * procedimento para que "MATERIAL NECESSÁRIO" não apague "4.5 Revista em estruturas".
 */
const POP_SECTION = /^(material necess[aá]rio|atividades cr[ií]ticas|sequ[eê]ncia das a[cç][oõ]es(?:\s+de\s+[\p{L}\s]{0,60})?|fundamenta[cç][aã]o legal|resultados esperados|a[cç][oõ]es corretivas|possibilidades? de erros?)$/iu;

/**
 * Reconhece o título de um procedimento e as seções padronizadas do POP.
 * O número de segmentos (4.5 contra 4.4.1) define o nível, para o subtítulo
 * não substituir o procedimento pai.
 */
export function classifyProcedureHeading(text: string): { level: number; label: string } | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length === 0 || t.length > 140 || /p[aá]g\.?\s*\d/i.test(t) || /\.{3,}/.test(t)) return null;
  if (/^procedimento operacional padr[aã]o\s+n[º°o.]?\s*\d+\b/iu.test(t)) return { level: 2, label: t.slice(0, 200) };
  const numbered = /^(\d{1,2}(?:\.\d{1,2})+)\.?\s+\p{Lu}/u.exec(t);
  if (numbered && !/[.;,]$/.test(t) && t.split(/\s+/).length <= 16) {
    const depth = numbered[1]!.split('.').length;
    return { level: depth >= 3 ? 4 : 3, label: t.slice(0, 200) };
  }
  if (POP_SECTION.test(t)) return { level: 5, label: t.slice(0, 200) };
  return null;
}

export function classifyLegalLine(text: string): { type: ElementType; label?: string; level?: number } | null {
  for (const key of ['titulo', 'capitulo', 'subsecao', 'secao', 'anexo'] as const) {
    const m = LEGAL_PATTERNS[key].exec(text);
    if (m && text.length <= 200) return { type: 'heading', label: m[0].trim(), level: HEADING_LEVEL[key] };
  }
  let m = LEGAL_PATTERNS.artigo.exec(text);
  if (m) return { type: 'article', label: `Art. ${m[1]}` };
  m = LEGAL_PATTERNS.paragrafo.exec(text);
  if (m) return { type: 'paragraph_sign', label: m[1] ? `§ ${m[1]}º` : 'Parágrafo único' };
  m = LEGAL_PATTERNS.inciso.exec(text);
  if (m) return { type: 'inciso', label: m[1] };
  m = LEGAL_PATTERNS.alinea.exec(text);
  if (m) return { type: 'alinea', label: `${m[1]})` };
  m = LEGAL_PATTERNS.item.exec(text);
  if (m) return { type: 'item', label: m[1] };
  return null;
}

interface PendingBlock {
  type: ElementType;
  lines: string[];
  pageStart: number | null;
  pageEnd: number | null;
  label?: string;
  level?: number;
}

/**
 * Converte linhas extraídas em elementos estruturais, unindo linhas quebradas do mesmo
 * parágrafo e iniciando novos elementos em marcadores normativos, títulos e tabelas.
 */
/**
 * Tabela em texto: a primeira linha é mantida como cabeçalho e cada linha seguinte recebe
 * os rótulos das colunas ("Função: Revista em celas; Substituição: A cada 6 meses"), de modo
 * que cada linha preserve o significado mesmo isolada (busca, chunking e prompt).
 * Linhas com número de colunas diferente do cabeçalho são mantidas como estão.
 */
export function linearizeTable(lines: string[]): string {
  const rows = lines.map((l) => l.split('|').map((c) => c.trim()));
  const header = rows[0];
  if (!header || header.length < 2 || rows.length < 2 || header.some((h) => h.length === 0 || h.length > 60)) return lines.join('\n');
  const out = [lines[0]!];
  for (const [i, row] of rows.slice(1).entries()) {
    out.push(row.length === header.length ? row.map((cell, c) => `${header[c]}: ${cell}`).join('; ') : lines[i + 1]!);
  }
  return out.join('\n');
}

export function parseElements(pages: ExtractedPage[], paginated: boolean): StructElement[] {
  const elements: StructElement[] = [];
  const state: { current: PendingBlock | null } = { current: null };

  const flush = () => {
    const current = state.current;
    if (!current) return;
    const text = current.type === 'table' ? linearizeTable(current.lines) : joinWrappedLines(current.lines);
    if (text.trim()) {
      elements.push({
        type: current.type,
        text: text.trim(),
        pageStart: current.pageStart,
        pageEnd: current.pageEnd,
        label: current.label,
        level: current.level,
      });
    }
    state.current = null;
  };

  const start = (type: ElementType, line: string, page: number | null, extra: { label?: string; level?: number } = {}) => {
    flush();
    state.current = { type, lines: [line], pageStart: page, pageEnd: page, ...extra };
  };

  for (const page of pages) {
    const pageNo = paginated ? page.pageNumber : null;
    for (const line of page.lines) {
      const text = line.text;
      if (!text) {
        if (state.current?.type !== 'table') flush();
        continue;
      }
      const procedure = classifyProcedureHeading(text);
      if (procedure) {
        start('heading', text, pageNo, { label: procedure.label, level: procedure.level });
        continue;
      }
      let legal = classifyLegalLine(text);
      const kind: LineKind = line.kind;
      // Título explícito (ex.: "## 1. Objetivo" em Markdown) prevalece sobre itens numerados
      if (kind === 'heading' && legal && (legal.type === 'item' || legal.type === 'inciso' || legal.type === 'alinea')) legal = null;
      const pending = state.current as PendingBlock | null;
      // Nome da seção/capítulo na linha seguinte ao marcador ("Seção I" + "Da instauração")
      if (
        !legal &&
        pending?.type === 'heading' &&
        pending.label &&
        pending.lines.length === 1 &&
        (kind === 'heading' || (text.length <= 80 && text.split(/\s+/).length <= 10)) &&
        /^[\p{Lu}]/u.test(text) &&
        !/[.;:,]$/.test(text)
      ) {
        pending.lines.push(text);
        pending.pageEnd = pageNo;
        continue;
      }
      if (legal?.type === 'heading') {
        // "CAPÍTULO II" seguido de linha com o nome do capítulo: unidos no mesmo título.
        start('heading', text, pageNo, { label: legal.label, level: legal.level });
        continue;
      }
      if (legal) {
        start(legal.type, text, pageNo, { label: legal.label });
        continue;
      }
      if (kind === 'table') {
        if (state.current?.type === 'table') {
          state.current.lines.push(text);
          state.current.pageEnd = pageNo;
        } else start('table', text, pageNo);
        continue;
      }
      if (kind === 'heading') {
        const cur = state.current as PendingBlock | null;
        // Nome do capítulo/seção em linha seguinte ao marcador
        if (cur?.type === 'heading' && cur.label && cur.lines.length === 1 && text.length <= 160) {
          cur.lines.push(text);
          cur.pageEnd = pageNo;
          continue;
        }
        start('heading', text, pageNo, { level: line.level ?? 3 });
        continue;
      }
      const cur = state.current as PendingBlock | null;
      if (cur && cur.type !== 'heading' && cur.type !== 'table') {
        const prev = cur.lines[cur.lines.length - 1] ?? '';
        const sentenceEnded = /[.:;!?]["”)]?$/.test(prev);
        const startsNew = /^[\p{Lu}"“(]/u.test(text);
        // Parágrafos de texto corrido terminam em pontuação final seguida de linha iniciando em maiúscula,
        // exceto dentro de dispositivos normativos (artigo/parágrafo/inciso), que só terminam no próximo marcador.
        if (cur.type === 'text' && sentenceEnded && startsNew && prev.length < 60) {
          start('text', text, pageNo);
        } else {
          cur.lines.push(text);
          cur.pageEnd = pageNo;
        }
        continue;
      }
      start('text', text, pageNo);
    }
    // Quebra de página não encerra elementos: artigos frequentemente continuam na página seguinte.
  }
  flush();
  return elements;
}

function headingText(el: StructElement): string {
  return el.text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Agrupa elementos em unidades semânticas:
 * - cada artigo forma uma unidade com seus parágrafos, incisos e alíneas;
 * - conteúdo fora de artigos forma unidades de seção delimitadas por títulos.
 * Mantém o caminho hierárquico de títulos (Título › Capítulo › Seção).
 */
export function buildUnits(elements: StructElement[]): StructUnit[] {
  const units: StructUnit[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: StructUnit | null = null;

  const path = () => stack.map((s) => s.text);
  const push = () => {
    if (current && current.elements.length > 0) units.push(current);
    current = null;
  };

  for (const el of elements) {
    if (el.type === 'heading') {
      push();
      const text = headingText(el);
      const recognized = classifyProcedureHeading(text);
      const insideProcedure = stack.some((s) => /^procedimento operacional padr[aã]o\s+n/i.test(s.text));
      // Ruído de OCR ("OMAN AN") e seções não previstas não podem apagar o procedimento aberto.
      // Um título numerado ou um novo "Procedimento nº" continua substituindo o anterior.
      const level = recognized && recognized.level < 5 ? recognized.level : insideProcedure ? 5 : (recognized?.level ?? el.level ?? 3);
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text });
      continue;
    }
    if (el.type === 'article') {
      push();
      current = {
        kind: 'article',
        headingPath: path(),
        sectionTitle: stack[stack.length - 1]?.text ?? null,
        structuralRef: el.label ?? null,
        elements: [el],
      };
      continue;
    }
    if (current) {
      current.elements.push(el);
      continue;
    }
    current = {
      kind: 'section',
      headingPath: path(),
      sectionTitle: stack[stack.length - 1]?.text ?? null,
      structuralRef: null,
      elements: [el],
    };
  }
  push();
  return units;
}
