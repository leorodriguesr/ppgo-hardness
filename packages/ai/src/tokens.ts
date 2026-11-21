import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';

let encoder: Tiktoken | undefined;

function getEncoder(): Tiktoken {
  encoder ??= new Tiktoken(o200k);
  return encoder;
}

/**
 * Contagem de tokens com o200k_base. Para modelos não-OpenAI (ex.: Qwen) é uma
 * aproximação; os orçamentos de contexto mantêm margem de segurança por isso.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const enc = getEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) return text;
  return enc.decode(tokens.slice(0, maxTokens));
}

/** Divide o texto em janelas de até `size` tokens, com `overlap` tokens de sobreposição. */
export function splitByTokens(text: string, size: number, overlap: number): string[] {
  const enc = getEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= size) return [text];
  const step = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += step) {
    out.push(enc.decode(tokens.slice(i, i + size)));
    if (i + size >= tokens.length) break;
  }
  return out;
}
