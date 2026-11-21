import type { FileFormat } from '@rag/shared';
import { DocxExtractor } from './docx';
import { PdfExtractor } from './pdf';
import { TextExtractor } from './text';
import type { Extractor } from './types';

/**
 * Registro de extratores por formato. Novos formatos (ex.: ODT, HTML) são adicionados
 * implementando `Extractor` e registrando aqui, sem alterar o pipeline.
 */
export class ExtractorRegistry {
  private readonly map = new Map<FileFormat, Extractor>();

  register(format: FileFormat, extractor: Extractor): this {
    this.map.set(format, extractor);
    return this;
  }

  get(format: FileFormat): Extractor {
    const e = this.map.get(format);
    if (!e) throw new Error(`Nenhum extrator registrado para ${format}`);
    return e;
  }
}

export function defaultExtractors(): ExtractorRegistry {
  return new ExtractorRegistry()
    .register('pdf', new PdfExtractor())
    .register('docx', new DocxExtractor())
    .register('txt', new TextExtractor('txt'))
    .register('md', new TextExtractor('md'));
}

export * from './types';
export { PdfExtractor } from './pdf';
export { DocxExtractor, htmlToLines } from './docx';
export { TextExtractor, markdownToLines, plainTextToLines } from './text';
