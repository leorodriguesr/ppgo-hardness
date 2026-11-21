import type { Sql } from 'postgres';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function vectorIndexName(modelId: string): string {
  return `chunk_embeddings_hnsw_${modelId.replace(/-/g, '').slice(0, 24)}`;
}

/**
 * Cria o índice HNSW parcial de um modelo de embedding. Cada modelo tem seu
 * próprio índice lógico com dimensão fixa, o que impede misturar vetores
 * incompatíveis em uma mesma busca.
 */
export async function ensureVectorIndex(sql: Sql, modelId: string, dimensions: number): Promise<void> {
  if (!UUID_RE.test(modelId)) throw new Error('ID de modelo inválido');
  if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 4000) throw new Error('Dimensão inválida');
  const name = vectorIndexName(modelId);
  // Identificadores validados acima; DDL não aceita parâmetros.
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS ${name} ON chunk_embeddings
     USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops)
     WITH (m = 16, ef_construction = 64)
     WHERE embedding_model_id = '${modelId}'`,
  );
}

export async function dropVectorIndex(sql: Sql, modelId: string): Promise<void> {
  if (!UUID_RE.test(modelId)) throw new Error('ID de modelo inválido');
  await sql.unsafe(`DROP INDEX IF EXISTS ${vectorIndexName(modelId)}`);
}
