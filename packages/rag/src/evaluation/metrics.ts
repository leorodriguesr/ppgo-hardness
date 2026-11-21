/** Especificação de relevância estável entre estratégias de chunking. */
export interface RelevantSpec {
  /** Número do documento (ex.: "Portaria nº 101/2025-DGPP"). */
  documentNumber: string;
  /** O trecho é relevante se contiver ao menos uma destas expressões. */
  mustContain: string[];
}

export const normalizeText = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function matchesSpec(candidate: { documentNumber: string | null; content: string }, spec: RelevantSpec): boolean {
  if (!candidate.documentNumber || normalizeText(candidate.documentNumber) !== normalizeText(spec.documentNumber)) return false;
  const content = normalizeText(candidate.content);
  return spec.mustContain.length === 0 || spec.mustContain.some((m) => content.includes(normalizeText(m)));
}

/**
 * Para cada posição do ranking, retorna o índice da especificação que ela satisfaz pela
 * primeira vez (ou -1). Uma especificação só conta uma vez (evita inflar métricas com duplicatas).
 */
export function relevanceVector(ranked: { documentNumber: string | null; content: string }[], specs: RelevantSpec[]): number[] {
  const satisfied = new Set<number>();
  return ranked.map((c) => {
    for (let i = 0; i < specs.length; i++) {
      if (!satisfied.has(i) && matchesSpec(c, specs[i]!)) {
        satisfied.add(i);
        return i;
      }
    }
    return -1;
  });
}

export function recallAtK(rel: number[], totalRelevant: number, k: number): number {
  if (totalRelevant === 0) return 1;
  return rel.slice(0, k).filter((r) => r >= 0).length / totalRelevant;
}

/** Precision@K sobre posições preenchidas (rankings menores que K não são penalizados por vazio). */
export function precisionAtK(ranked: { documentNumber: string | null; content: string }[], specs: RelevantSpec[], k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return specs.length === 0 ? 1 : 0;
  return top.filter((c) => specs.some((s) => matchesSpec(c, s))).length / top.length;
}

export function reciprocalRank(rel: number[]): number {
  const idx = rel.findIndex((r) => r >= 0);
  return idx < 0 ? 0 : 1 / (idx + 1);
}

export function ndcgAtK(rel: number[], totalRelevant: number, k: number): number {
  if (totalRelevant === 0) return 1;
  const dcg = rel.slice(0, k).reduce((s, r, i) => s + (r >= 0 ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, totalRelevant) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

/** Cobertura de fatos obrigatórios: cada fato é uma lista de formas aceitas. */
export function factCoverage(answer: string, facts: string[][]): number {
  if (facts.length === 0) return 1;
  const a = normalizeText(answer);
  return facts.filter((alts) => alts.some((alt) => a.includes(normalizeText(alt)))).length / facts.length;
}

export function forbiddenHits(answer: string, forbidden: string[]): string[] {
  const a = normalizeText(answer);
  return forbidden.filter((f) => a.includes(normalizeText(f)));
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
