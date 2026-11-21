import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
} from '@rag/database';
import { AppError, conversationCreateSchema, conversationListQuerySchema, conversationUpdateSchema, uuidSchema } from '@rag/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../context';

const idParams = z.object({ id: uuidSchema });

/** Conversas são sempre restritas ao próprio usuário (filtro por ownerId em todas as consultas). */
export const conversationRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const { db } = deps.runtime;

  app.get('/conversations', { schema: { querystring: conversationListQuerySchema, tags: ['conversas'] } }, async (req) =>
    listConversations(db, req.principal.id, req.query),
  );

  app.post('/conversations', { schema: { body: conversationCreateSchema, tags: ['conversas'] } }, async (req, reply) =>
    reply.status(201).send(await createConversation(db, req.principal.id, req.body.title)),
  );

  app.get('/conversations/:id/messages', { schema: { params: idParams, tags: ['conversas'] } }, async (req) => {
    const conv = await getConversation(db, req.params.id, req.principal.id);
    if (!conv) throw new AppError('NOT_FOUND', 'Conversa não encontrada.');
    return { conversation: { id: conv.id, title: conv.title }, items: await listMessages(db, conv.id, req.principal.clearance) };
  });

  app.patch('/conversations/:id', { schema: { params: idParams, body: conversationUpdateSchema, tags: ['conversas'] } }, async (req, reply) => {
    await renameConversation(db, req.params.id, req.principal.id, req.body.title);
    return reply.status(204).send();
  });

  app.delete('/conversations/:id', { schema: { params: idParams, tags: ['conversas'] } }, async (req, reply) => {
    await deleteConversation(db, req.params.id, req.principal.id);
    return reply.status(204).send();
  });
};
