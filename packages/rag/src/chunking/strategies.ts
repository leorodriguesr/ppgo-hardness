import { countTokens, truncateToTokens } from '@rag/ai';
import type { ChunkingSettings } from '@rag/shared';
import type { StructElement, StructUnit } from '../ingestion/structure';
import { recursiveSplit, splitSentences } from './text-split';
import type { Chunker, ChunkingInput, DraftChunk } from './types';

export interface Piece {
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  tokens: number;
  unit?: StructUnit;
}

const minPage = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
const maxPage = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));

function piece(text: string, pageStart: number | null, pageEnd: number | null, unit?: StructUnit): Piece {
  return { text, pageStart, pageEnd, tokens: countTokens(text), unit };
}

/** Divide um elemento grande em pedaços menores (tabelas repetem o cabeçalho). */
function elementPieces(el: StructElement, maxTokens: number, unit?: StructUnit): Piece[] {
  const p = piece(el.text, el.pageStart, el.pageEnd, unit);
  if (p.tokens <= maxTokens) return [p];
  if (el.type === 'table') {
    const rows = el.text.split('\n');
    const header = rows[0] ?? '';
    const out: Piece[] = [];
    let current: string[] = [header];
    for (const row of rows.slice(1)) {
      if (countTokens([...current, row].join('\n')) > maxTokens && current.length > 1) {
        out.push(piece(current.join('\n'), el.pageStart, el.pageEnd, unit));
        current = [header];
      }
      current.push(row);
    }
    if (current.length > 1) out.push(piece(current.join('\n'), el.pageStart, el.pageEnd, unit));
    return out;
  }
  return recursiveSplit(el.text, maxTokens).map((t) => piece(t, el.pageStart, el.pageEnd, unit));
}

/** Empacota pedaços em grupos de até maxTokens, com sobreposição opcional, preservando páginas. */
export function packWithPages(pieces: Piece[], maxTokens: number, overlapTokens: number, joiner = '\n'): Piece[][] {
  const groups: Piece[][] = [];
  let current: Piece[] = [];
  let tokens = 0;
  for (const p of pieces) {
    if (current.length > 0 && tokens + p.tokens > maxTokens) {
      groups.push(current);
      const overlap: Piece[] = [];
      let ot = 0;
      for (let j = current.length - 1; j >= 0 && overlapTokens > 0; j--) {
        if (ot + current[j]!.tokens > overlapTokens) break;
        overlap.unshift(current[j]!);
        ot += current[j]!.tokens;
      }
      // Sobreposição nunca pode, sozinha, impedir progresso
      current = overlap.length === current.length ? [] : overlap;
      tokens = current.reduce((s, x) => s + x.tokens, 0);
    }
    current.push(p);
    tokens += p.tokens + (current.length > 1 ? countTokens(joiner) : 0);
  }
  if (current.length) groups.push(current);
  return groups;
}

function groupToDraft(group: Piece[], meta: Omit<DraftChunk, 'content' | 'pageStart' | 'pageEnd'>, joiner = '\n'): DraftChunk {
  let ps: number | null = null;
  let pe: number | null = null;
  for (const p of group) {
    ps = minPage(ps, p.pageStart);
    pe = maxPage(pe, p.pageEnd);
  }
  return { ...meta, content: group.map((p) => p.text).join(joiner), pageStart: ps, pageEnd: pe };
}

/**
 * Estratégia estrutural: artigos (com parágrafos, incisos e alíneas) são unidades atômicas.
 * Artigos que excedem o limite são divididos nos limites de dispositivos, e cada continuação
 * carrega o caput como nota de contexto, preservando a interpretação.
 */
export class StructuralChunker implements Chunker {
  readonly strategy = 'structural' as const;

  async chunk({ units, settings }: ChunkingInput): Promise<DraftChunk[]> {
    const drafts: DraftChunk[] = [];
    for (const unit of units) {
      const base = {
        headingPath: unit.headingPath,
        sectionTitle: unit.sectionTitle,
        structuralRef: unit.structuralRef,
        flags: [] as string[],
      };
      const pieces = unit.elements.flatMap((el) => elementPieces(el, settings.maxTokens, unit));
      const total = pieces.reduce((s, p) => s + p.tokens, 0);
      if (total <= settings.maxTokens) {
        drafts.push(groupToDraft(pieces, base));
        continue;
      }
      const overlap = unit.kind === 'article' ? 0 : settings.overlapTokens;
      const groups = packWithPages(pieces, settings.maxTokens, overlap);
      const caput = unit.kind === 'article' ? truncateToTokens(unit.elements[0]!.text, 80) : null;
      groups.forEach((g, i) => {
        const flags = unit.kind === 'article' ? ['article_split'] : ['section_split'];
        const contextNote = i > 0 && caput ? `Continuação do ${unit.structuralRef}. Caput: ${caput}` : undefined;
        drafts.push(groupToDraft(g, { ...base, flags, contextNote }));
      });
    }
    return mergeSmall(drafts, settings);
  }
}

/** Junta chunks pequenos consecutivos da mesma seção, quando o resultado cabe no limite. */
export function mergeSmall(drafts: DraftChunk[], settings: ChunkingSettings): DraftChunk[] {
  const out: DraftChunk[] = [];
  for (const d of drafts) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.headingPath.join('›') === d.headingPath.join('›') &&
      !prev.flags.includes('article_split') &&
      !d.flags.includes('article_split') &&
      (countTokens(prev.content) < settings.minTokens || countTokens(d.content) < settings.minTokens) &&
      countTokens(prev.content) + countTokens(d.content) <= Math.max(settings.minTokens * 3, Math.floor(settings.maxTokens / 2))
    ) {
      prev.content = `${prev.content}\n${d.content}`;
      prev.pageStart = minPage(prev.pageStart, d.pageStart);
      prev.pageEnd = maxPage(prev.pageEnd, d.pageEnd);
      if (d.structuralRef && prev.structuralRef !== d.structuralRef) {
        prev.structuralRef = prev.structuralRef ? `${prev.structuralRef.split(' a ')[0]} a ${d.structuralRef}` : d.structuralRef;
      }
      if (!prev.flags.includes('merged')) prev.flags.push('merged');
      continue;
    }
    out.push({ ...d, flags: [...d.flags] });
  }
  return out;
}

/** Estratégia recursiva: ignora a estrutura normativa e empacota parágrafos/sentenças com overlap. */
export class RecursiveChunker implements Chunker {
  readonly strategy = 'recursive' as const;

  async chunk({ units, settings }: ChunkingInput): Promise<DraftChunk[]> {
    const pieces = units.flatMap((u) => u.elements.flatMap((el) => elementPieces(el, settings.maxTokens, u)));
    return packWithPages(pieces, settings.maxTokens, settings.overlapTokens).map((g) => {
      const unit = g[0]!.unit;
      return groupToDraft(g, {
        headingPath: unit?.headingPath ?? [],
        sectionTitle: unit?.sectionTitle ?? null,
        structuralRef: null,
        flags: [],
      });
    });
  }
}

/** Estratégia fixa (linha de base): janelas de tokens sobre o texto corrido, sem respeitar estrutura. */
export class FixedChunker implements Chunker {
  readonly strategy = 'fixed' as const;

  async chunk({ elements, settings }: ChunkingInput): Promise<DraftChunk[]> {
    const words: Piece[] = [];
    for (const el of elements) {
      for (const w of el.text.split(/\s+/).filter(Boolean)) {
        words.push({ text: w, pageStart: el.pageStart, pageEnd: el.pageEnd, tokens: countTokens(` ${w}`) });
      }
    }
    return packWithPages(words, settings.maxTokens, settings.overlapTokens, ' ').map((g) =>
      groupToDraft(g, { headingPath: [], sectionTitle: null, structuralRef: null, flags: [] }, ' '),
    );
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Estratégia semântica: divide onde a similaridade entre sentenças consecutivas cai abaixo
 * do percentil configurado (padrão 20%), respeitando o limite de tokens e as fronteiras de seção.
 * Custo: um embedding por sentença na ingestão.
 */
export class SemanticChunker implements Chunker {
  readonly strategy = 'semantic' as const;

  constructor(private readonly breakpointPercentile = 20) {}

  async chunk({ units, settings, embed }: ChunkingInput): Promise<DraftChunk[]> {
    if (!embed) throw new Error('Chunking semântico requer função de embedding');
    const drafts: DraftChunk[] = [];
    for (const unit of units) {
      const sentences: Piece[] = unit.elements.flatMap((el) =>
        (el.type === 'table' ? [el.text] : splitSentences(el.text)).flatMap((s) =>
          elementPieces({ ...el, text: s }, settings.maxTokens, unit),
        ),
      );
      if (sentences.length === 0) continue;
      const base = { headingPath: unit.headingPath, sectionTitle: unit.sectionTitle, structuralRef: unit.structuralRef, flags: [] as string[] };
      if (sentences.length === 1) {
        drafts.push(groupToDraft(sentences, base, ' '));
        continue;
      }
      const vectors: number[][] = [];
      for (let i = 0; i < sentences.length; i += 64) vectors.push(...(await embed(sentences.slice(i, i + 64).map((s) => s.text))));
      const sims = sentences.slice(1).map((_, i) => cosine(vectors[i]!, vectors[i + 1]!));
      const sorted = [...sims].sort((a, b) => a - b);
      const threshold = sorted[Math.floor((sorted.length - 1) * (this.breakpointPercentile / 100))] ?? -1;
      let group: Piece[] = [sentences[0]!];
      let tokens = sentences[0]!.tokens;
      for (let i = 1; i < sentences.length; i++) {
        const s = sentences[i]!;
        const breakHere = (sims[i - 1]! <= threshold && tokens >= settings.minTokens) || tokens + s.tokens > settings.maxTokens;
        if (breakHere) {
          drafts.push(groupToDraft(group, base, ' '));
          group = [];
          tokens = 0;
        }
        group.push(s);
        tokens += s.tokens;
      }
      if (group.length) drafts.push(groupToDraft(group, base, ' '));
    }
    return mergeSmall(drafts, settings);
  }
}

export function createChunker(strategy: ChunkingSettings['strategy']): Chunker {
  switch (strategy) {
    case 'structural':
      return new StructuralChunker();
    case 'recursive':
      return new RecursiveChunker();
    case 'fixed':
      return new FixedChunker();
    case 'semantic':
      return new SemanticChunker();
  }
}
