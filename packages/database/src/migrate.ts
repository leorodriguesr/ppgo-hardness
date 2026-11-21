import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

const MIGRATION_LOCK_ID = 727_001;

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Aplica migrations SQL em ordem, cada uma em sua própria transação.
 * Usa advisory lock para impedir execução concorrente e checksum para
 * detectar migrations já aplicadas que foram alteradas.
 */
export async function runMigrations(sql: Sql, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const result: MigrationResult = { applied: [], skipped: [] };

  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
    const rows = await sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM schema_migrations`;
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(content).digest('hex');
      const existing = applied.get(file);
      if (existing) {
        if (existing !== checksum) {
          throw new Error(`Migration ${file} foi alterada após ser aplicada (checksum divergente). Crie uma nova migration.`);
        }
        result.skipped.push(file);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${file}, ${checksum})`;
      });
      result.applied.push(file);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  }
  return result;
}
