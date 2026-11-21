import {
  activateEmbeddingModel,
  findOrCreateEmbeddingModel,
  getDashboard,
  getEmbeddingModel,
  getMetricsTimeseries,
  getRagSettings,
  insertAudit,
  listAudit,
  listEmbeddingModels,
  listRecentRetrievals,
  saveRagSettings,
} from '@rag/database';
import type { EmbeddingJobData } from '@rag/rag';
import { AppError, embeddingModelCreateSchema, settingsUpdateSchema, uuidSchema } from '@rag/shared';
import { getCorrelationId } from '@rag/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../context';
import { requireRole } from '../plugins/auth';
import { readinessChecks } from './health';

export const adminRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const { db, settings, env } = deps.runtime;
  const admin = { onRequest: requireRole('admin') };
  const analyst = { onRequest: requireRole('analyst') };

  app.get('/me', { schema: { tags: ['admin'] } }, async (req) => ({ principal: req.principal }));

  app.get('/settings', { ...analyst, schema: { tags: ['admin'] } }, async () => {
    const current = await getRagSettings(db, settings.getDefaults());
    return { ...current, defaults: settings.getDefaults(), embedding: { provider: env.EMBEDDING_PROVIDER, model: env.EMBEDDING_MODEL, dimensions: env.EMBEDDING_DIMENSIONS } };
  });

  /** Embeddings não são alterados aqui: troca de modelo exige migração (ver /embedding-models). */
  app.put('/settings', { ...admin, schema: { body: settingsUpdateSchema, tags: ['admin'] } }, async (req) => {
    const saved = await saveRagSettings(db, req.body.settings, req.body.expectedVersion, req.principal.id);
    settings.invalidate();
    await insertAudit(db, {
      actorId: req.principal.id,
      action: 'settings.update',
      entityType: 'settings',
      entityId: 'rag',
      details: { version: saved.version },
      ip: req.ip,
      correlationId: getCorrelationId(),
    });
    return saved;
  });

  app.get('/embedding-models', { ...analyst, schema: { tags: ['admin'] } }, async () => ({ items: await listEmbeddingModels(db) }));

  /** Cadastra um novo modelo e inicia a migração (gera vetores sem afetar o modelo ativo). */
  app.post('/embedding-models', { ...admin, schema: { body: embeddingModelCreateSchema, tags: ['admin'] } }, async (req, reply) => {
    const model = await findOrCreateEmbeddingModel(db, req.body);
    if (model.status === 'active') throw new AppError('CONFLICT', 'Este modelo já é o modelo ativo.');
    const data: EmbeddingJobData = { kind: 'model_migration', modelId: model.id, correlationId: getCorrelationId() };
    await deps.queues.embeddings.add('model_migration', data, { jobId: `migration-${model.id}-${Date.now()}`, attempts: 2, backoff: { type: 'exponential', delay: 30_000 } });
    await insertAudit(db, { actorId: req.principal.id, action: 'embedding_model.migrate', entityType: 'embedding_model', entityId: model.id, details: req.body, ip: req.ip, correlationId: getCorrelationId() });
    return reply.status(202).send({ model, queued: true });
  });

  /** Ativação só é permitida com cobertura completa: nunca se misturam vetores de modelos diferentes. */
  app.post('/embedding-models/:id/activate', { ...admin, schema: { params: z.object({ id: uuidSchema }), tags: ['admin'] } }, async (req) => {
    const model = await getEmbeddingModel(db, req.params.id);
    if (!model) throw new AppError('NOT_FOUND', 'Modelo não encontrado.');
    const listed = (await listEmbeddingModels(db)).find((m) => m.id === model.id);
    if (model.status !== 'ready' || !listed || listed.embeddedChunks < listed.totalChunks) {
      throw new AppError('CONFLICT', 'O modelo só pode ser ativado após gerar embeddings para todos os trechos.', {
        status: model.status,
        embedded: listed?.embeddedChunks,
        total: listed?.totalChunks,
      });
    }
    await activateEmbeddingModel(db, model.id);
    await insertAudit(db, { actorId: req.principal.id, action: 'embedding_model.activate', entityType: 'embedding_model', entityId: model.id, ip: req.ip, correlationId: getCorrelationId() });
    return { activated: true };
  });

  app.get('/metrics/dashboard', { ...analyst, schema: { tags: ['métricas'] } }, async () => getDashboard(db));

  app.get(
    '/metrics/timeseries',
    { ...analyst, schema: { querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }), tags: ['métricas'] } },
    async (req) => getMetricsTimeseries(db, req.query.days),
  );

  app.get(
    '/metrics/retrievals',
    { ...analyst, schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), tags: ['métricas'] } },
    async (req) => ({ items: await listRecentRetrievals(db, req.query.limit) }),
  );

  app.get('/system/health', { ...analyst, schema: { tags: ['métricas'] } }, async () => {
    const checks = await readinessChecks(deps, true);
    const counts = await Promise.all(
      Object.entries(deps.queues).map(async ([name, q]) => [name, await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')] as const),
    );
    return { checks, queues: Object.fromEntries(counts) };
  });

  app.get(
    '/audit',
    { ...admin, schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), tags: ['admin'] } },
    async (req) => ({ items: await listAudit(db, req.query.limit) }),
  );
};
