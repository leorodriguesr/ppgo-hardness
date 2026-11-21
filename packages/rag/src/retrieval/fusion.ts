import type { Candidate } from './search';

export interface FusedCandidate extends Candidate {
  fusedScore: number;
  rerankScore?: number;
}

/**
 * Reciprocal Rank Fusion ponderada: score(d) = Σ wᵢ / (k + rankᵢ(d)).
 * Independe da escala dos escores originais, o que permite combinar similaridade de
 * cosseno e ts_rank sem calibração.
 */
export function reciprocalRankFusion(
  lists: { candidates: Candidate[]; weight: number }[],
  k: number,
): FusedCandidate[] {
  const byId = new Map<string, FusedCandidate>();
  for (const { candidates, weight } of lists) {
    if (weight <= 0) continue;
    candidates.forEach((c, idx) => {
      const rank = idx + 1;
      const contribution = weight / (k + rank);
      const existing = byId.get(c.chunkId);
      if (existing) {
        existing.fusedScore += contribution;
        existing.vectorScore ??= c.vectorScore;
        existing.vectorRank ??= c.vectorRank;
        existing.lexicalScore ??= c.lexicalScore;
        existing.lexicalRank ??= c.lexicalRank;
        existing.referenceRank ??= c.referenceRank;
      } else {
        byId.set(c.chunkId, { ...c, fusedScore: contribution });
      }
    });
  }
  return [...byId.values()].sort((a, b) => b.fusedScore - a.fusedScore || a.chunkId.localeCompare(b.chunkId));
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Remove duplicatas: mesmo hash de conteúdo (ex.: mesmo texto em versões/documentos distintos,
 * mantendo a versão atual) e quase-duplicatas por sobreposição de chunking (Jaccard ≥ limiar).
 */
export function dedupeCandidates<T extends Candidate>(candidates: T[], nearDuplicateThreshold = 0.9): T[] {
  const out: T[] = [];
  const sets: Set<string>[] = [];
  const byHash = new Map<string, number>();
  for (const c of candidates) {
    const idx = byHash.get(c.contentHash);
    if (idx !== undefined) {
      const kept = out[idx]!;
      if (!kept.isCurrentVersion && c.isCurrentVersion) out[idx] = c;
      continue;
    }
    const set = tokenSet(c.content);
    if (sets.some((s, i) => out[i]!.documentId === c.documentId && jaccard(s, set) >= nearDuplicateThreshold)) continue;
    byHash.set(c.contentHash, out.length);
    out.push(c);
    sets.push(set);
  }
  return out;
}
