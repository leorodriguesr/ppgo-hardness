import { ragSettingsSchema, type RagSettings, AppError } from '@rag/shared';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { systemSettings } from '../schema';

const RAG_SETTINGS_KEY = 'rag';

function deepMerge<T>(base: T, override: unknown): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (override === undefined ? base : override) as T;
  }
  if (typeof override !== 'object' || override === null || Array.isArray(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export interface VersionedSettings {
  settings: RagSettings;
  version: number;
  updatedAt: string | null;
}

/**
 * Lê as configurações persistidas e as combina com os padrões.
 * Valores persistidos inválidos (ex.: após mudança de esquema) caem para os padrões.
 */
export async function getRagSettings(db: Database, defaults: RagSettings): Promise<VersionedSettings> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, RAG_SETTINGS_KEY)).limit(1);
  if (!row) return { settings: defaults, version: 0, updatedAt: null };
  const merged = deepMerge(defaults, row.value);
  const parsed = ragSettingsSchema.safeParse(merged);
  return {
    settings: parsed.success ? parsed.data : defaults,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function saveRagSettings(
  db: Database,
  settings: RagSettings,
  expectedVersion: number,
  actorId: string,
): Promise<VersionedSettings> {
  const valid = ragSettingsSchema.parse(settings);
  if (expectedVersion === 0) {
    const inserted = await db
      .insert(systemSettings)
      .values({ key: RAG_SETTINGS_KEY, value: valid, version: 1, updatedBy: actorId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) throw new AppError('CONFLICT', 'As configurações foram alteradas por outra sessão. Recarregue e tente novamente.');
    return { settings: valid, version: 1, updatedAt: inserted[0]!.updatedAt.toISOString() };
  }
  const updated = await db
    .update(systemSettings)
    .set({ value: valid, version: expectedVersion + 1, updatedBy: actorId, updatedAt: new Date() })
    .where(and(eq(systemSettings.key, RAG_SETTINGS_KEY), eq(systemSettings.version, expectedVersion)))
    .returning();
  if (updated.length === 0) throw new AppError('CONFLICT', 'As configurações foram alteradas por outra sessão. Recarregue e tente novamente.');
  return { settings: valid, version: updated[0]!.version, updatedAt: updated[0]!.updatedAt.toISOString() };
}
