/**
 * Executa uma avaliação RAG sobre o banco configurado (corpus sintético já ingerido).
 * Uso:
 *   npx tsx tests/evaluations/run-eval.ts --dataset=dev --mode=full --name=baseline
 *   npx tsx tests/evaluations/run-eval.ts --dataset=validation --mode=retrieval --overrides='{"rerank":{"enabled":false}}'
 *   --cases=dev-01,dev-17   (subconjunto, para diagnóstico)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from '@rag/config';
import { upsertDataset } from '@rag/database';
import { createRuntime, runEvaluation, type EvaluationMode, type EvaluationReport, type Runtime } from '@rag/rag';
import { DATASETS } from './datasets/index';

export const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'results');

export async function syncDatasets(runtime: Runtime): Promise<Record<keyof typeof DATASETS, string>> {
  const ids = {} as Record<keyof typeof DATASETS, string>;
  for (const [key, ds] of Object.entries(DATASETS) as [keyof typeof DATASETS, (typeof DATASETS)[keyof typeof DATASETS]][]) {
    ids[key] = await upsertDataset(
      runtime.db,
      { name: ds.name, split: ds.split, description: ds.description, version: ds.version },
      ds.cases.map((c) => ({
        ...c,
        history: c.history ?? [],
        relevant: c.relevant ?? [],
        requiredFacts: c.requiredFacts ?? [],
        forbidden: c.forbidden ?? [],
        tags: c.tags ?? [],
      })),
    );
  }
  return ids;
}

export function formatReport(r: EvaluationReport): string {
  const lines = [`\n=== ${r.experimentName} (${r.mode}) — ${r.cases} casos, ${r.errors} erros — run ${r.runId}`];
  const m = r.metrics;
  const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? 'n/d' : v.toFixed(d));
  lines.push(
    `Recuperação: R@1=${f(m.recallAt1)} R@3=${f(m.recallAt3)} R@K(${m.k})=${f(m.recallAtK)} R@10=${f(m.recallAt10)} P@K=${f(m.precisionAtK)} MRR=${f(m.mrr)} nDCG@K=${f(m.ndcgAtK)} contexto=${f(m.contextRecall)}`,
  );
  if (r.mode === 'full') {
    lines.push(
      `Resposta: juiz fidelidade=${f(m.judgeFaithfulness, 2)} relevância=${f(m.judgeRelevance, 2)} alucinações graves=${m.severeHallucinations} grounding=${f(m.groundingScore)} fatos=${f(m.factCoverage)} respondidas=${f(m.answeredRate)}`,
      `Citações: com citação=${f(m.citedAnswerRate)} válidas=${f(m.citationValidity)} sustentadas=${f(m.citationSupport)} relevantes=${f(m.citedSourceRelevance)} não autorizadas=${m.unauthorizedCitations}`,
      `Robustez: comportamento=${f(m.behaviorPassRate)} violações de segurança=${m.securityViolations} infraestrutura=${f(m.infraPassRate)}`,
      `Tokens: entrada=${m.tokensIn} saída=${m.tokensOut}`,
    );
  }
  lines.push(`Latência: p50=${m.latencyP50Ms}ms p95=${m.latencyP95Ms}ms p99=${m.latencyP99Ms}ms`);
  for (const [dim, s] of Object.entries(r.dimensions)) lines.push(`  ${dim.padEnd(12)} ${s.score}/5  ${s.reasons.join(' | ')}`);
  const failing = r.outcomes.filter((o) => o.error || o.behaviorPass === false || o.securityViolation || (typeof o.metrics.recallAtK === 'number' && o.metrics.recallAtK < 1));
  if (failing.length) {
    lines.push('Casos com falha:');
    for (const o of failing) {
      const parts = [
        o.error ? `erro=${o.error}` : null,
        o.behaviorPass === false ? `comportamento (esperado ${o.expected}, obtido ${String(o.metrics.answerType)})` : null,
        o.securityViolation ? 'VIOLAÇÃO DE SEGURANÇA' : null,
        typeof o.metrics.recallAtK === 'number' && o.metrics.recallAtK < 1 ? `R@K=${(o.metrics.recallAtK as number).toFixed(2)}` : null,
        typeof o.metrics.factCoverage === 'number' && o.metrics.factCoverage < 1 ? `fatos=${(o.metrics.factCoverage as number).toFixed(2)}` : null,
        o.judge ? `juiz F${o.judge.fidelidade}/R${o.judge.relevancia}` : null,
      ].filter(Boolean);
      lines.push(`  ${o.externalId} [${o.category}] ${parts.join('; ')}`);
    }
  }
  return lines.join('\n');
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = loadEnv();
  const runtime = createRuntime(env, 'eval-cli');
  try {
    const ids = await syncDatasets(runtime);
    const dataset = (arg('dataset') ?? 'dev') as keyof typeof DATASETS;
    const mode = (arg('mode') ?? 'full') as EvaluationMode;
    const overrides = arg('overrides') ? (JSON.parse(arg('overrides')!) as Record<string, unknown>) : {};
    const cases = arg('cases')?.split(',');
    const name = arg('name') ?? `${dataset}-${mode}`;
    const t0 = Date.now();
    const report = await runEvaluation(
      {
        db: runtime.db,
        chat: runtime.chat,
        embeddingProviderFor: runtime.embeddingProviderFor,
        rerankerFor: runtime.rerankerFor,
        getSettings: () => runtime.settings.get(),
        logger: runtime.logger,
      },
      {
        datasetId: ids[dataset],
        experimentName: name,
        mode,
        overrides,
        judgeModel: env.JUDGE_MODEL,
        infraChecks: mode === 'full' && !cases,
        notes: arg('notes'),
        caseFilter: cases ? (c) => cases.includes(c.externalId) : undefined,
        onProgress: (done, total, id) => process.stderr.write(`\r${done}/${total} ${id}      `),
      },
    );
    console.log(formatReport(report));
    console.log(`Duração total: ${Math.round((Date.now() - t0) / 1000)}s`);
    await mkdir(RESULTS_DIR, { recursive: true });
    const file = join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.json`);
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log(`Relatório: ${file}`);
  } finally {
    await runtime.close();
  }
}
