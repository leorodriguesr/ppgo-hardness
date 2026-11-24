/**
 * Carrega portarias.json no acervo. Não baixa PDF.
 * Uso: npm run catalog:import
 *      npm run catalog:import -- caminho/portarias.json
 */
import { readFileSync } from 'node:fs';
import { loadEnv } from '@rag/config';
import { createDatabase, upsertCatalogActs } from '@rag/database';
import { catalogActFromLegisla, legislaCatalogFileSchema } from '@rag/shared';

const env = loadEnv();
const file = process.argv[2] ?? 'portarias.json';
const parsed = legislaCatalogFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
const drafts = parsed.resultados.map(catalogActFromLegisla);
const { db, close } = createDatabase(env.DATABASE_URL, { max: 1, applicationName: 'rag-catalog-import' });

try {
  const written = await upsertCatalogActs(db, drafts);
  console.log(`Acervo atualizado: ${written} atos a partir de ${file}.`);
} catch (err) {
  console.error('Falha ao importar o acervo:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
