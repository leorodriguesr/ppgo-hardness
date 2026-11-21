import type { EmbeddingProvider, Reranker } from '@rag/ai';
import type { Database, EmbeddingModelRow } from '@rag/database';
import type { RagSettings } from '@rag/shared';
import { Stopwatch } from '@rag/shared/server';
import { trace } from '@opentelemetry/api';
import type { EffectiveFilters } from './filters';
import { dedupeCandidates, reciprocalRankFusion, type FusedCandidate } from './fusion';
import { focusProcedureSection } from './focus';
import { lexicalSearch, neighborChunks, referenceSearch, vectorSearch, type Candidate } from './search';
import { promptSafeContent } from '../security/injection';

const tracer = trace.getTracer('rag.retrieval');

export interface RetrievalStats {
  vectorCandidates: number;
  lexicalCandidates: number;
  fusedCandidates: number;
  rerankedCandidates: number;
  rerankFailed: boolean;
  rerankSkipped: boolean;
}

export interface RetrievalOutput {
  ranked: FusedCandidate[];
  stats: RetrievalStats;
  timings: Record<string, number>;
  /** Melhor escore de evidência (reranker, quando ativo; senão similaridade vetorial). */
  evidenceScore: number | null;
}

/** Cache LRU simples de embeddings de consultas (evita recomputar perguntas repetidas). */
class QueryEmbeddingCache {
  private readonly map = new Map<string, number[]>();
  constructor(private readonly max = 500) {}
  get(key: string): number[] | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: number[]): void {
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

const queryCache = new QueryEmbeddingCache();

export interface RetrieverDeps {
  db: Database;
  embeddingModel: EmbeddingModelRow;
  embeddingProvider: EmbeddingProvider;
  reranker: Reranker;
}

export async function retrieve(
  deps: RetrieverDeps,
  input: { query: string; filters: EffectiveFilters; settings: RagSettings; signal?: AbortSignal },
): Promise<RetrievalOutput> {
  return tracer.startActiveSpan('rag.retrieve', async (span) => {
    try {
      const sw = new Stopwatch();
      const { retrieval: r, rerank } = input.settings;
      const useVector = r.mode !== 'lexical' && r.vectorWeight > 0;
      const useLexical = r.mode !== 'vector' && r.lexicalWeight > 0;

      const vectorPromise: Promise<Candidate[]> = useVector
        ? (async () => {
            const key = `${deps.embeddingModel.id}:${input.query}`;
            let embedding = queryCache.get(key);
            if (!embedding) {
              const t0 = performance.now();
              const res = await deps.embeddingProvider.embed([input.query], { signal: input.signal, operation: 'embedding_query' });
              sw.record('queryEmbedding', performance.now() - t0);
              embedding = res.vectors[0]!;
              queryCache.set(key, embedding);
            }
            const t1 = performance.now();
            const out = await vectorSearch(deps.db, {
              embedding,
              modelId: deps.embeddingModel.id,
              dimensions: deps.embeddingModel.dimensions,
              limit: r.vectorCandidates,
              minSimilarity: r.minVectorSimilarity,
              filters: input.filters,
            });
            sw.record('vectorSearch', performance.now() - t1);
            return out;
          })()
        : Promise.resolve([]);
      const lexicalPromise: Promise<Candidate[]> = useLexical
        ? sw.measure('lexicalSearch', () => lexicalSearch(deps.db, { query: input.query, limit: r.lexicalCandidates, filters: input.filters }))
        : Promise.resolve([]);

      const useReference = r.mode !== 'vector' && r.referenceWeight > 0;
      const referencePromise: Promise<Candidate[]> = useReference
        ? sw.measure('referenceSearch', () => referenceSearch(deps.db, { query: input.query, limit: 12, filters: input.filters }))
        : Promise.resolve([]);

      const t0 = performance.now();
      const [vector, lexical, reference] = await Promise.all([vectorPromise, lexicalPromise, referencePromise]);
      sw.record('retrieval', performance.now() - t0);

      const fused = dedupeCandidates(
        reciprocalRankFusion(
          [
            { candidates: vector, weight: useVector ? r.vectorWeight : 0 },
            { candidates: lexical, weight: useLexical ? r.lexicalWeight : 0 },
            { candidates: reference, weight: useReference ? r.referenceWeight : 0 },
          ],
          r.rrfK,
        ),
      );

      let ranked: FusedCandidate[] = fused;
      let rerankFailed = false;
      let rerankedCount = 0;
      const rerankSkipped = !rerank.enabled || fused.length === 0;
      let evidenceScore: number | null = vector.length ? Math.max(...vector.map((v) => v.vectorScore ?? 0)) : null;

      if (!rerankSkipped) {
        const pool = fused.slice(0, rerank.candidates);
        const t2 = performance.now();
        try {
          const scores = await deps.reranker.rerank(
            input.query,
            pool.map((c) => ({
              id: c.chunkId,
              text: [c.contextHeader, c.headingPath.join(' › '), c.structuralRef, promptSafeContent(c.content)].filter(Boolean).join('\n'),
            })),
            { signal: input.signal },
          );
          const byId = new Map(scores.map((s) => [s.id, s.score]));
          const rescored = pool
            .map((c) => ({ ...c, rerankScore: byId.get(c.chunkId) ?? 0 }))
            .sort((a, b) => b.rerankScore - a.rerankScore || b.fusedScore - a.fusedScore);
          rerankedCount = rescored.length;
          evidenceScore = rescored[0]?.rerankScore ?? 0;
          ranked = rescored.filter((c) => c.rerankScore >= rerank.minScore);
        } catch (err) {
          if (input.signal?.aborted) throw err;
          // Falha do reranker não derruba a resposta: segue com a ordem da fusão
          rerankFailed = true;
          ranked = fused;
        }
        sw.record('rerank', performance.now() - t2);
        if (!rerankFailed) {
          ranked = focusProcedureSection(input.query, ranked);
          evidenceScore = ranked[0]?.rerankScore ?? evidenceScore;
        }
      }

      if (r.expandNeighbors && ranked.length > 0) {
        ranked = await expandSplitArticles(deps.db, ranked, r.finalTopK);
      }

      span.setAttributes({
        'rag.vector_candidates': vector.length,
        'rag.lexical_candidates': lexical.length,
        'rag.fused_candidates': fused.length,
        'rag.rerank_failed': rerankFailed,
      });
      return {
        ranked,
        stats: {
          vectorCandidates: vector.length,
          lexicalCandidates: lexical.length,
          fusedCandidates: fused.length,
          rerankedCandidates: rerankedCount,
          rerankFailed,
          rerankSkipped,
        },
        timings: sw.toJSON(),
        evidenceScore,
      };
    } finally {
      span.end();
    }
  });
}

/**
 * Para artigos divididos em vários chunks, traz as partes vizinhas do mesmo artigo
 * logo após a parte recuperada, preservando a interpretação do dispositivo.
 */
async function expandSplitArticles(db: Database, ranked: FusedCandidate[], topK: number): Promise<FusedCandidate[]> {
  const top = ranked.slice(0, topK);
  const present = new Set(ranked.map((c) => c.chunkId));
  const out: FusedCandidate[] = [];
  for (const c of top) {
    out.push(c);
    if (!c.flags.includes('article_split') || !c.structuralRef) continue;
    const neighbors = await neighborChunks(db, c.versionId, [c.chunkIndex - 1, c.chunkIndex + 1]);
    for (const n of neighbors) {
      if (present.has(n.chunkId) || n.structuralRef !== c.structuralRef) continue;
      present.add(n.chunkId);
      out.push({ ...n, fusedScore: c.fusedScore * 0.99, rerankScore: c.rerankScore });
    }
  }
  return [...out, ...ranked.slice(topK).filter((c) => !out.some((o) => o.chunkId === c.chunkId))];
}
