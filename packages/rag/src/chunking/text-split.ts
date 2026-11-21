import { countTokens, splitByTokens } from '@rag/ai';

const ABBREVIATION_RE =
  /(?<![\p{L}\p{N}])(Art|Arts|art|arts|inc|Inc|al|nº|n|Nº|Dr|Dra|Sr|Sra|Prof|Profa|Exmo|Exma|Ilmo|Ilma|Cel|Ten|Cap|Sgt|Maj|etc|p|pág|fls|fl|cf|Obs|obs|Res|Port|Proc|Dec|Lei|Id|ex|LTDA|Ltda|S\.A)\./gu;

/**
 * Troca por \u0001 os pontos que não encerram frase (abreviações e números como 1.234).
 * Preserva o comprimento do texto, então índices calculados sobre o resultado valem no original.
 */
export function maskAbbreviationDots(text: string): string {
  return text.replace(ABBREVIATION_RE, '$1\u0001').replace(/(\d)\.(\d)/g, '$1\u0001$2');
}

/**
 * Divide texto em sentenças, protegendo abreviações comuns em documentos normativos
 * (Art., nº, inc., Dr., Sr., etc.) e números com ponto (1.234, 12.3).
 */
export function splitSentences(text: string): string[] {
  const protectedText = maskAbbreviationDots(text);
  const parts = protectedText.split(/(?<=[.!?;])\s+(?=[\p{Lu}\d"“(§])/u);
  return parts.map((p) => p.replace(/\u0001/g, '.').trim()).filter(Boolean);
}

/**
 * Divisão recursiva por separadores progressivamente menores
 * (parágrafo → linha → sentença → palavra), até caber no limite de tokens.
 */
export function recursiveSplit(text: string, maxTokens: number, overlapTokens = 0): string[] {
  if (countTokens(text) <= maxTokens) return [text];
  const separators: ((t: string) => string[])[] = [
    (t) => t.split(/\n{2,}/),
    (t) => t.split(/\n/),
    splitSentences,
    (t) => t.split(/(?<=,)\s+/),
  ];
  for (const sep of separators) {
    const parts = sep(text).map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) continue;
    return packPieces(parts.flatMap((p) => recursiveSplit(p, maxTokens, 0)), maxTokens, overlapTokens);
  }
  return splitByTokens(text, maxTokens, overlapTokens);
}

/** Agrupa pedaços consecutivos até o limite, com sobreposição dos últimos pedaços. */
export function packPieces(pieces: string[], maxTokens: number, overlapTokens: number, joiner = ' '): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  const sizes = pieces.map(countTokens);
  for (let i = 0; i < pieces.length; i++) {
    const size = sizes[i]!;
    if (current.length > 0 && tokens + size > maxTokens) {
      out.push(current.join(joiner));
      const overlap: string[] = [];
      let ot = 0;
      for (let j = current.length - 1; j >= 0 && overlapTokens > 0; j--) {
        const s = countTokens(current[j]!);
        if (ot + s > overlapTokens) break;
        overlap.unshift(current[j]!);
        ot += s;
      }
      current = overlap;
      tokens = ot;
    }
    current.push(pieces[i]!);
    tokens += size;
  }
  if (current.length) out.push(current.join(joiner));
  return out;
}
