import {
  AppError,
  allowedAccessLevels,
  type AccessLevel,
  type AnswerType,
  type CitationDto,
  type ConversationDto,
  type FeedbackInput,
  type GroundingReportDto,
  type MessageDto,
  type MessageStatus,
  type Paginated,
  type SourceDto,
} from '@rag/shared';
import { and, asc, count, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { conversations, documents, messageCitations, messages, userFeedback } from '../schema';

export async function createConversation(db: Database, ownerId: string, title?: string): Promise<ConversationDto> {
  const [row] = await db
    .insert(conversations)
    .values({ ownerId, title: title?.trim() || 'Nova conversa' })
    .returning();
  return {
    id: row!.id,
    title: row!.title,
    createdAt: row!.createdAt.toISOString(),
    updatedAt: row!.updatedAt.toISOString(),
    lastMessagePreview: null,
  };
}

export async function getConversation(db: Database, id: string, ownerId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.ownerId, ownerId), isNull(conversations.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listConversations(
  db: Database,
  ownerId: string,
  opts: { q?: string; page: number; pageSize: number },
): Promise<Paginated<ConversationDto>> {
  const filters = [eq(conversations.ownerId, ownerId), isNull(conversations.deletedAt)];
  if (opts.q) filters.push(ilike(conversations.title, `%${opts.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
  const where = and(...filters);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        c: conversations,
        preview: sql<string | null>`(
          SELECT left(m.content, 140) FROM messages m
          WHERE m.conversation_id = ${conversations.id} ORDER BY m.created_at DESC LIMIT 1)`,
      })
      .from(conversations)
      .where(where)
      .orderBy(desc(conversations.updatedAt))
      .limit(opts.pageSize)
      .offset((opts.page - 1) * opts.pageSize),
    db.select({ total: count() }).from(conversations).where(where),
  ]);
  return {
    items: rows.map(({ c, preview }) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      lastMessagePreview: preview,
    })),
    page: opts.page,
    pageSize: opts.pageSize,
    total: Number(totalRow?.total ?? 0),
  };
}

export async function renameConversation(db: Database, id: string, ownerId: string, title: string): Promise<void> {
  const updated = await db
    .update(conversations)
    .set({ title })
    .where(and(eq(conversations.id, id), eq(conversations.ownerId, ownerId), isNull(conversations.deletedAt)))
    .returning({ id: conversations.id });
  if (updated.length === 0) throw new AppError('NOT_FOUND', 'Conversa não encontrada');
}

export async function deleteConversation(db: Database, id: string, ownerId: string): Promise<void> {
  const updated = await db
    .update(conversations)
    .set({ deletedAt: new Date() })
    .where(and(eq(conversations.id, id), eq(conversations.ownerId, ownerId), isNull(conversations.deletedAt)))
    .returning({ id: conversations.id });
  if (updated.length === 0) throw new AppError('NOT_FOUND', 'Conversa não encontrada');
}

export async function touchConversation(db: Database, id: string): Promise<void> {
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));
}

export async function insertMessage(
  db: Database,
  input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    status?: MessageStatus;
    parentMessageId?: string | null;
    correlationId?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      status: input.status ?? 'completed',
      parentMessageId: input.parentMessageId ?? null,
      correlationId: input.correlationId ?? null,
    })
    .returning({ id: messages.id });
  return row!.id;
}

export async function getMessage(db: Database, id: string) {
  const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  return row ?? null;
}

export async function finalizeAssistantMessage(
  db: Database,
  id: string,
  data: {
    content: string;
    status: MessageStatus;
    answerType: AnswerType | null;
    rewrittenQuery: string | null;
    model: string | null;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    grounding: GroundingReportDto | null;
    sources: SourceDto[];
    citations: Omit<CitationDto, 'id' | 'documentTitle' | 'documentNumber' | 'available'>[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(messages)
      .set({
        content: data.content,
        status: data.status,
        answerType: data.answerType,
        rewrittenQuery: data.rewrittenQuery,
        model: data.model,
        tokensIn: data.tokensIn,
        tokensOut: data.tokensOut,
        latencyMs: data.latencyMs,
        grounding: data.grounding as unknown as Record<string, unknown> | null,
        sources: data.sources,
      })
      .where(eq(messages.id, id));
    await tx.delete(messageCitations).where(eq(messageCitations.messageId, id));
    if (data.citations.length > 0) {
      await tx.insert(messageCitations).values(
        data.citations.map((c) => ({
          messageId: id,
          sourceNumber: c.sourceNumber,
          chunkId: c.chunkId,
          documentId: c.documentId,
          versionId: c.versionId,
          page: c.page,
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
          quote: c.quote,
          valid: c.valid,
          supportScore: c.supportScore,
        })),
      );
    }
  });
}

/**
 * Lista mensagens com citações. Citações e fontes de documentos que foram excluídos,
 * desativados ou que estão acima da credencial do usuário são marcadas como indisponíveis
 * e têm o trecho ocultado.
 */
export async function listMessages(db: Database, conversationId: string, clearance: AccessLevel): Promise<MessageDto[]> {
  const rows = await db
    .select({ m: messages, rating: userFeedback.rating })
    .from(messages)
    .leftJoin(userFeedback, eq(userFeedback.messageId, messages.id))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.m.id);
  const citationRows = await db
    .select({ c: messageCitations, d: documents })
    .from(messageCitations)
    .leftJoin(documents, eq(documents.id, messageCitations.documentId))
    .where(inArray(messageCitations.messageId, ids))
    .orderBy(asc(messageCitations.sourceNumber));

  const allowed = new Set<string>(allowedAccessLevels(clearance));
  const docIds = new Set<string>();
  for (const r of rows) for (const s of (r.m.sources as SourceDto[]) ?? []) docIds.add(s.documentId);
  const docRows = docIds.size
    ? await db
        .select({ id: documents.id, isActive: documents.isActive, deletedAt: documents.deletedAt, accessLevel: documents.accessLevel })
        .from(documents)
        .where(inArray(documents.id, [...docIds]))
    : [];
  const availableDocs = new Set(
    docRows.filter((d) => d.isActive && !d.deletedAt && allowed.has(d.accessLevel)).map((d) => d.id),
  );

  const citationsByMessage = new Map<string, CitationDto[]>();
  for (const { c, d } of citationRows) {
    const available = !!d && d.isActive && !d.deletedAt && allowed.has(d.accessLevel);
    const list = citationsByMessage.get(c.messageId) ?? [];
    list.push({
      id: c.id,
      sourceNumber: c.sourceNumber,
      chunkId: c.chunkId ?? '',
      documentId: c.documentId ?? '',
      versionId: c.versionId ?? '',
      documentTitle: available ? d!.title : 'Documento indisponível',
      documentNumber: available ? d!.documentNumber : null,
      page: c.page,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      quote: available ? c.quote : '',
      valid: c.valid,
      supportScore: c.supportScore,
      available,
    });
    citationsByMessage.set(c.messageId, list);
  }

  return rows.map(({ m, rating }) => ({
    id: m.id,
    conversationId: m.conversationId,
    role: m.role as 'user' | 'assistant',
    content: m.content,
    status: m.status as MessageStatus,
    answerType: (m.answerType as AnswerType | null) ?? null,
    rewrittenQuery: m.rewrittenQuery,
    parentMessageId: m.parentMessageId,
    citations: citationsByMessage.get(m.id) ?? [],
    sources: ((m.sources as SourceDto[]) ?? []).map((s) =>
      availableDocs.has(s.documentId) ? s : { ...s, excerpt: '', documentTitle: 'Documento indisponível' },
    ),
    grounding: (m.grounding as GroundingReportDto | null) ?? null,
    feedback: (rating as 1 | -1 | null) ?? null,
    createdAt: m.createdAt.toISOString(),
  }));
}

/** Histórico recente (mais novo por último) para gerenciamento de contexto. */
export async function recentHistory(db: Database, conversationId: string, limit: number, beforeMessageId?: string) {
  if (limit <= 0) return [];
  const rows = await db
    .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt, status: messages.status })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        beforeMessageId
          ? sql`${messages.createdAt} < (SELECT created_at FROM messages WHERE id = ${beforeMessageId})`
          : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows
    .filter((r) => r.status === 'completed' && r.content.trim().length > 0)
    .reverse()
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
}

export async function upsertFeedback(db: Database, messageId: string, input: FeedbackInput, actorId: string): Promise<void> {
  await db
    .insert(userFeedback)
    .values({ messageId, rating: input.rating, reason: input.reason ?? null, comment: input.comment ?? null, actorId })
    .onConflictDoUpdate({
      target: userFeedback.messageId,
      set: { rating: input.rating, reason: input.reason ?? null, comment: input.comment ?? null, updatedAt: new Date() },
    });
}
