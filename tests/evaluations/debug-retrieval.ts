/**
 * Diagnóstico de recuperação: mostra candidatos vetoriais/lexicais, fusão e notas do reranker.
 * Uso: npx tsx tests/evaluations/debug-retrieval.ts "pergunta" [--no-rerank]
 */
import { loadEnv } from '@rag/config';
import { getActiveEmbeddingModel } from '@rag/database';
import { createRuntime, retrieve } from '@rag/rag';

const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith('--')) ?? '';
const runtime = createRuntime(loadEnv(), 'debug-retrieval');
try {
  const base = await runtime.settings.get();
  const settings = { ...base, rerank: { ...base.rerank, enabled: !args.includes('--no-rerank') } };
  const model = (await getActiveEmbeddingModel(runtime.db))!;
  const r = await retrieve(
    { db: runtime.db, embeddingModel: model, embeddingProvider: runtime.embeddingProviderFor(model), reranker: runtime.rerankerFor(settings, runtime.chat) },
    { query, filters: { clearance: 'interno', includeHistorical: false }, settings },
  );
  console.log(JSON.stringify({ stats: r.stats, evidence: r.evidenceScore, timings: r.timings }, null, 0));
  if (args.includes('--raw-rerank')) {
    const top = r.ranked.slice(0, base.rerank.candidates);
    const reranker = runtime.rerankerFor(base, runtime.chat);
    const scores = await reranker.rerank(query, top.map((c) => ({ id: c.chunkId, text: c.content })));
    for (const [i, s] of scores.entries()) console.log(`raw #${i + 1} ${top[i]!.documentNumber} ${top[i]!.structuralRef ?? '-'} => ${s.score.toFixed(2)}`);
  }
  for (const c of r.ranked) {
    console.log(
      `${c.documentNumber} | ${c.structuralRef ?? '-'} | vec=${c.vectorScore?.toFixed(3) ?? '-'}#${c.vectorRank ?? '-'} lex=${c.lexicalScore?.toFixed(3) ?? '-'}#${c.lexicalRank ?? '-'} rrf=${c.fusedScore.toFixed(4)} rerank=${c.rerankScore?.toFixed(2) ?? '-'} | ${c.content.slice(0, 90).replace(/\n/g, ' ')}`,
    );
  }
} finally {
  await runtime.close();
}
