import { createRun, getRun, getRunResults, insertAudit, listCases, listDatasets, listRuns, setHumanReview } from '@rag/database';
import { QUEUES, type EvaluationJobData } from '@rag/rag';
import { AppError, evaluationRunRequestSchema, uuidSchema } from '@rag/shared';
import { getCorrelationId } from '@rag/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../context';
import { requireRole } from '../plugins/auth';

const humanReviewSchema = z.object({
  faithfulness: z.number().int().min(1).max(5),
  relevance: z.number().int().min(1).max(5),
  citations: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
});

export const evaluationRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const { db } = deps.runtime;
  const analyst = { onRequest: requireRole('analyst') };

  app.get('/evaluations/datasets', { ...analyst, schema: { tags: ['avaliação'] } }, async () => {
    const datasets = await listDatasets(db);
    const withCounts = await Promise.all(datasets.map(async (d) => ({ ...d, cases: (await listCases(db, d.id)).length })));
    return { items: withCounts };
  });

  app.get('/evaluations/runs', { ...analyst, schema: { tags: ['avaliação'] } }, async () => ({ items: await listRuns(db) }));

  app.get('/evaluations/runs/:id', { ...analyst, schema: { params: z.object({ id: uuidSchema }), tags: ['avaliação'] } }, async (req) => {
    const run = await getRun(db, req.params.id);
    if (!run) throw new AppError('NOT_FOUND', 'Execução não encontrada.');
    const results = await getRunResults(db, run.id);
    return {
      run,
      results: results.map(({ r, c }) => ({
        id: r.id,
        externalId: c.externalId,
        category: c.category,
        question: c.question,
        expectedBehavior: c.expectedBehavior,
        referenceAnswer: c.referenceAnswer,
        answer: r.answer,
        answerType: r.answerType,
        retrieved: r.retrieved,
        citations: r.citations,
        metrics: r.metrics,
        judge: r.judge,
        humanReview: r.humanReview,
        latencyMs: r.latencyMs,
        error: r.error,
      })),
    };
  });

  app.post('/evaluations/runs', { onRequest: requireRole('admin'), schema: { body: evaluationRunRequestSchema, tags: ['avaliação'] } }, async (req, reply) => {
    const runId = await createRun(db, { datasetId: req.body.datasetId, experimentName: req.body.experimentName, config: { overrides: req.body.overrides ?? {}, queued: true } });
    const data: EvaluationJobData = { datasetId: req.body.datasetId, experimentName: req.body.experimentName, overrides: req.body.overrides, runId };
    await deps.queues.evaluation.add(QUEUES.evaluation, data, { jobId: runId, attempts: 1 });
    await insertAudit(db, { actorId: req.principal.id, action: 'evaluation.run', entityType: 'evaluation_run', entityId: runId, ip: req.ip, correlationId: getCorrelationId() });
    return reply.status(202).send({ runId });
  });

  /** Avaliação humana de um resultado (complementa o juiz automático). */
  app.put(
    '/evaluations/results/:id/review',
    { ...analyst, schema: { params: z.object({ id: uuidSchema }), body: humanReviewSchema, tags: ['avaliação'] } },
    async (req, reply) => {
      const ok = await setHumanReview(db, req.params.id, { ...req.body, reviewer: req.principal.id, reviewedAt: new Date().toISOString() });
      if (!ok) throw new AppError('NOT_FOUND', 'Resultado não encontrado.');
      return reply.status(204).send();
    },
  );
};
