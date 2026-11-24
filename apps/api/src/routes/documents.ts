import {
  createCategory,
  getDocumentDetail,
  getDocumentRow,
  getVersionRow,
  hardDeleteDocument,
  insertAudit,
  listCategories,
  listChunks,
  listDocuments,
  listPages,
  listProcessingEvents,
  resetVersionForReprocess,
  detachCatalogDocument,
  softDeleteDocument,
  updateDocumentMetadata,
} from '@rag/database';
import {
  AppError,
  allowedAccessLevels,
  canAccess,
  categoryInputSchema,
  documentListQuerySchema,
  documentUpdateSchema,
  paginationQuerySchema,
  uuidSchema,
  type AccessLevel,
  type Principal,
} from '@rag/shared';
import { getCorrelationId } from '@rag/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../context';
import { requireRole } from '../plugins/auth';
import { enqueueIngestion, enqueueReembed, ingestUpload, receiveFile, uploadNewVersion } from '../services/documents';

const idParams = z.object({ id: uuidSchema });

/** Retorna o documento apenas se existir e estiver dentro da credencial; caso contrário, 404 (não revela existência). */
async function accessibleDocument(deps: AppDeps, id: string, principal: Principal) {
  const doc = await getDocumentRow(deps.runtime.db, id);
  if (!doc || !canAccess(principal.clearance, doc.accessLevel as AccessLevel)) throw new AppError('NOT_FOUND', 'Documento não encontrado.');
  return doc;
}

async function versionOf(deps: AppDeps, documentId: string, versionId: string | undefined, currentVersionId: string | null) {
  const id = versionId ?? currentVersionId;
  if (!id) throw new AppError('NOT_FOUND', 'Versão não encontrada.');
  const v = await getVersionRow(deps.runtime.db, id);
  if (!v || v.documentId !== documentId) throw new AppError('NOT_FOUND', 'Versão não encontrada.');
  return v;
}

export const documentRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const { db, storage } = deps.runtime;
  const audit = (req: { principal: Principal; ip: string }, action: string, entityId: string, details: Record<string, unknown> = {}) =>
    insertAudit(db, { actorId: req.principal.id, action, entityType: 'document', entityId, details, ip: req.ip, correlationId: getCorrelationId() });

  app.get('/documents', { schema: { querystring: documentListQuerySchema, tags: ['documentos'] } }, async (req) =>
    listDocuments(db, req.query, allowedAccessLevels(req.principal.clearance)),
  );

  app.post('/documents', { onRequest: requireRole('admin'), schema: { tags: ['documentos'], consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const file = await receiveFile(await req.file());
    const result = await ingestUpload(deps, file, req.principal, req.ip);
    return reply.status(result.status === 'accepted' ? 201 : 409).send(result);
  });

  app.get('/documents/:id', { schema: { params: idParams, tags: ['documentos'] } }, async (req) => {
    await accessibleDocument(deps, req.params.id, req.principal);
    const detail = await getDocumentDetail(db, req.params.id);
    if (!detail) throw new AppError('NOT_FOUND', 'Documento não encontrado.');
    return detail;
  });

  app.patch('/documents/:id', { onRequest: requireRole('admin'), schema: { params: idParams, body: documentUpdateSchema, tags: ['documentos'] } }, async (req) => {
    const doc = await accessibleDocument(deps, req.params.id, req.principal);
    if (req.body.accessLevel && !canAccess(req.principal.clearance, req.body.accessLevel)) {
      throw new AppError('FORBIDDEN', 'Não é possível atribuir um nível de acesso acima da sua credencial.');
    }
    const { headerChanged } = await updateDocumentMetadata(db, req.params.id, req.body);
    if (headerChanged && doc.currentVersionId) await enqueueReembed(deps, doc.currentVersionId);
    await audit(req, 'document.update', req.params.id, { fields: Object.keys(req.body), reembed: headerChanged });
    const detail = await getDocumentDetail(db, req.params.id);
    return { document: detail, reembedQueued: headerChanged };
  });

  app.delete(
    '/documents/:id',
    { onRequest: requireRole('admin'), schema: { params: idParams, querystring: z.object({ hard: z.enum(['true', 'false']).optional() }), tags: ['documentos'] } },
    async (req, reply) => {
      await accessibleDocument(deps, req.params.id, req.principal);
      await detachCatalogDocument(db, req.params.id);
      if (req.query.hard === 'true') {
        const res = await hardDeleteDocument(db, req.params.id);
        if (!res) throw new AppError('NOT_FOUND', 'Documento não encontrado.');
        const failures: string[] = [];
        for (const key of res.storageKeys) await storage.delete(key).catch(() => failures.push(key));
        if (failures.length) req.log.warn({ count: failures.length }, 'storage cleanup failed for some files');
        await audit(req, 'document.delete.hard', req.params.id, { files: res.storageKeys.length, storageFailures: failures.length });
      } else {
        await softDeleteDocument(db, req.params.id);
        await audit(req, 'document.delete.soft', req.params.id);
      }
      return reply.status(204).send();
    },
  );

  app.post('/documents/:id/detach', { onRequest: requireRole('admin'), schema: { params: idParams, tags: ['documentos'] } }, async (req, reply) => {
    await accessibleDocument(deps, req.params.id, req.principal);
    await detachCatalogDocument(db, req.params.id);
    const res = await hardDeleteDocument(db, req.params.id);
    if (!res) throw new AppError('NOT_FOUND', 'Documento não encontrado.');
    for (const key of res.storageKeys) await storage.delete(key).catch(() => {});
    await audit(req, 'document.detach', req.params.id, { files: res.storageKeys.length });
    return reply.status(204).send();
  });

  app.post('/documents/:id/reprocess', { onRequest: requireRole('admin'), schema: { params: idParams, tags: ['documentos'] } }, async (req, reply) => {
    const doc = await accessibleDocument(deps, req.params.id, req.principal);
    if (!doc.currentVersionId) throw new AppError('CONFLICT', 'Documento sem versão para reprocessar.');
    const version = await getVersionRow(db, doc.currentVersionId);
    if (version && !['completed', 'error', 'pending'].includes(version.status)) {
      throw new AppError('CONFLICT', 'O documento já está em processamento.');
    }
    await resetVersionForReprocess(db, doc.currentVersionId);
    const jobId = await enqueueIngestion(deps, doc.currentVersionId, 'reprocess');
    await audit(req, 'document.reprocess', req.params.id, { versionId: doc.currentVersionId });
    return reply.status(202).send({ jobId, versionId: doc.currentVersionId });
  });

  app.post('/documents/:id/versions', { onRequest: requireRole('admin'), schema: { params: idParams, tags: ['documentos'], consumes: ['multipart/form-data'] } }, async (req, reply) => {
    await accessibleDocument(deps, req.params.id, req.principal);
    const file = await receiveFile(await req.file());
    const result = await uploadNewVersion(deps, req.params.id, file, req.principal, req.ip);
    return reply.status(result.status === 'accepted' ? 201 : 409).send(result);
  });

  app.get(
    '/documents/:id/chunks',
    { schema: { params: idParams, querystring: paginationQuerySchema.extend({ versionId: uuidSchema.optional() }), tags: ['documentos'] } },
    async (req) => {
      const doc = await accessibleDocument(deps, req.params.id, req.principal);
      const v = await versionOf(deps, doc.id, req.query.versionId, doc.currentVersionId);
      return listChunks(db, v.id, req.query.page, req.query.pageSize);
    },
  );

  app.get('/documents/:id/pages', { schema: { params: idParams, querystring: z.object({ versionId: uuidSchema.optional() }), tags: ['documentos'] } }, async (req) => {
    const doc = await accessibleDocument(deps, req.params.id, req.principal);
    const v = await versionOf(deps, doc.id, req.query.versionId, doc.currentVersionId);
    return { versionId: v.id, pages: await listPages(db, v.id) };
  });

  app.get('/documents/:id/events', { schema: { params: idParams, tags: ['documentos'] } }, async (req) => {
    await accessibleDocument(deps, req.params.id, req.principal);
    return { items: await listProcessingEvents(db, req.params.id) };
  });

  /** Download/visualização do original. Conteúdo ativo nunca é executado: entregue com nosniff e sandbox. */
  app.get(
    '/documents/:id/file',
    { schema: { params: idParams, querystring: z.object({ versionId: uuidSchema.optional(), disposition: z.enum(['inline', 'attachment']).default('attachment') }), tags: ['documentos'] } },
    async (req, reply) => {
      const doc = await accessibleDocument(deps, req.params.id, req.principal);
      const v = await versionOf(deps, doc.id, req.query.versionId, doc.currentVersionId);
      const data = await storage.get(v.storageKey);
      const inline = req.query.disposition === 'inline' && v.format === 'pdf';
      const asciiName = v.fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
      await audit(req, 'document.download', doc.id, { versionId: v.id, inline });
      return reply
        .header('content-type', v.mimeType)
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(v.fileName)}`)
        .header('x-content-type-options', 'nosniff')
        // O visualizador de PDF do Chrome não abre sob "sandbox"; nos demais casos o arquivo é sempre anexo
        .header('content-security-policy', `${inline ? '' : 'sandbox; '}default-src 'none'; style-src 'unsafe-inline'; img-src data:`)
        .header('cache-control', 'private, no-store')
        .send(data);
    },
  );

  app.get('/categories', { schema: { tags: ['documentos'] } }, async () => ({ items: await listCategories(db) }));

  app.post('/categories', { onRequest: requireRole('admin'), schema: { body: categoryInputSchema, tags: ['documentos'] } }, async (req, reply) => {
    const created = await createCategory(db, req.body);
    await insertAudit(db, { actorId: req.principal.id, action: 'category.create', entityType: 'category', entityId: created.id, ip: req.ip, correlationId: getCorrelationId() });
    return reply.status(201).send(created);
  });
};
