import { loadEnv } from '@rag/config';
import { createDatabase } from '../src/client';
import { runMigrations } from '../src/migrate';

const env = loadEnv();
const { sql, close } = createDatabase(env.DATABASE_URL, { max: 1, applicationName: 'rag-migrate' });
try {
  const result = await runMigrations(sql);
  console.log(`Migrations aplicadas: ${result.applied.length ? result.applied.join(', ') : 'nenhuma'}`);
  console.log(`Já aplicadas: ${result.skipped.length}`);
} catch (err) {
  console.error('Falha ao aplicar migrations:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
