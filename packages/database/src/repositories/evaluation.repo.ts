import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { evaluationCases, evaluationDatasets, evaluationResults, evaluationRuns } from '../schema';

export type EvaluationCaseRow = typeof evaluationCases.$inferSelect;
export type EvaluationCaseInput = Omit<typeof evaluationCases.$inferInsert, 'datasetId' | 'id'>;

/** Cria ou atualiza um dataset e sincroniza seus casos pelo identificador externo. */
export async function upsertDataset(
  db: Database,
  input: { name: string; split: 'dev' | 'validation'; description?: string; version: number },
  cases: EvaluationCaseInput[],
): Promise<string> {
  return db.transaction(async (tx) => {
    const [ds] = await tx
      .insert(evaluationDatasets)
      .values(input)
      .onConflictDoUpdate({
        target: evaluationDatasets.name,
        set: { split: input.split, description: input.description ?? null, version: input.version },
      })
      .returning({ id: evaluationDatasets.id });
    const datasetId = ds!.id;
    for (const c of cases) {
      await tx
        .insert(evaluationCases)
        .values({ ...c, datasetId })
        .onConflictDoUpdate({
          target: [evaluationCases.datasetId, evaluationCases.externalId],
          set: {
            category: c.category,
            question: c.question,
            history: c.history ?? [],
            expectedBehavior: c.expectedBehavior,
            referenceAnswer: c.referenceAnswer ?? null,
            relevant: c.relevant ?? [],
            requiredFacts: c.requiredFacts ?? [],
            forbidden: c.forbidden ?? [],
            tags: c.tags ?? [],
          },
        });
    }
    return datasetId;
  });
}

export async function getDatasetByName(db: Database, name: string) {
  const [row] = await db.select().from(evaluationDatasets).where(eq(evaluationDatasets.name, name)).limit(1);
  return row ?? null;
}

export async function listDatasets(db: Database) {
  return db.select().from(evaluationDatasets).orderBy(asc(evaluationDatasets.name));
}

export async function listCases(db: Database, datasetId: string): Promise<EvaluationCaseRow[]> {
  return db.select().from(evaluationCases).where(eq(evaluationCases.datasetId, datasetId)).orderBy(asc(evaluationCases.externalId));
}

export async function createRun(db: Database, input: { datasetId: string; experimentName: string; config: Record<string, unknown> }) {
  const [row] = await db.insert(evaluationRuns).values(input).returning({ id: evaluationRuns.id });
  return row!.id;
}

export async function insertResult(db: Database, input: typeof evaluationResults.$inferInsert): Promise<void> {
  await db
    .insert(evaluationResults)
    .values(input)
    .onConflictDoUpdate({
      target: [evaluationResults.runId, evaluationResults.caseId],
      set: {
        retrieved: input.retrieved ?? [],
        answer: input.answer ?? null,
        answerType: input.answerType ?? null,
        citations: input.citations ?? [],
        metrics: input.metrics ?? {},
        judge: input.judge ?? null,
        latencyMs: input.latencyMs ?? null,
        error: input.error ?? null,
      },
    });
}

export async function finishRun(
  db: Database,
  runId: string,
  data: { status: 'completed' | 'failed'; metrics: Record<string, unknown>; scores: Record<string, number>; notes?: string; error?: string },
): Promise<void> {
  await db
    .update(evaluationRuns)
    .set({ ...data, notes: data.notes ?? null, error: data.error ?? null, finishedAt: new Date() })
    .where(eq(evaluationRuns.id, runId));
}

export async function listRuns(db: Database, limit = 100) {
  return db
    .select({
      id: evaluationRuns.id,
      datasetId: evaluationRuns.datasetId,
      datasetName: evaluationDatasets.name,
      split: evaluationDatasets.split,
      experimentName: evaluationRuns.experimentName,
      config: evaluationRuns.config,
      status: evaluationRuns.status,
      metrics: evaluationRuns.metrics,
      scores: evaluationRuns.scores,
      notes: evaluationRuns.notes,
      startedAt: evaluationRuns.startedAt,
      finishedAt: evaluationRuns.finishedAt,
    })
    .from(evaluationRuns)
    .innerJoin(evaluationDatasets, eq(evaluationDatasets.id, evaluationRuns.datasetId))
    .orderBy(desc(evaluationRuns.startedAt))
    .limit(limit);
}

export async function setHumanReview(db: Database, resultId: string, review: Record<string, unknown>): Promise<boolean> {
  const rows = await db
    .update(evaluationResults)
    .set({ humanReview: review })
    .where(eq(evaluationResults.id, resultId))
    .returning({ id: evaluationResults.id });
  return rows.length > 0;
}

export async function getRun(db: Database, runId: string) {
  const [row] = await db.select().from(evaluationRuns).where(eq(evaluationRuns.id, runId)).limit(1);
  return row ?? null;
}

export async function getRunResults(db: Database, runId: string) {
  return db
    .select({ r: evaluationResults, c: evaluationCases })
    .from(evaluationResults)
    .innerJoin(evaluationCases, eq(evaluationCases.id, evaluationResults.caseId))
    .where(and(eq(evaluationResults.runId, runId)))
    .orderBy(asc(evaluationCases.externalId));
}
