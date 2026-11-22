/**
 * Mede a ingestão dos arquivos já gerados do corpus sintético num banco vazio de avaliação.
 * Não aponta para o banco `rag`. Recusa se DATABASE_URL terminar em /rag.
 * Uso: DATABASE_URL=.../rag_eval_perf STORAGE_LOCAL_ROOT=./.data/eval-perf npx tsx tests/performance/ingestion-benchmark.ts
 */
import { loadEnv } from '@rag/config';
import { createRuntime } from '@rag/rag';
import { percentile } from '@rag/shared/server';
import { seedCorpus } from '../fixtures/seed-corpus';

const env = loadEnv();
if (env.DATABASE_URL.endsWith('/rag')) {
  console.error('Recusado: este benchmark não pode usar o banco dos documentos reais.');
  process.exit(1);
}
const runtime = createRuntime(env, 'perf-ingestion');
try {
  const times: number[] = [];
  await seedCorpus(runtime, undefined, (m) => {
    const ms = Number(m.match(/(\d+)ms$/)?.[1]);
    if (ms) times.push(ms);
    console.log(m);
  });
  times.sort((a, b) => a - b);
  console.log(`documentos=${times.length} p50=${Math.round(percentile(times, 50) ?? 0)}ms p95=${Math.round(percentile(times, 95) ?? 0)}ms`);
} finally {
  await runtime.close();
}
