import type { DashboardDto } from '@rag/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { auditLogs, documentCategories, documentVersions, documents, evaluationRuns, llmUsage, retrievalLogs } from '../schema';
import { toDocumentDto } from './mappers';

export type RetrievalLogInput = typeof retrievalLogs.$inferInsert;
export type UsageInput = typeof llmUsage.$inferInsert;

export async function insertRetrievalLog(db: Database, input: RetrievalLogInput): Promise<void> {
  await db.insert(retrievalLogs).values(input);
}

export async function insertUsage(db: Database, input: UsageInput): Promise<void> {
  await db.insert(llmUsage).values(input);
}

export async function tokensUsedSince(db: Database, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${llmUsage.tokensIn} + ${llmUsage.tokensOut}), 0)` })
    .from(llmUsage)
    .where(sql`${llmUsage.createdAt} >= ${since}`);
  return Number(row?.total ?? 0);
}

export async function insertAudit(
  db: Database,
  entry: { actorId: string; action: string; entityType: string; entityId?: string | null; details?: Record<string, unknown>; ip?: string | null; correlationId?: string | null },
): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    details: entry.details ?? {},
    ip: entry.ip ?? null,
    correlationId: entry.correlationId ?? null,
  });
}

export async function listAudit(db: Database, limit = 100) {
  return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
}

export async function getDashboard(db: Database): Promise<DashboardDto> {
  const [docStats] = await db.execute<Record<string, string>>(sql`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE v.status = 'completed') AS completed,
      count(*) FILTER (WHERE v.status = 'pending') AS pending,
      count(*) FILTER (WHERE v.status NOT IN ('pending','completed','error')) AS processing,
      count(*) FILTER (WHERE v.status = 'error') AS error,
      count(*) FILTER (WHERE NOT d.is_active) AS inactive
    FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id
    WHERE d.deleted_at IS NULL`);
  const [misc] = await db.execute<Record<string, string | null>>(sql`
    SELECT
      (SELECT count(*) FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.deleted_at IS NULL) AS chunks,
      (SELECT coalesce(sum(v.size_bytes), 0) FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.deleted_at IS NULL) AS storage,
      (SELECT avg(processing_ms) FROM document_versions WHERE status = 'completed') AS avg_processing,
      (SELECT count(*) FROM retrieval_logs) AS queries_total,
      (SELECT count(*) FROM retrieval_logs WHERE created_at > now() - interval '24 hours') AS queries_24h,
      (SELECT avg(CASE WHEN no_evidence THEN 1.0 ELSE 0.0 END) FROM retrieval_logs) AS no_evidence_rate,
      (SELECT avg((timings->>'total')::numeric) FROM retrieval_logs WHERE timings ? 'total') AS avg_latency,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings->>'total')::numeric) FROM retrieval_logs WHERE timings ? 'total') AS p95_latency,
      (SELECT count(*) FROM user_feedback WHERE rating = 1) AS fb_pos,
      (SELECT count(*) FROM user_feedback WHERE rating = -1) AS fb_neg,
      (SELECT coalesce(sum(tokens_in), 0) FROM llm_usage WHERE created_at > now() - interval '24 hours') AS tin,
      (SELECT coalesce(sum(tokens_out), 0) FROM llm_usage WHERE created_at > now() - interval '24 hours') AS tout,
      (SELECT coalesce(sum(cost_usd), 0) FROM llm_usage WHERE created_at > now() - interval '24 hours') AS cost`);

  const recent = await db
    .select({ d: documents, v: documentVersions, categoryName: documentCategories.name })
    .from(documents)
    .leftJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .leftJoin(documentCategories, eq(documentCategories.id, documents.categoryId))
    .where(sql`${documents.deletedAt} IS NULL`)
    .orderBy(desc(documents.createdAt))
    .limit(8);

  const [evalRun] = await db
    .select()
    .from(evaluationRuns)
    .where(eq(evaluationRuns.status, 'completed'))
    .orderBy(desc(evaluationRuns.finishedAt))
    .limit(1);

  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    documents: {
      total: Number(docStats?.total ?? 0),
      completed: Number(docStats?.completed ?? 0),
      pending: Number(docStats?.pending ?? 0),
      processing: Number(docStats?.processing ?? 0),
      error: Number(docStats?.error ?? 0),
      inactive: Number(docStats?.inactive ?? 0),
    },
    chunks: Number(misc?.chunks ?? 0),
    storageBytes: Number(misc?.storage ?? 0),
    avgProcessingMs: n(misc?.avg_processing),
    queries: {
      total: Number(misc?.queries_total ?? 0),
      last24h: Number(misc?.queries_24h ?? 0),
      noEvidenceRate: n(misc?.no_evidence_rate),
      avgLatencyMs: n(misc?.avg_latency),
      p95LatencyMs: n(misc?.p95_latency),
    },
    feedback: { positive: Number(misc?.fb_pos ?? 0), negative: Number(misc?.fb_neg ?? 0) },
    recentDocuments: recent.map((r) => toDocumentDto(r.d, r.v, r.categoryName)),
    latestEvaluation: evalRun
      ? {
          runId: evalRun.id,
          experimentName: evalRun.experimentName,
          finishedAt: evalRun.finishedAt?.toISOString() ?? null,
          scores: evalRun.scores,
        }
      : null,
    usage: { tokensIn24h: Number(misc?.tin ?? 0), tokensOut24h: Number(misc?.tout ?? 0), estimatedCostUsd24h: Number(misc?.cost ?? 0) },
  };
}

/** Série temporal de métricas operacionais por hora (últimos N dias). */
export async function getMetricsTimeseries(db: Database, days: number) {
  const safeDays = Math.max(1, Math.min(90, Math.floor(days)));
  const queries = await db.execute<Record<string, string>>(sql`
    SELECT date_trunc('hour', created_at) AS bucket,
      count(*) AS queries,
      avg(CASE WHEN no_evidence THEN 1.0 ELSE 0.0 END) AS no_evidence_rate,
      avg((timings->>'retrieval')::numeric) AS retrieval_ms,
      avg((timings->>'rerank')::numeric) AS rerank_ms,
      avg((timings->>'generation')::numeric) AS generation_ms,
      avg((timings->>'total')::numeric) AS total_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY (timings->>'total')::numeric) AS p95_ms,
      sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(cost_usd) AS cost_usd,
      count(*) FILTER (WHERE error IS NOT NULL) AS errors
    FROM retrieval_logs
    WHERE created_at > now() - make_interval(days => ${safeDays})
    GROUP BY 1 ORDER BY 1`);
  const ingestion = await db.execute<Record<string, string>>(sql`
    SELECT date_trunc('hour', created_at) AS bucket,
      count(*) FILTER (WHERE status = 'completed') AS completed,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      avg(extract(epoch FROM (finished_at - started_at)) * 1000) FILTER (WHERE status = 'completed') AS avg_ms
    FROM document_processing_jobs
    WHERE created_at > now() - make_interval(days => ${safeDays})
    GROUP BY 1 ORDER BY 1`);
  const feedback = await db.execute<Record<string, string>>(sql`
    SELECT date_trunc('day', created_at) AS bucket,
      count(*) FILTER (WHERE rating = 1) AS positive, count(*) FILTER (WHERE rating = -1) AS negative
    FROM user_feedback WHERE created_at > now() - make_interval(days => ${safeDays})
    GROUP BY 1 ORDER BY 1`);
  const toNum = (rows: Record<string, unknown>[]) =>
    rows.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, k === 'bucket' ? new Date(v as string).toISOString() : v === null ? null : Number(v)]),
      ),
    );
  return { queries: toNum(queries), ingestion: toNum(ingestion), feedback: toNum(feedback) };
}

export async function listRecentRetrievals(db: Database, limit = 50) {
  return db
    .select({
      id: retrievalLogs.id,
      messageId: retrievalLogs.messageId,
      correlationId: retrievalLogs.correlationId,
      mode: retrievalLogs.mode,
      rewritten: retrievalLogs.rewritten,
      vectorCandidates: retrievalLogs.vectorCandidates,
      lexicalCandidates: retrievalLogs.lexicalCandidates,
      fusedCandidates: retrievalLogs.fusedCandidates,
      rerankedCandidates: retrievalLogs.rerankedCandidates,
      selected: retrievalLogs.selected,
      timings: retrievalLogs.timings,
      tokensIn: retrievalLogs.tokensIn,
      tokensOut: retrievalLogs.tokensOut,
      costUsd: retrievalLogs.costUsd,
      noEvidence: retrievalLogs.noEvidence,
      answerType: retrievalLogs.answerType,
      chatModel: retrievalLogs.chatModel,
      error: retrievalLogs.error,
      createdAt: retrievalLogs.createdAt,
    })
    .from(retrievalLogs)
    .orderBy(desc(retrievalLogs.createdAt))
    .limit(limit);
}
