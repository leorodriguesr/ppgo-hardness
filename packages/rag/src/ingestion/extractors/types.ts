import type { FileFormat } from '@rag/shared';

export type LineKind = 'text' | 'heading' | 'table';

export interface ExtractedLine {
  text: string;
  kind: LineKind;
  /** Nível do título (1 = mais alto), quando conhecido. */
  level?: number;
  fontSize?: number;
}

export interface ExtractedPage {
  pageNumber: number;
  lines: ExtractedLine[];
  ocr: boolean;
  ocrConfidence: number | null;
  /** Página sem texto utilizável na camada digital (provavelmente digitalizada). */
  needsOcr: boolean;
  /** A camada de texto existe, mas é ilegível (fonte com codificação própria, sem mapa Unicode). */
  unreadableTextLayer?: boolean;
}

export interface ExtractedDocument {
  format: FileFormat;
  /** PDFs têm páginas reais; DOCX/TXT/MD são tratados como uma única página lógica. */
  paginated: boolean;
  pages: ExtractedPage[];
  warnings: string[];
}

export interface ExtractOptions {
  /** Mínimo de caracteres alfanuméricos para considerar a página com texto utilizável. */
  minCharsPerPage: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

export interface Extractor {
  readonly formats: FileFormat[];
  extract(data: Buffer, opts: ExtractOptions): Promise<ExtractedDocument>;
}

export function usableChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/** Proporção de vogais entre as letras (sem acentos). Texto em português fica perto de 0,46. */
export function vowelRatio(text: string): { ratio: number; letters: number } {
  const letters = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z]/g) ?? [];
  if (letters.length === 0) return { ratio: 0, letters: 0 };
  return { ratio: letters.filter((c) => 'aeiou'.includes(c)).length / letters.length, letters: letters.length };
}

/**
 * Detecta camada de texto ilegível: há letras, mas a proporção de vogais é incompatível com o português
 * (ex.: fontes embutidas sem mapa Unicode, que produzem "3URFHGLPHQWR" no lugar de "Procedimento").
 */
export function isUnreadableText(text: string): boolean {
  const { ratio, letters } = vowelRatio(text);
  return letters >= 30 && ratio < 0.3;
}

export function pageText(page: ExtractedPage): string {
  return page.lines.map((l) => l.text).join('\n');
}
