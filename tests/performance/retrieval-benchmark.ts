/**
 * Mede a busca (vetor + lexical + rerank) sem gerar resposta.
 * Uso: DATABASE_URL=.../rag_eval npx tsx tests/performance/retrieval-benchmark.ts
 */
import { loadEnv } from '@rag/config';
import { getActiveEmbeddingModel } from '@rag/database';
import { createRuntime, retrieve } from '@rag/rag';
import { percentile } from '@rag/shared/server';
import { DEV_CASES } from '../evaluations/datasets/index';

const runtime = createRuntime(loadEnv(), 'perf-retrieval');
try {
  const settings = await runtime.settings.get();
  const model = (await getActiveEmbeddingModel(runtime.db))!;
  const reranker = runtime.rerankerFor(settings, runtime.chat);
  const samples: number[] = [];
  for (const c of DEV_CASES) {
    const t0 = performance.now();
    await retrieve(
      { db: runtime.db, embeddingModel: model, embeddingProvider: runtime.embeddingProviderFor(model), reranker },
      { query: c.question, filters: { clearance: 'interno', includeHistorical: false }, settings },
    );
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  console.log(`casos=${samples.length} p50=${Math.round(percentile(samples, 50) ?? 0)}ms p95=${Math.round(percentile(samples, 95) ?? 0)}ms max=${Math.round(samples.at(-1) ?? 0)}ms`);
} finally {
  await runtime.close();
}
