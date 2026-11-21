/**
 * Recalcula a verificação lexical de grounding das respostas já gravadas de uma execução,
 * com o código atual (sem chamar LLMs). Serve para separar mudanças de comportamento do modelo
 * de mudanças no próprio medidor. Só é exato quando a execução usou grounding.useLlmVerifier=false.
 * Não altera o banco: apenas imprime as métricas originais e as recalculadas.
 *
 * Uso: npx tsx tests/evaluations/regrade-grounding.ts <experimento> [<experimento>...]
 */
import { loadEnv } from '@rag/config';
import { createRuntime, verifyGrounding, type ContextSource } from '@rag/rag';

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('Informe ao menos um nome de experimento.');
  process.exit(1);
}

interface StoredCitation {
  sourceNumber: number;
  chunkId: string;
  supportScore: number | null;
}

const runtime = createRuntime(loadEnv(), 'regrade-grounding');
const sql = runtime.database.sql;
try {
  const settings = await runtime.settings.get();
  const minSupport = settings.grounding.minSupportScore;
  for (const name of names) {
    const [run] = await sql<{ id: string; config: { overrides?: { grounding?: { useLlmVerifier?: boolean } } } }[]>`
      SELECT id, config FROM evaluation_runs WHERE experiment_name = ${name} ORDER BY started_at DESC LIMIT 1`;
    if (!run) {
      console.error(`Experimento não encontrado: ${name}`);
      continue;
    }
    if (run.config.overrides?.grounding?.useLlmVerifier || settings.grounding.useLlmVerifier) console.warn(`[${name}] execução usou verificador por LLM; o recálculo lexical não é comparável.`);
    const rows = await sql<{ external_id: string; expected_behavior: string; answer: string | null; answer_type: string | null; citations: StoredCitation[]; metrics: Record<string, unknown> }[]>`
      SELECT c.external_id, c.expected_behavior, r.answer, r.answer_type, r.citations, r.metrics
      FROM evaluation_results r JOIN evaluation_cases c ON c.id = r.case_id
      WHERE r.run_id = ${run.id} ORDER BY c.external_id`;

    const chunkIds = [...new Set(rows.flatMap((r) => r.citations.map((c) => c.chunkId)).filter(Boolean))];
    const chunks = chunkIds.length
      ? await sql<{ id: string; content: string; structural_ref: string | null; heading_path: string[]; page_start: number | null; page_end: number | null; title: string; document_number: string | null; document_id: string }[]>`
          SELECT c.id, c.content, c.structural_ref, c.heading_path, c.page_start, c.page_end, d.title, d.document_number, d.id AS document_id
          FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE c.id IN ${sql(chunkIds)}`
      : [];
    const byId = new Map(chunks.map((c) => [c.id, c]));

    const before = { cit: 0, sup: 0, g: [] as number[] };
    const after = { cit: 0, sup: 0, g: [] as number[] };
    const changed: string[] = [];
    for (const r of rows) {
      const answerable = ['answer', 'conflict', 'historical'].includes(r.expected_behavior);
      if (!answerable || !r.answer || !r.answer_type || r.answer_type === 'insufficient_evidence') continue;
      const sources = r.citations
        .map((c) => {
          const ch = byId.get(c.chunkId);
          if (!ch) return null;
          return {
            sourceNumber: c.sourceNumber,
            chunkId: ch.id,
            documentId: ch.document_id,
            documentTitle: ch.title,
            documentNumber: ch.document_number,
            structuralRef: ch.structural_ref,
            headingPath: ch.heading_path,
            pageStart: ch.page_start,
            pageEnd: ch.page_end,
            excerpt: ch.content,
          } as unknown as ContextSource;
        })
        .filter((s): s is ContextSource => s !== null);
      const uniq = [...new Map(sources.map((s) => [s.sourceNumber, s])).values()];
      const g = await verifyGrounding({ answer: r.answer, sources: uniq, minSupportScore: minSupport });
      // Mesmo critério de toCitationRecords + runner: uma entrada por "fonte:página" com fonte resolvida.
      const keys = [...new Set(g.checks.filter((ch) => ch.source).map((ch) => `${ch.citation.sourceNumber}:${ch.citation.page ?? ''}`))];
      const supportedNow = keys.filter((k) => (g.supportByCitation.get(k) ?? 0) >= minSupport).length;
      const citedBefore = Number(r.metrics.citations ?? 0);
      const supBefore = Number(r.metrics.supportedCitations ?? 0);
      before.cit += citedBefore;
      before.sup += supBefore;
      after.cit += keys.length;
      after.sup += supportedNow;
      if (typeof r.metrics.groundingScore === 'number') before.g.push(r.metrics.groundingScore);
      after.g.push(g.report.score);
      if (supBefore !== supportedNow || r.metrics.groundingScore !== g.report.score)
        changed.push(`${r.external_id}: citações sustentadas ${supBefore}/${citedBefore} → ${supportedNow}/${keys.length}; grounding ${r.metrics.groundingScore} → ${g.report.score}`);
    }
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    console.log(`\n== ${name} ==`);
    console.log(`citationSupport: ${(before.sup / before.cit).toFixed(3)} → ${(after.sup / after.cit).toFixed(3)}`);
    console.log(`groundingScore:  ${mean(before.g).toFixed(3)} → ${mean(after.g).toFixed(3)}`);
    for (const line of changed) console.log(`  ${line}`);
  }
} finally {
  await runtime.close();
}
