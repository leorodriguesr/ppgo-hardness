import { loadEnv } from '@rag/config';
import { createDatabase } from '../src/client';
import { createCategory, listCategories } from '../src/repositories/documents.repo';
import { findOrCreateEmbeddingModel, getActiveEmbeddingModel, activateEmbeddingModel } from '../src/repositories/embedding-models.repo';
import { ensureVectorIndex } from '../src/vector-index';

const CATEGORIES = [
  ['Normativos', 'Portarias, resoluções, instruções normativas e decretos'],
  ['Operacional', 'Procedimentos operacionais, escoltas, movimentações e revistas'],
  ['Administrativo', 'Gestão de pessoal, escalas, ofícios e rotinas administrativas'],
  ['Saúde e Assistência', 'Atendimento de saúde, assistência social e jurídica'],
  ['Segurança', 'Segurança institucional, inteligência e uso da força'],
] as const;

const env = loadEnv();
const { db, sql, close } = createDatabase(env.DATABASE_URL, { max: 2, applicationName: 'rag-seed' });
try {
  const existing = new Set((await listCategories(db)).map((c) => c.name));
  for (const [name, description] of CATEGORIES) {
    if (!existing.has(name)) await createCategory(db, { name, description });
  }
  const active = await getActiveEmbeddingModel(db);
  if (!active) {
    const model = await findOrCreateEmbeddingModel(db, {
      provider: env.EMBEDDING_PROVIDER,
      model: env.EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
    });
    await ensureVectorIndex(sql, model.id, model.dimensions);
    await activateEmbeddingModel(db, model.id);
    console.log(`Modelo de embedding ativo: ${model.provider}/${model.model} (${model.dimensions} dimensões)`);
  } else {
    console.log(`Modelo de embedding já ativo: ${active.provider}/${active.model}`);
  }
  console.log('Seed concluído.');
} catch (err) {
  console.error('Falha no seed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
