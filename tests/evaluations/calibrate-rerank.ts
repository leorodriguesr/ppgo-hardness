/**
 * Calibração dos limiares do reranker (rerank.minScore e grounding.minEvidenceScore) sobre o split DEV.
 * Executa só a recuperação com limiares zerados e mostra, por caso, a maior nota e a nota/posição
 * do primeiro trecho relevante. O split de validação não é usado aqui (evita ajuste sobre ele).
 * Uso: npx tsx tests/evaluations/calibrate-rerank.ts
 */
import { loadEnv } from '@rag/config';
import { getActiveEmbeddingModel } from '@rag/database';
import { createRuntime, matchesSpec, retrieve, rewriteQuery, selectHistory, type RelevantSpec } from '@rag/rag';
import type { AccessLevel } from '@rag/shared';
import { DEV_CASES } from './datasets/index';

const runtime = createRuntime(loadEnv(), 'calibrate-rerank');
try {
  const base = await runtime.settings.get();
  const settings = { ...base, rerank: { ...base.rerank, enabled: true, minScore: 0 } };
  const model = (await getActiveEmbeddingModel(runtime.db))!;
  const reranker = runtime.rerankerFor(settings, runtime.chat);
  console.log(`reranker=${reranker.name} modelo=${reranker.model ?? '-'} candidatos=${settings.rerank.candidates}`);
  const rows: { id: string; expected: string; top: number; relScore: number | null; relRank: number | null; ms: number }[] = [];
  for (const c of DEV_CASES) {
    const clearance = (c.tags?.find((t) => t.startsWith('clearance:'))?.slice(10) ?? 'interno') as AccessLevel;
    let query = c.question;
    const history = selectHistory(c.history ?? [], settings.rewrite.historyMessages, settings.rewrite.historyTokenBudget);
    if (history.length) {
      const rw = await rewriteQuery({ provider: runtime.chat, model: settings.rewrite.model, question: c.question, history, enabled: true });
      query = rw.query;
    }
    const t0 = performance.now();
    const r = await retrieve(
      { db: runtime.db, embeddingModel: model, embeddingProvider: runtime.embeddingProviderFor(model), reranker },
      { query, filters: { clearance, includeHistorical: c.tags?.includes('historical') ?? false }, settings },
    );
    const ms = performance.now() - t0;
    const specs = (c.relevant ?? []) as RelevantSpec[];
    const relIdx = specs.length ? r.ranked.findIndex((x) => specs.some((s) => matchesSpec(x, s))) : -1;
    rows.push({
      id: c.externalId,
      expected: c.expectedBehavior,
      top: r.evidenceScore ?? 0,
      relScore: relIdx >= 0 ? (r.ranked[relIdx]!.rerankScore ?? null) : null,
      relRank: relIdx >= 0 ? relIdx + 1 : null,
      ms,
    });
    const last = rows.at(-1)!;
    const perSpec =
      specs.length > 1
        ? ' por rótulo: ' +
          specs
            .map((s) => {
              const i = r.ranked.findIndex((x) => matchesSpec(x, s));
              return `${s.documentNumber}=${i >= 0 ? `${r.ranked[i]!.rerankScore?.toFixed(3)}#${i + 1}` : 'ausente'}`;
            })
            .join(', ')
        : '';
    console.log(
      `${last.id.padEnd(7)} ${last.expected.padEnd(10)} top=${last.top.toFixed(3)} relevante=${last.relScore?.toFixed(3) ?? '-'}#${last.relRank ?? '-'} rerank=${Math.round(r.timings.rerank ?? 0)}ms total=${Math.round(ms)}ms${perSpec}`,
    );
  }
  const answerable = rows.filter((r) => r.expected !== 'abstain' && r.expected !== 'refuse');
  const abstain = rows.filter((r) => r.expected === 'abstain');
  const relScores = answerable.map((r) => r.relScore).filter((x): x is number => x !== null).sort((a, b) => a - b);
  console.log('\nResumo:');
  console.log(`  maior nota em casos respondíveis: mín=${Math.min(...answerable.map((r) => r.top)).toFixed(3)}`);
  console.log(`  maior nota em casos de abstenção: ${abstain.map((r) => `${r.id}=${r.top.toFixed(3)}`).join(' ')}`);
  console.log(`  nota do 1º relevante (ordenada): ${relScores.map((x) => x.toFixed(3)).join(' ')}`);
  const rerankMs = rows.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`  recuperação total: p50=${Math.round(rerankMs[Math.floor(rerankMs.length / 2)]!)}ms máx=${Math.round(rerankMs.at(-1)!)}ms`);
} finally {
  await runtime.close();
}
