import type { FileFormat } from '@rag/shared';
import type { ExtractedDocument, ExtractedLine, ExtractOptions, Extractor } from './types';
import { usableChars } from './types';

function decode(data: Buffer): string {
  let text = new TextDecoder('utf-8').decode(data);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

/** Markdown: títulos ATX (#), tabelas GFM e parágrafos. Blocos de código são mantidos como texto. */
export function markdownToLines(md: string): ExtractedLine[] {
  const lines: ExtractedLine[] = [];
  let inFence = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (line.trim()) lines.push({ text: line, kind: 'text' });
      continue;
    }
    if (!line.trim()) {
      lines.push({ text: '', kind: 'text' });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      lines.push({ text: heading[2]!, kind: 'heading', level: heading[1]!.length });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // separador
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      lines.push({ text: cells.join(' | '), kind: 'table' });
      continue;
    }
    const text = line
      .replace(/^\s*[-*+]\s+/, '- ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/<[^>]+>/g, '');
    lines.push({ text: text.trim(), kind: 'text' });
  }
  return lines;
}

/** Texto puro: linhas em caixa alta curtas e marcadores como CAPÍTULO/TÍTULO viram títulos. */
export function plainTextToLines(text: string): ExtractedLine[] {
  return text.split('\n').map((raw) => {
    const line = raw.trim();
    const letters = line.replace(/[^\p{L}]/gu, '');
    const caps = letters.length >= 4 && line.length <= 140 && letters === letters.toLocaleUpperCase('pt-BR');
    if (line && caps && !/[;,]$/.test(line)) return { text: line, kind: 'heading' as const, level: 2 };
    return { text: line, kind: 'text' as const };
  });
}

export class TextExtractor implements Extractor {
  readonly formats: FileFormat[] = ['txt', 'md'];

  constructor(private readonly format: 'txt' | 'md') {}

  async extract(data: Buffer, opts: ExtractOptions): Promise<ExtractedDocument> {
    const text = decode(data);
    const lines = this.format === 'md' ? markdownToLines(text) : plainTextToLines(text);
    await opts.onProgress?.(1, 1);
    const chars = usableChars(text);
    return {
      format: this.format,
      paginated: false,
      pages: [{ pageNumber: 1, lines, ocr: false, ocrConfidence: null, needsOcr: false }],
      warnings: chars < opts.minCharsPerPage ? ['no_usable_text'] : [],
    };
  }
}
