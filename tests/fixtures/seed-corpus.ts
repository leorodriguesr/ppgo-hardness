/**
 * Ingere o corpus sintético gerado usando o pipeline real (sem fila), de forma idempotente
 * (arquivos já presentes, pelo SHA-256, são ignorados).
 * Uso: npx tsx tests/fixtures/seed-corpus.ts
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '@rag/config';
import {
  createDocumentWithVersion,
  createProcessingJob,
  findVersionBySha,
  hardDeleteDocument,
  listCategories,
  listDocumentIdsByCreator,
} from '@rag/database';
import { createRuntime, validateUpload, type Runtime } from '@rag/rag';
import { sha256Hex } from '@rag/shared/server';
import { buildStorageKey } from '@rag/storage';
import { CORPUS } from './corpus/documents';
import { GENERATED_DIR } from './generate-corpus';

export const SEED_ACTOR = 'seed-corpus';

export interface SeedOutcome {
  key: string;
  documentId: string;
  versionId: string;
  skipped: boolean;
  chunks?: number;
  pages?: number;
  durationMs?: number;
}

export async function seedCorpus(runtime: Runtime, dir = GENERATED_DIR, log: (m: string) => void = console.log): Promise<SeedOutcome[]> {
  const categories = await listCategories(runtime.db);
  const out: SeedOutcome[] = [];
  for (const doc of CORPUS) {
    const data = await readFile(join(dir, doc.fileName));
    const sha256 = sha256Hex(data);
    const existing = await findVersionBySha(runtime.db, sha256);
    if (existing) {
      out.push({ key: doc.key, ...existing, skipped: true });
      continue;
    }
    const v = validateUpload(
      { fileName: doc.fileName, data },
      { maxBytes: runtime.env.UPLOAD_MAX_BYTES, allowedFormats: ['pdf', 'docx', 'txt', 'md'] },
    );
    const { category, ...meta } = doc.metadata;
    const storageKey = buildStorageKey(randomUUID(), v.extension);
    await runtime.storage.put(storageKey, data, v.mimeType);
    const { documentId, versionId } = await createDocumentWithVersion(runtime.db, {
      metadata: {
        ...meta,
        categoryId: categories.find((c) => c.name === category)?.id ?? null,
        effectiveDate: null,
        description: null,
      },
      file: { fileName: v.safeFileName, storageKey, format: v.format, mimeType: v.mimeType, sizeBytes: data.length, sha256 },
      actorId: SEED_ACTOR,
    });
    const jobId = await createProcessingJob(runtime.db, versionId, 'ingest');
    const t0 = performance.now();
    const r = await runtime.ingestion.run({ jobId, versionId });
    const durationMs = Math.round(performance.now() - t0);
    log(`ingerido: ${doc.key} (${v.format}) páginas=${r.pages} chunks=${r.chunks} ${durationMs}ms`);
    out.push({ key: doc.key, documentId, versionId, skipped: false, chunks: r.chunks, pages: r.pages, durationMs });
  }
  return out;
}

/** Remove somente os documentos criados por este script (corpus sintético), com arquivos e cache órfão. */
export async function resetSeededCorpus(runtime: Runtime): Promise<number> {
  const ids = await listDocumentIdsByCreator(runtime.db, SEED_ACTOR);
  for (const id of ids) {
    const res = await hardDeleteDocument(runtime.db, id);
    for (const key of res?.storageKeys ?? []) await runtime.storage.delete(key).catch(() => {});
  }
  return ids.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const runtime = createRuntime(loadEnv(), 'seed-corpus');
  try {
    if (process.argv.includes('--reset')) console.log(`removidos: ${await resetSeededCorpus(runtime)} documentos do corpus sintético`);
    const res = await seedCorpus(runtime);
    console.log(`${res.filter((r) => !r.skipped).length} ingeridos, ${res.filter((r) => r.skipped).length} já existentes`);
  } finally {
    await runtime.close();
  }
}
