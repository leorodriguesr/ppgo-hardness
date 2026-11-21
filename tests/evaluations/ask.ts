/**
 * CLI de diagnóstico: faz perguntas ao motor RAG real e imprime resposta, fontes, citações e tempos.
 * Uso: npx tsx tests/evaluations/ask.ts [--clearance=sigiloso] "pergunta" ["outra pergunta" ...]
 */
import { loadEnv } from '@rag/config';
import { createRuntime } from '@rag/rag';
import type { AccessLevel } from '@rag/shared';

const args = process.argv.slice(2);
const clearance = (args.find((a) => a.startsWith('--clearance='))?.split('=')[1] ?? 'interno') as AccessLevel;
const questions = args.filter((a) => !a.startsWith('--'));
const runtime = createRuntime(loadEnv(), 'ask-cli');

try {
  for (const question of questions) {
    console.log(`\n\x1b[1m? ${question}\x1b[0m`);
    const gen = runtime.engine.answer({
      question,
      history: [],
      principal: { id: 'cli', displayName: 'CLI', roles: ['admin'], clearance, authenticated: false },
    });
    let n = await gen.next();
    while (!n.done) {
      if (n.value.type === 'token') process.stdout.write(n.value.text);
      n = await gen.next();
    }
    const r = n.value;
    console.log(`\n  tipo=${r.answerType} evidência=${r.evidenceScore?.toFixed(2) ?? '-'} grounding=${r.grounding?.score.toFixed(2) ?? '-'} histórico=${r.includeHistorical}`);
    for (const s of r.sources) console.log(`  [Fonte ${s.sourceNumber}] ${s.documentNumber} p${s.pageStart ?? '-'} ${s.structuralRef ?? ''} score=${s.score.toFixed(3)}`);
    for (const c of r.citations) console.log(`  citação Fonte ${c.sourceNumber} p${c.page ?? '-'} válida=${c.valid} suporte=${c.supportScore?.toFixed(2)}`);
    console.log(`  tempos: ${Object.entries(r.timings).map(([k, v]) => `${k}=${Math.round(v)}ms`).join(' ')}`);
    console.log(`  tokens: in=${r.usage.tokensIn} out=${r.usage.tokensOut} ${r.grounding?.warnings.length ? `avisos=${r.grounding.warnings.join('; ')}` : ''}`);
  }
} finally {
  await runtime.close();
}
