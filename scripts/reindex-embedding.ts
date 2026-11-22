/**
 * Gera os vetores do modelo de embedding configurado no ambiente e o ativa.
 * Uso pontual da Etapa 1. Não altera o modelo ativo até a cobertura ficar completa.
 */
import { loadEnv } from '@rag/config';
import {
  activateEmbeddingModel,
  chunksMissingEmbedding,
  ensureVectorIndex,
  findOrCreateEmbeddingModel,
  listEmbeddingModels,
  setEmbeddingModelStatus,
} from '@rag/database';
import { createRuntime, embedChunks } from '@rag/rag';

const env = loadEnv();
const runtime = createRuntime(env, 'reindex-embedding');
const model = await findOrCreateEmbeddingModel(runtime.db, {
  provider: env.EMBEDDING_PROVIDER,
  model: env.EMBEDDING_MODEL,
  dimensions: env.EMBEDDING_DIMENSIONS,
});
console.log(`modelo ${model.provider}/${model.model} ${model.dimensions}d status=${model.status} id=${model.id}`);
if (model.status !== 'active') {
  await setEmbeddingModelStatus(runtime.db, model.id, 'indexing');
  await ensureVectorIndex(runtime.database.sql, model.id, model.dimensions);
  const provider = runtime.embeddingProviderFor(model);
  // O plano gratuito do Gemini conta cada texto do lote no limite de 100 por minuto.
  const batchSize = Math.min(env.EMBEDDING_BATCH_SIZE, 16);
  let total = 0;
  for (;;) {
    const batch = await chunksMissingEmbedding(runtime.db, model.id, batchSize);
    if (batch.length === 0) break;
    try {
      const r = await embedChunks({ db: runtime.db, provider, modelId: model.id, chunks: batch, batchSize });
      total += r.embedded;
      console.log(`lote: ${r.embedded} vetores (${r.cacheHits} do cache), acumulado ${total}`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 429) throw err;
      console.log('limite do provedor; aguardando 60s');
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 12_000));
  }
  await setEmbeddingModelStatus(runtime.db, model.id, 'ready');
}
const listed = (await listEmbeddingModels(runtime.db)).find((m) => m.id === model.id);
console.log(`cobertura ${listed?.embeddedChunks}/${listed?.totalChunks} status=${listed?.status}`);
if (listed && listed.status !== 'active' && listed.embeddedChunks >= listed.totalChunks && listed.totalChunks > 0) {
  await activateEmbeddingModel(runtime.db, model.id);
  console.log('ativado');
}
await runtime.close();
