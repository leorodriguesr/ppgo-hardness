import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '@rag/shared';
import type { ExtractedDocument, ExtractedLine, ExtractedPage, ExtractOptions, Extractor } from './types';
import { isUnreadableText, usableChars } from './types';

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

interface RawLine {
  y: number;
  items: TextItem[];
}

const require = createRequire(import.meta.url);
let standardFontDataUrl: string | undefined;
function fontDataUrl(): string {
  if (!standardFontDataUrl) {
    const pkg = dirname(require.resolve('pdfjs-dist/package.json'));
    standardFontDataUrl = pathToFileURL(join(pkg, 'standard_fonts') + '/').href;
  }
  return standardFontDataUrl;
}

/** Agrupa itens de texto em linhas pela coordenada vertical. */
export function groupLines(items: TextItem[]): RawLine[] {
  const sorted = items
    .filter((i) => i.str.length > 0)
    .sort((a, b) => b.transform[5]! - a.transform[5]! || a.transform[4]! - b.transform[4]!);
  const lines: RawLine[] = [];
  for (const item of sorted) {
    const y = item.transform[5]!;
    const size = Math.abs(item.transform[3]!) || item.height || 10;
    const line = lines.find((l) => Math.abs(l.y - y) <= size * 0.45);
    if (line) line.items.push(item);
    else lines.push({ y, items: [item] });
  }
  for (const l of lines) l.items.sort((a, b) => a.transform[4]! - b.transform[4]!);
  return lines.sort((a, b) => b.y - a.y);
}

/** Converte uma linha em texto; lacunas horizontais grandes indicam colunas de tabela. */
export function renderLine(line: RawLine): { text: string; columns: number; fontSize: number } {
  let text = '';
  let columns = 1;
  let prevEnd: number | null = null;
  let fontSize = 0;
  for (const item of line.items) {
    // O pdfjs insere itens de espaço cuja largura é a própria lacuna; a lacuna real é medida
    // entre itens com texto, para que colunas de tabela não sejam confundidas com espaços.
    if (item.str.trim() === '') continue;
    const x = item.transform[4]!;
    const size = Math.abs(item.transform[3]!) || item.height || 10;
    fontSize = Math.max(fontSize, size);
    if (prevEnd !== null) {
      const gap = x - prevEnd;
      if (gap > size * 2.5) {
        text += ' | ';
        columns++;
      } else if (gap > size * 0.15 && !text.endsWith(' ') && !item.str.startsWith(' ')) {
        text += ' ';
      }
    }
    text += item.str;
    prevEnd = x + item.width;
  }
  return { text: text.replace(/\s+/g, ' ').trim(), columns, fontSize };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function isAllCapsHeading(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 4 && text.length <= 140 && letters === letters.toLocaleUpperCase('pt-BR') && !/[;,]$/.test(text);
}

export class PdfExtractor implements Extractor {
  readonly formats = ['pdf' as const];

  async extract(data: Buffer, opts: ExtractOptions): Promise<ExtractedDocument> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(data),
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      standardFontDataUrl: fontDataUrl(),
      verbosity: 0,
    });
    try {
      let pdf;
      try {
        pdf = await task.promise;
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === 'PasswordException') throw new AppError('PROCESSING_ERROR', 'PDF protegido por senha não é suportado');
        throw new AppError('PROCESSING_ERROR', 'PDF corrompido ou ilegível', undefined, { cause: err });
      }
      const total = pdf.numPages;
      const rawPages: { pageNumber: number; lines: { text: string; columns: number; fontSize: number }[] }[] = [];
      for (let n = 1; n <= total; n++) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const items = content.items.filter((i) => 'str' in i) as unknown as TextItem[];
        rawPages.push({ pageNumber: n, lines: groupLines(items).map(renderLine).filter((l) => l.text.length > 0) });
        page.cleanup();
        await opts.onProgress?.(n, total);
      }

      const bodySize = median(rawPages.flatMap((p) => p.lines.map((l) => l.fontSize)));
      const pages: ExtractedPage[] = rawPages.map((p) => {
        const lines: ExtractedLine[] = p.lines.map((l, idx) => {
          const prev = p.lines[idx - 1];
          const next = p.lines[idx + 1];
          const tableRow = l.columns >= 3 || (l.columns === 2 && ((prev?.columns ?? 1) >= 2 || (next?.columns ?? 1) >= 2));
          if (tableRow) return { text: l.text, kind: 'table', fontSize: l.fontSize };
          const ratio = bodySize > 0 ? l.fontSize / bodySize : 1;
          const larger = ratio >= 1.08 && l.text.length <= 160 && !/[.;,]$/.test(l.text);
          if (larger || isAllCapsHeading(l.text)) {
            return { text: l.text, kind: 'heading', level: ratio >= 1.25 ? 1 : 2, fontSize: l.fontSize };
          }
          return { text: l.text, kind: 'text', fontSize: l.fontSize };
        });
        const text = lines.map((l) => l.text).join(' ');
        const unreadableTextLayer = isUnreadableText(text);
        return {
          pageNumber: p.pageNumber,
          lines,
          ocr: false,
          ocrConfidence: null,
          needsOcr: unreadableTextLayer || usableChars(text) < opts.minCharsPerPage,
          unreadableTextLayer,
        };
      });
      return { format: 'pdf', paginated: true, pages, warnings: [] };
    } finally {
      await task.destroy();
    }
  }
}
