import { runEvaluation, type EvaluationJobData, type EvaluationMode, type Runtime } from '@rag/rag';
import { UnrecoverableError, type Job } from 'bullmq';

export async function runEvaluationJob(runtime: Runtime, job: Job<EvaluationJobData>, signal?: AbortSignal) {
  const { datasetId, experimentName, overrides, runId } = job.data;
  const { mode, judgeModel, infraChecks, ...settingsOverrides } = (overrides ?? {}) as {
    mode?: EvaluationMode;
    judgeModel?: string;
    infraChecks?: boolean;
    [k: string]: unknown;
  };
  if (!datasetId) throw new UnrecoverableError('datasetId ausente');
  const report = await runEvaluation(
    {
      db: runtime.db,
      chat: runtime.chat,
      embeddingProviderFor: runtime.embeddingProviderFor,
      rerankerFor: runtime.rerankerFor,
      getSettings: () => runtime.settings.get(),
      logger: runtime.logger,
    },
    {
      datasetId,
      experimentName,
      runId,
      mode: mode ?? 'full',
      judgeModel: judgeModel ?? runtime.env.JUDGE_MODEL ?? undefined,
      infraChecks: infraChecks ?? true,
      overrides: settingsOverrides,
      signal,
      onProgress: (done, total) => void job.updateProgress({ done, total }),
    },
  );
  return { runId: report.runId, scores: report.scores };
}
