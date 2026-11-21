import mammoth from 'mammoth';
import { AppError } from '@rag/shared';
import type { ExtractedDocument, ExtractedLine, ExtractOptions, Extractor } from './types';
import { usableChars } from './types';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (html: string) => decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * Converte o HTML semântico do mammoth (h1–h6, p, li, table) em linhas estruturadas.
 * O HTML é gerado pelo mammoth a partir do XML do Word, não pelo usuário, e nunca é renderizado.
 */
export function htmlToLines(html: string): ExtractedLine[] {
  const lines: ExtractedLine[] = [];
  const blockRe = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html))) {
    const tag = m[1]!.toLowerCase();
    const inner = m[2]!;
    if (tag === 'table') {
      const rows = inner.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
      for (const row of rows) {
        const cells = (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(stripTags);
        if (cells.some((c) => c.length > 0)) lines.push({ text: cells.join(' | '), kind: 'table' });
      }
      continue;
    }
    const text = stripTags(inner);
    if (!text) continue;
    if (tag.startsWith('h')) lines.push({ text, kind: 'heading', level: Number(tag[1]) });
    else lines.push({ text, kind: 'text' });
  }
  return lines;
}

export class DocxExtractor implements Extractor {
  readonly formats = ['docx' as const];

  async extract(data: Buffer, opts: ExtractOptions): Promise<ExtractedDocument> {
    let html: string;
    const warnings: string[] = [];
    try {
      const result = await mammoth.convertToHtml(
        { buffer: data },
        {
          convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
          styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
        },
      );
      html = result.value;
      if (result.messages.some((msg) => msg.type === 'warning')) warnings.push('docx_conversion_warnings');
    } catch (err) {
      throw new AppError('PROCESSING_ERROR', 'DOCX corrompido ou ilegível', undefined, { cause: err });
    }
    const lines = htmlToLines(html);
    await opts.onProgress?.(1, 1);
    const chars = usableChars(lines.map((l) => l.text).join(' '));
    return {
      format: 'docx',
      paginated: false,
      pages: [{ pageNumber: 1, lines, ocr: false, ocrConfidence: null, needsOcr: false }],
      warnings: chars < opts.minCharsPerPage ? [...warnings, 'no_usable_text'] : warnings,
    };
  }
}
