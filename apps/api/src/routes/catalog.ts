import { getCatalogRelations, getCatalogSyncState, listCatalogActs } from '@rag/database';
import { allowedAccessLevels, catalogListQuerySchema, uuidSchema } from '@rag/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../context';
import { requireRole } from '../plugins/auth';
import { receiveFile } from '../services/documents';
import { ingestCatalogAct, ingestCatalogUpload } from '../services/catalog';

const sourceSchema = z.object({ source: z.enum(['legisla', 'site']).default('legisla') });

export const catalogRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get('/catalog', { schema: { querystring: catalogListQuerySchema, tags: ['catalogo'] } }, async (req) =>
    listCatalogActs(deps.runtime.db, req.query, allowedAccessLevels(req.principal.clearance)),
  );

  app.get('/catalog/sync', { onRequest: requireRole('admin'), schema: { tags: ['catalogo'] } }, async () => getCatalogSyncState(deps.runtime.db));

  app.get(
    '/catalog/links',
    {
      schema: {
        querystring: z
          .object({
            source: z.enum(['legisla', 'site']).optional(),
            externalId: z.coerce.number().int().positive().optional(),
            documentId: uuidSchema.optional(),
          })
          .refine((query) => query.documentId != null || (query.source != null && query.externalId != null), 'Informe o documento ou o ato.'),
        tags: ['catalogo'],
      },
    },
    async (req) => {
      if (req.query.documentId) return getCatalogRelations(deps.runtime.db, { documentId: req.query.documentId });
      return getCatalogRelations(deps.runtime.db, { source: req.query.source ?? 'legisla', externalId: req.query.externalId ?? 0 });
    },
  );

  app.post('/catalog/sync', { onRequest: requireRole('admin'), schema: { tags: ['catalogo'] } }, async (_req, reply) => {
    try {
      await deps.queues.catalogSync.add('sync', {}, { jobId: 'catalog-sync-manual', removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      if (err instanceof Error && /already exists|job/i.test(err.message)) return { queued: false };
      throw err;
    }
    return reply.status(202).send({ queued: true });
  });

  app.post(
    '/catalog/:externalId/ingest',
    {
      onRequest: requireRole('admin'),
      schema: { params: z.object({ externalId: z.coerce.number().int().positive() }), querystring: sourceSchema, tags: ['catalogo'] },
    },
    async (req) => ingestCatalogAct(deps, req.params.externalId, req.query.source, req.principal, req.ip),
  );

  app.post(
    '/catalog/:externalId/file',
    {
      onRequest: requireRole('admin'),
      schema: {
        params: z.object({ externalId: z.coerce.number().int().positive() }),
        querystring: sourceSchema,
        tags: ['catalogo'],
        consumes: ['multipart/form-data'],
      },
    },
    async (req, reply) => {
      const file = await receiveFile(await req.file());
      const result = await ingestCatalogUpload(deps, req.params.externalId, req.query.source, file, req.principal, req.ip);
      return reply.status(result.status === 'accepted' ? 201 : 409).send(result);
    },
  );
};
