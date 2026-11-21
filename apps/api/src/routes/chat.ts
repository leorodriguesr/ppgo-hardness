import {
  createConversation,
  finalizeAssistantMessage,
  getConversation,
  getDocumentRow,
  getMessage,
  getVersionRow,
  insertMessage,
  insertRetrievalLog,
  listMessages,
  listPages,
  recentHistory,
  touchConversation,
  upsertFeedback,
  getChunkRow,
} from '@rag/database';
import type { EngineResult } from '@rag/rag';
import { AppError, canAccess, chatRequestSchema, feedbackSchema, isAppError, uuidSchema, type AccessLevel, type ChatStreamEvent } from '@rag/shared';
import { getCorrelationId } from '@rag/shared/server';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../context';

export const chatRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const { db, env, engine, settings } = deps.runtime;

  app.post(
    '/chat',
    {
      config: { rateLimit: { max: env.CHAT_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
      schema: { body: chatRequestSchema, tags: ['chat'] },
    },
    async (req, reply) => {
      const principal = req.principal;
      const body = req.body;
      if (body.content.length > env.MAX_QUESTION_CHARS) {
        throw new AppError('VALIDATION_ERROR', `A pergunta excede o limite de ${env.MAX_QUESTION_CHARS} caracteres.`);
      }
      await deps.runtime.assertBudget();
      const cfg = await settings.get();

      // Conversa (sempre do próprio usuário)
      let conversationId = body.conversationId;
      if (conversationId) {
        if (!(await getConversation(db, conversationId, principal.id))) throw new AppError('NOT_FOUND', 'Conversa não encontrada.');
      } else {
        const title = body.content.replace(/\s+/g, ' ').trim().slice(0, 80);
        conversationId = (await createConversation(db, principal.id, title)).id;
      }

      // Pergunta: nova ou regeneração de uma resposta existente
      let userMessageId: string;
      let question: string;
      if (body.regenerateFromMessageId) {
        const target = await getMessage(db, body.regenerateFromMessageId);
        if (!target || target.conversationId !== conversationId) throw new AppError('NOT_FOUND', 'Mensagem não encontrada.');
        const userMsg = target.role === 'user' ? target : target.parentMessageId ? await getMessage(db, target.parentMessageId) : null;
        if (!userMsg || userMsg.role !== 'user') throw new AppError('VALIDATION_ERROR', 'Não foi possível identificar a pergunta a regenerar.');
        userMessageId = userMsg.id;
        question = userMsg.content;
      } else {
        question = body.content;
        userMessageId = await insertMessage(db, { conversationId, role: 'user', content: question, correlationId: req.id });
      }
      const history = await recentHistory(db, conversationId, cfg.rewrite.historyMessages, userMessageId);
      const assistantMessageId = await insertMessage(db, {
        conversationId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        parentMessageId: userMessageId,
        correlationId: req.id,
      });

      // Streaming SSE
      const res = reply.raw;
      reply.hijack();
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-correlation-id': req.id,
      });
      const send = (event: ChatStreamEvent) => {
        if (!res.writableEnded && !res.destroyed) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort(new Error('cliente desconectou'));
      });
      const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000);

      send({ type: 'meta', conversationId, userMessageId, assistantMessageId, correlationId: req.id });
      const started = performance.now();
      let partial = '';
      let result: EngineResult | null = null;
      try {
        const gen = engine.answer({
          question,
          history,
          filters: body.filters,
          principal,
          signal: controller.signal,
          answerCacheMode: body.regenerateFromMessageId ? 'refresh' : 'default',
        });
        for (;;) {
          const next = await gen.next();
          if (next.done) {
            result = next.value;
            break;
          }
          const ev = next.value;
          if (ev.type === 'token') partial += ev.text;
          send(ev);
        }
        const latencyMs = Math.round(performance.now() - started);
        await finalizeAssistantMessage(db, assistantMessageId, {
          content: result.content,
          status: 'completed',
          answerType: result.answerType,
          rewrittenQuery: result.rewrittenQuery,
          model: result.model,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          latencyMs,
          grounding: result.grounding,
          sources: result.sources,
          citations: result.citations,
        });
        await insertRetrievalLog(db, {
          messageId: assistantMessageId,
          correlationId: req.id,
          mode: cfg.retrieval.mode,
          rewritten: result.rewrittenQuery !== null,
          filters: { ...(body.filters ?? {}), includeHistorical: result.includeHistorical, clearance: principal.clearance },
          vectorCandidates: result.retrieval.vectorCandidates,
          lexicalCandidates: result.retrieval.lexicalCandidates,
          fusedCandidates: result.retrieval.fusedCandidates,
          rerankedCandidates: result.retrieval.rerankedCandidates,
          selected: result.sources.map((s) => ({ chunkId: s.chunkId, documentId: s.documentId, score: s.score })),
          timings: { ...result.timings, total: latencyMs },
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          costUsd: result.usage.costUsd,
          noEvidence: result.answerType === 'insufficient_evidence',
          answerType: result.answerType,
          embeddingModelId: result.embeddingModelId,
          chatModel: result.model,
        });
        await touchConversation(db, conversationId);
        const message = (await listMessages(db, conversationId, principal.clearance)).find((m) => m.id === assistantMessageId);
        if (message) send({ type: 'done', message });
      } catch (err) {
        const cancelled = controller.signal.aborted;
        const latencyMs = Math.round(performance.now() - started);
        await finalizeAssistantMessage(db, assistantMessageId, {
          content: partial,
          status: cancelled ? 'cancelled' : 'error',
          answerType: cancelled ? null : 'error',
          rewrittenQuery: null,
          model: null,
          tokensIn: 0,
          tokensOut: 0,
          latencyMs,
          grounding: null,
          sources: [],
          citations: [],
        }).catch((e) => req.log.error({ err: e }, 'failed to finalize message'));
        await insertRetrievalLog(db, {
          messageId: assistantMessageId,
          correlationId: req.id,
          mode: cfg.retrieval.mode,
          timings: { total: latencyMs },
          error: cancelled ? 'cancelled' : err instanceof Error ? err.message.slice(0, 500) : 'erro',
        }).catch(() => {});
        if (!cancelled) {
          req.log.error({ err }, 'chat failed');
          send({
            type: 'error',
            code: isAppError(err) ? err.code : 'PROVIDER_ERROR',
            message: isAppError(err)
              ? err.message
              : 'Não foi possível gerar a resposta agora (serviço de IA indisponível). Tente novamente em instantes.',
          });
        }
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    },
  );

  app.post(
    '/messages/:id/feedback',
    { schema: { params: z.object({ id: uuidSchema }), body: feedbackSchema, tags: ['chat'] } },
    async (req, reply) => {
      const msg = await getMessage(db, req.params.id);
      if (!msg || msg.role !== 'assistant' || !(await getConversation(db, msg.conversationId, req.principal.id))) {
        throw new AppError('NOT_FOUND', 'Mensagem não encontrada.');
      }
      await upsertFeedback(db, msg.id, req.body, req.principal.id);
      return reply.status(204).send();
    },
  );

  /**
   * Fonte citada: trecho, metadados e texto das páginas correspondentes, para o painel lateral.
   * A credencial é verificada novamente (a citação pode ter sido gerada antes de mudanças de acesso).
   */
  app.get('/sources/:chunkId', { schema: { params: z.object({ chunkId: uuidSchema }), tags: ['chat'] } }, async (req) => {
    const chunk = await getChunkRow(db, req.params.chunkId);
    const doc = chunk ? await getDocumentRow(db, chunk.documentId) : null;
    if (!chunk || !doc || !doc.isActive || !canAccess(req.principal.clearance, doc.accessLevel as AccessLevel)) {
      throw new AppError('NOT_FOUND', 'Fonte indisponível (removida, desativada ou sem permissão de acesso).');
    }
    const version = await getVersionRow(db, chunk.versionId);
    const pages = (await listPages(db, chunk.versionId)).filter(
      (p) => chunk.pageStart === null || (p.pageNumber >= chunk.pageStart && p.pageNumber <= (chunk.pageEnd ?? chunk.pageStart)),
    );
    return {
      chunk: {
        id: chunk.id,
        content: chunk.content,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        headingPath: chunk.headingPath,
        sectionTitle: chunk.sectionTitle,
        structuralRef: chunk.structuralRef,
        flags: chunk.flags,
      },
      document: {
        id: doc.id,
        title: doc.title,
        documentNumber: doc.documentNumber,
        documentType: doc.documentType,
        validityStatus: doc.validityStatus,
        publicationDate: doc.publicationDate,
        issuingBody: doc.issuingBody,
        accessLevel: doc.accessLevel,
      },
      version: version
        ? { id: version.id, versionNumber: version.versionNumber, isCurrent: version.isCurrent, format: version.format, fileName: version.fileName, pageCount: version.pageCount }
        : null,
      pages: chunk.pageStart === null ? pages.slice(0, 1) : pages,
      correlationId: getCorrelationId(),
    };
  });
};
