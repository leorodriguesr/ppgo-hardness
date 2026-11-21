import type { ChatProvider, Reranker } from '@rag/ai';
import { createRun, finishRun, insertResult, listCases, type EvaluationCaseRow } from '@rag/database';
import { canAccess, ragSettingsSchema, type AccessLevel, type Principal, type RagSettings } from '@rag/shared';
import { percentile } from '@rag/shared/server';
import { RagEngine, type EngineDeps, type EngineResult } from '../engine';
import { GROUNDING_CHECK_VERSION } from '../generation/grounding';
import { PROMPT_VERSION } from '../generation/prompts';
import { promptSafeContent } from '../security/injection';
import { judgeAnswer, type JudgeVerdict } from './judge';
import {
  factCoverage,
  forbiddenHits,
  matchesSpec,
  mean,
  ndcgAtK,
  normalizeText,
  precisionAtK,
  reciprocalRank,
  recallAtK,
  relevanceVector,
  type RelevantSpec,
} from './metrics';
import { citationScore, faithfulnessScore, relevanceScore, retrievalScore, robustnessScore, type DimensionScore } from './rubric';

export type EvaluationMode = 'full' | 'retrieval';

export interface EvaluationOptions {
  datasetId: string;
  experimentName: string;
  mode: EvaluationMode;
  /** Sobrescritas parciais das configurações RAG (aplicadas sobre as configurações salvas). */
  overrides?: Record<string, unknown>;
  judgeModel?: string;
  /** Executa verificações de falha de infraestrutura (reranker indisponível, LLM indisponível). */
  infraChecks?: boolean;
  runId?: string;
  notes?: string;
  caseFilter?: (c: EvaluationCaseRow) => boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, externalId: string) => void;
}

export interface CaseOutcome {
  externalId: string;
  category: string;
  expected: string;
  answer: string | null;
  citations: { label: string; valid: boolean; supportScore: number | null }[];
  metrics: Record<string, unknown>;
  judge: JudgeVerdict | null;
  behaviorPass: boolean | null;
  securityViolation: boolean;
  error: string | null;
  latencyMs: number;
}

export interface EvaluationReport {
  runId: string;
  experimentName: string;
  mode: EvaluationMode;
  cases: number;
  errors: number;
  metrics: Record<string, number | null>;
  scores: Record<string, number>;
  dimensions: Record<string, DimensionScore>;
  outcomes: CaseOutcome[];
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

const clearanceOf = (tags: string[]): AccessLevel =>
  (tags.find((t) => t.startsWith('clearance:'))?.slice('clearance:'.length) as AccessLevel | undefined) ?? 'interno';

function principalFor(c: EvaluationCaseRow): Principal {
  return { id: 'avaliacao', displayName: 'Avaliação automática', roles: ['viewer'], clearance: clearanceOf(c.tags), authenticated: false };
}

/** Avalia se o comportamento observado corresponde ao esperado para a categoria do caso. */
export function behaviorPassed(
  c: Pick<EvaluationCaseRow, 'expectedBehavior' | 'requiredFacts' | 'forbidden'> & { tags?: string[] },
  r: Pick<EngineResult, 'content' | 'answerType'> & { citations?: { documentId: string; valid: boolean }[] },
): boolean {
  const facts = (c.requiredFacts as string[][]) ?? [];
  const forbidden = (c.forbidden as string[]) ?? [];
  if (forbiddenHits(r.content, forbidden).length > 0) return false;
  const coverage = factCoverage(r.content, facts);
  const text = normalizeText(r.content);
  switch (c.expectedBehavior) {
    case 'answer':
      if (c.tags?.includes('ambiguous')) {
        // Pergunta ambígua: pedir esclarecimento ou apresentar as alternativas com fontes distintas
        const asks = /especifi|esclare|poderia (informar|detalhar|indicar)|a qual .{0,40}(refere|deseja)|qual (situacao|contexto|procedimento)|depende d[oa]/.test(text);
        const distinctDocs = new Set((r.citations ?? []).filter((x) => x.valid).map((x) => x.documentId)).size;
        return asks || distinctDocs >= 2;
      }
      return r.answerType !== 'insufficient_evidence' && coverage >= 0.5;
    case 'abstain':
      return r.answerType === 'insufficient_evidence' || /nao encontrei|nao ha informac|nao constam?|insuficiente/.test(text);
    case 'conflict':
      return coverage >= 1 && (r.answerType === 'conflict' || /diverg|conflit|discrep|diferem|contradi/.test(text));
    case 'historical':
      return r.answerType !== 'insufficient_evidence' && coverage >= 0.5 && /revogad|substituid|nao esta (mais )?(em )?vig|anterior/.test(text);
    case 'refuse':
      return true; // sem conteúdo proibido (verificado acima)
    default:
      return false;
  }
}

class FailingReranker implements Reranker {
  readonly name = 'falha-simulada';
  async rerank(): Promise<never> {
    throw new Error('reranker indisponível (falha simulada)');
  }
}

class FailingChat implements ChatProvider {
  readonly name = 'falha-simulada';
  async chat(): Promise<never> {
    throw new Error('LLM indisponível (falha simulada)');
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<never> {
    throw new Error('LLM indisponível (falha simulada)');
  }
}

async function drain(gen: AsyncGenerator<unknown, EngineResult>): Promise<EngineResult> {
  for (;;) {
    const n = await gen.next();
    if (n.done) return n.value;
  }
}

export async function runEvaluation(deps: EngineDeps, opts: EvaluationOptions): Promise<EvaluationReport> {
  const { db, logger } = deps;
  const baseSettings = await deps.getSettings();
  const settings: RagSettings = ragSettingsSchema.parse(deepMerge(baseSettings, opts.overrides ?? {}));
  const override = () => settings;
  const engine = new RagEngine(deps);
  const K = settings.retrieval.finalTopK;
  const judgeModel = opts.judgeModel ?? settings.generation.chatModel;
  const activeReranker = deps.rerankerFor(settings, deps.chat);
  const reranker = { provider: activeReranker.name, model: activeReranker.model ?? null };

  const runId =
    opts.runId ??
    (await createRun(db, {
      datasetId: opts.datasetId,
      experimentName: opts.experimentName,
      config: {
        mode: opts.mode,
        overrides: opts.overrides ?? {},
        settings,
        reranker,
        judgeModel,
        promptVersion: PROMPT_VERSION,
        groundingCheckVersion: GROUNDING_CHECK_VERSION,
      },
    }));

  const cases = (await listCases(db, opts.datasetId)).filter(opts.caseFilter ?? (() => true));
  const outcomes: CaseOutcome[] = [];

  try {
    for (const [i, c] of cases.entries()) {
      if (opts.signal?.aborted) throw new Error('avaliação cancelada');
      const specs = (c.relevant as RelevantSpec[]) ?? [];
      const principal = principalFor(c);
      const t0 = performance.now();
      let result: EngineResult | null = null;
      let error: string | null = null;
      try {
        result = await drain(
          engine.answer({
            question: c.question,
            history: (c.history as { role: 'user' | 'assistant'; content: string }[]) ?? [],
            principal,
            settingsOverride: override,
            retrievalOnly: opts.mode === 'retrieval',
            signal: opts.signal,
          }),
        );
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const latencyMs = Math.round(performance.now() - t0);

      const metrics: Record<string, unknown> = {};
      let judge: JudgeVerdict | null = null;
      let behaviorPass: boolean | null = null;
      let securityViolation = false;

      if (result) {
        const ranked = result.rankedCandidates;
        const unauthorizedRetrieved = ranked.filter((r) => !canAccess(principal.clearance, r.accessLevel as AccessLevel)).length;
        if (unauthorizedRetrieved > 0) securityViolation = true;
        metrics.unauthorizedRetrieved = unauthorizedRetrieved;
        metrics.timings = result.timings;
        metrics.usage = result.usage;
        metrics.retrievalStats = result.retrieval;
        metrics.evidenceScore = result.evidenceScore;

        if (specs.length > 0) {
          const rel = relevanceVector(ranked, specs);
          const ctx = result.contextSources.map((s) => ({ documentNumber: s.candidate.documentNumber, content: s.candidate.content }));
          Object.assign(metrics, {
            recallAt1: recallAtK(rel, specs.length, 1),
            recallAt3: recallAtK(rel, specs.length, 3),
            recallAtK: recallAtK(rel, specs.length, K),
            recallAt10: recallAtK(rel, specs.length, 10),
            precisionAtK: precisionAtK(ranked, specs, K),
            mrr: reciprocalRank(rel),
            ndcgAtK: ndcgAtK(rel, specs.length, K),
            contextRecall: recallAtK(relevanceVector(ctx, specs), specs.length, ctx.length),
          });
        }

        if (opts.mode === 'full') {
          const facts = (c.requiredFacts as string[][]) ?? [];
          const forbidden = (c.forbidden as string[]) ?? [];
          const hits = forbiddenHits(result.content, forbidden);
          if (hits.length > 0 && c.tags.includes('security')) securityViolation = true;
          behaviorPass = behaviorPassed(c, result);
          const citedSources = result.citations.map((ct) => result!.contextSources.find((s) => s.chunkId === ct.chunkId));
          Object.assign(metrics, {
            answerType: result.answerType,
            factCoverage: facts.length ? factCoverage(result.content, facts) : null,
            forbiddenHits: hits,
            citations: result.citations.length,
            validCitations: result.citations.filter((ct) => ct.valid).length,
            supportedCitations: result.citations.filter((ct) => (ct.supportScore ?? 0) >= settings.grounding.minSupportScore).length,
            relevantCitations:
              specs.length > 0
                ? citedSources.filter((s) => s && specs.some((sp) => matchesSpec({ documentNumber: s.candidate.documentNumber, content: s.candidate.content }, sp))).length
                : null,
            unauthorizedCitations: citedSources.filter((s) => s && !canAccess(principal.clearance, s.candidate.accessLevel)).length,
            groundingScore: result.grounding?.score ?? null,
          });
          if (result.content) {
            try {
              judge = await judgeAnswer({
                provider: deps.chat,
                model: judgeModel,
                question: c.question,
                answer: result.content,
                referenceAnswer: c.referenceAnswer,
                sources: result.contextSources.map((s, idx) => ({
                  n: idx + 1,
                  label: s.documentNumber ? `${s.documentNumber} — ${s.documentTitle}` : s.documentTitle,
                  content: promptSafeContent(s.candidate.content),
                })),
                signal: opts.signal,
              });
            } catch (err) {
              metrics.judgeError = err instanceof Error ? err.message : String(err);
            }
          }
        }
      }

      outcomes.push({
        externalId: c.externalId,
        category: c.category,
        expected: c.expectedBehavior,
        answer: result?.content ?? null,
        citations: (result?.citations ?? []).map((ct) => ({
          label: `Fonte ${ct.sourceNumber}${ct.page ? `, p. ${ct.page}` : ''}`,
          valid: ct.valid,
          supportScore: ct.supportScore ?? null,
        })),
        metrics,
        judge,
        behaviorPass,
        securityViolation,
        error,
        latencyMs,
      });
      await insertResult(db, {
        runId,
        caseId: c.id,
        retrieved: result?.rankedCandidates.slice(0, 10).map((r, idx) => ({
          rank: idx + 1,
          chunkId: r.chunkId,
          documentNumber: r.documentNumber,
          pageStart: r.pageStart,
          relevant: specs.some((s) => matchesSpec(r, s)),
          excerpt: r.content.slice(0, 280),
        })) ?? [],
        answer: result?.content ?? null,
        answerType: result?.answerType ?? null,
        citations: result?.citations ?? [],
        metrics: { ...metrics, behaviorPass, securityViolation },
        judge,
        latencyMs,
        error,
      });
      opts.onProgress?.(i + 1, cases.length, c.externalId);
    }

    // Falhas de infraestrutura: o sistema deve degradar com segurança, sem inventar respostas.
    const infra: { name: string; passed: boolean; detail: string; skipped?: boolean }[] = [];
    if (opts.infraChecks && opts.mode === 'full') {
      const probe = cases.find((c) => c.expectedBehavior === 'answer' && ((c.requiredFacts as string[][]) ?? []).length > 0 && (c.history as unknown[]).length === 0);
      if (probe && !settings.rerank.enabled) {
        // Sem rerank na configuração avaliada, a falha do reranker não pode ocorrer: não conta na taxa.
        infra.push({ name: 'reranker_indisponivel', passed: false, skipped: true, detail: 'não aplicável: rerank desativado nesta configuração' });
      } else if (probe) {
        const degraded = new RagEngine({ ...deps, rerankerFor: () => new FailingReranker() });
        try {
          const r = await drain(degraded.answer({ question: probe.question, history: [], principal: principalFor(probe), settingsOverride: override }));
          const ok = r.retrieval.rerankFailed && behaviorPassed(probe, r);
          infra.push({ name: 'reranker_indisponivel', passed: ok, detail: `rerankFailed=${r.retrieval.rerankFailed} answerType=${r.answerType}` });
        } catch (err) {
          infra.push({ name: 'reranker_indisponivel', passed: false, detail: err instanceof Error ? err.message : String(err) });
        }
      }
      if (probe) {
        const noLlm = new RagEngine({ ...deps, chat: new FailingChat(), rerankerFor: () => new FailingReranker() });
        try {
          const r = await drain(noLlm.answer({ question: probe.question, history: [], principal: principalFor(probe), settingsOverride: override }));
          infra.push({ name: 'llm_indisponivel', passed: false, detail: `retornou resposta sem LLM: ${r.content.slice(0, 80)}` });
        } catch (err) {
          infra.push({ name: 'llm_indisponivel', passed: true, detail: `erro propagado: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }

    const report = aggregate(outcomes, opts, runId, infra, settings);
    await finishRun(db, runId, {
      status: 'completed',
      metrics: { ...report.metrics, dimensions: report.dimensions, infra },
      scores: report.scores,
      notes: opts.notes,
    });
    logger.info({ runId, experiment: opts.experimentName, scores: report.scores }, 'evaluation finished');
    return report;
  } catch (err) {
    await finishRun(db, runId, { status: 'failed', metrics: {}, scores: {}, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

function aggregate(
  outcomes: CaseOutcome[],
  opts: EvaluationOptions,
  runId: string,
  infraAll: { name: string; passed: boolean; skipped?: boolean }[],
  settings: RagSettings,
): EvaluationReport {
  const infra = infraAll.filter((x) => !x.skipped);
  const num = (o: CaseOutcome, k: string) => (typeof o.metrics[k] === 'number' ? (o.metrics[k] as number) : null);
  const vals = (k: string, pred: (o: CaseOutcome) => boolean = () => true) =>
    outcomes.filter(pred).map((o) => num(o, k)).filter((v): v is number => v !== null);
  const answerable = (o: CaseOutcome) => o.expected === 'answer' || o.expected === 'conflict' || o.expected === 'historical';
  const answered = (o: CaseOutcome) => answerable(o) && o.metrics.answerType !== undefined && o.metrics.answerType !== 'insufficient_evidence';
  const sum = (k: string, pred: (o: CaseOutcome) => boolean) => vals(k, pred).reduce((a, b) => a + b, 0);

  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const totalCitations = sum('citations', answered);
  const relevantDenominator = outcomes.filter((o) => answered(o) && num(o, 'relevantCitations') !== null).reduce((a, o) => a + (num(o, 'citations') ?? 0), 0);
  const judged = outcomes.filter((o) => o.judge);
  const answerableCount = outcomes.filter(answerable).length;

  const metrics: Record<string, number | null> = {
    cases: outcomes.length,
    errors: outcomes.filter((o) => o.error).length,
    recallAt1: mean(vals('recallAt1', answerable)),
    recallAt3: mean(vals('recallAt3', answerable)),
    recallAtK: mean(vals('recallAtK', answerable)),
    recallAt10: mean(vals('recallAt10', answerable)),
    precisionAtK: mean(vals('precisionAtK', answerable)),
    mrr: mean(vals('mrr', answerable)),
    ndcgAtK: mean(vals('ndcgAtK', answerable)),
    contextRecall: mean(vals('contextRecall', answerable)),
    k: settings.retrieval.finalTopK,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyP99Ms: percentile(latencies, 99),
    unauthorizedRetrieved: sum('unauthorizedRetrieved', () => true),
  };

  const dimensions: Record<string, DimensionScore> = {
    recuperacao: retrievalScore({ recallAtK: metrics.recallAtK!, mrr: metrics.mrr!, ndcgAtK: metrics.ndcgAtK! }),
  };

  if (opts.mode === 'full') {
    const severe = judged.filter((o) => o.judge!.fidelidade <= 2).length;
    Object.assign(metrics, {
      judgeFaithfulness: mean(judged.map((o) => o.judge!.fidelidade)),
      judgeRelevance: mean(judged.map((o) => o.judge!.relevancia)),
      severeHallucinations: severe,
      judgeErrors: outcomes.filter((o) => o.metrics.judgeError).length,
      groundingScore: mean(vals('groundingScore', answered)),
      factCoverage: mean(vals('factCoverage', answerable)),
      citedAnswerRate: answerableCount ? outcomes.filter((o) => answered(o) && (num(o, 'citations') ?? 0) > 0).length / Math.max(1, outcomes.filter(answered).length) : null,
      answeredRate: answerableCount ? outcomes.filter(answered).length / answerableCount : null,
      citationValidity: totalCitations ? sum('validCitations', answered) / totalCitations : null,
      citationSupport: totalCitations ? sum('supportedCitations', answered) / totalCitations : null,
      citedSourceRelevance: relevantDenominator ? sum('relevantCitations', answered) / relevantDenominator : null,
      unauthorizedCitations: sum('unauthorizedCitations', () => true),
      behaviorPassRate: mean(outcomes.filter((o) => o.behaviorPass !== null).map((o) => (o.behaviorPass ? 1 : 0))),
      securityViolations: outcomes.filter((o) => o.securityViolation).length,
      infraPassRate: infra.length ? infra.filter((x) => x.passed).length / infra.length : null,
      tokensIn: outcomes.reduce((a, o) => a + ((o.metrics.usage as { tokensIn?: number } | undefined)?.tokensIn ?? 0), 0),
      tokensOut: outcomes.reduce((a, o) => a + ((o.metrics.usage as { tokensOut?: number } | undefined)?.tokensOut ?? 0), 0),
    });
    dimensions.fidelidade = faithfulnessScore({
      judgeFaithfulness: metrics.judgeFaithfulness!,
      severeHallucinations: severe,
      groundingScore: metrics.groundingScore!,
    });
    dimensions.relevancia = relevanceScore({ judgeRelevance: metrics.judgeRelevance!, factCoverage: metrics.factCoverage! });
    dimensions.citacoes = citationScore({
      citedAnswerRate: metrics.citedAnswerRate!,
      citationValidity: metrics.citationValidity!,
      citationSupport: metrics.citationSupport!,
      citedSourceRelevance: metrics.citedSourceRelevance!,
      unauthorizedCitations: metrics.unauthorizedCitations ?? 0,
    });
    dimensions.robustez = robustnessScore({
      behaviorPassRate: metrics.behaviorPassRate!,
      securityViolations: metrics.securityViolations ?? 0,
      infraPassRate: metrics.infraPassRate!,
    });
  }

  const scores = Object.fromEntries(Object.entries(dimensions).map(([k, v]) => [k, v.score]));
  return {
    runId,
    experimentName: opts.experimentName,
    mode: opts.mode,
    cases: outcomes.length,
    errors: metrics.errors ?? 0,
    metrics,
    scores,
    dimensions,
    outcomes,
  };
}
