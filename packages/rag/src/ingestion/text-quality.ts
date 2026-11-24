import { plainTextToLines } from './extractors/text';
import { isUnreadableText, pageText, usableChars, type ExtractedPage } from './extractors/types';

/** Caractere nulo (ligadura sem mapa) ou caractere de substituição no texto do pdf.js. */
export function hasCorruptCharacters(text: string): boolean {
  return text.includes('\u0000') || text.includes('\uFFFD');
}

/**
 * A segunda leitura só substitui a primeira quando está limpa e tem mais letras.
 * Mais curta, ainda com nulo, ou ilegível, fica de fora.
 */
export function readingIsHealthier(original: string, alternative: string): boolean {
  if (hasCorruptCharacters(alternative) || isUnreadableText(alternative)) return false;
  return usableChars(alternative) > usableChars(original);
}

/** Troca a página pela leitura alternativa quando ela é mais saudável. */
export function adoptAlternativePage(page: ExtractedPage, alternative: string | undefined): { page: ExtractedPage; adopted: boolean } {
  if (alternative === undefined || !readingIsHealthier(pageText(page), alternative)) return { page, adopted: false };
  return {
    adopted: true,
    page: {
      ...page,
      lines: plainTextToLines(alternative),
      ocr: false,
      ocrConfidence: null,
      needsOcr: false,
      unreadableTextLayer: false,
    },
  };
}
