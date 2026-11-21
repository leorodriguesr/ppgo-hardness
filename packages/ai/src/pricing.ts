/**
 * Preços estimados em USD por 1 milhão de tokens. Valores de referência que devem ser
 * revisados periodicamente; modelos locais (Ollama) têm custo de API zero.
 */
export const PRICING_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
};

export function estimateCostUsd(provider: string, model: string, tokensIn: number, tokensOut: number): number {
  if (provider === 'ollama') return 0;
  const price = PRICING_USD_PER_MTOK[model];
  if (!price) return 0;
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}
