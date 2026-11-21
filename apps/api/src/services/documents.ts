import {
  addDocumentVersion,
  createDocumentWithVersion,
  createProcessingJob,
  findVersionBySha,
  getDocumentRow,
  insertAudit,
  setJobQueueId,
} from '@rag/database';
import { QUEUES, validateUpload, type EmbeddingJobData, type IngestionJobData } from '@rag/rag';
import {
  AppError,
  canAccess,
  documentMetadataSchema,
  type AccessLevel,
  type DocumentMetadataInput,
  type Principal,
  type UploadResultDto,
} from '@rag/shared';
import { getCorrelationId, sha256Hex } from '@rag/shared/server';
import { buildStorageKey } from '@rag/storage';
import type { MultipartFile } from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import type { AppDeps } from '../context';

export interface ReceivedFile {
  fileName: string;
  mimeType: string;
  data: Buffer;
  fields: Record<string, string>;
}

/** Lê o arquivo multipart com limite de tamanho; campos de texto devem preceder o arquivo. */
export async function receiveFile(part: MultipartFile | undefined): Promise<ReceivedFile> {
  if (!part) throw new AppError('VALIDATION_ERROR', 'Nenhum arquivo enviado.');
  let data: Buffer;
  try {
    data = await part.toBuffer();
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError('PAYLOAD_TOO_LARGE', 'O arquivo excede o tamanho máximo permitido.');
    throw err;
  }
  if (part.file.truncated) throw new AppError('PAYLOAD_TOO_LARGE', 'O arquivo excede o tamanho máximo permitido.');
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(part.fields)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v && 'value' in v && typeof v.value === 'string') fields[key] = v.value;
  }
  return { fileName: part.filename, mimeType: part.mimetype, data, fields };
}

function parseMetadata(fields: Record<string, string>, fileName: string): DocumentMetadataInput {
  let raw: Record<string, unknown> = {};
  if (fields.metadata) {
    try {
      raw = JSON.parse(fields.metadata) as Record<string, unknown>;
    } catch {
      throw new AppError('VALIDATION_ERROR', 'Metadados inválidos (JSON malformado).');
    }
  }
  const fallbackTitle = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Documento sem título';
  const parsed = documentMetadataSchema.safeParse({ title: fallbackTitle, ...raw });
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Metadados inválidos.',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

async function validated(deps: AppDeps, file: ReceivedFile) {
  const settings = await deps.runtime.settings.get();
  try {
    return validateUpload(
      { fileName: file.fileName, declaredMime: file.mimeType, data: file.data },
      { maxBytes: Math.min(settings.upload.maxBytes, deps.runtime.env.UPLOAD_MAX_BYTES), allowedFormats: settings.upload.allowedFormats },
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', err instanceof Error ? err.message : 'Arquivo inválido');
  }
}

export async function enqueueIngestion(deps: AppDeps, versionId: string, jobType: 'ingest' | 'reprocess'): Promise<string> {
  const { db } = deps.runtime;
  const jobId = await createProcessingJob(db, versionId, jobType);
  const data: IngestionJobData = { jobId, versionId, correlationId: getCorrelationId() };
  await deps.queues.ingestion.add(QUEUES.ingestion, data, {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
    removeOnFail: { age: 30 * 24 * 3600 },
  });
  await setJobQueueId(db, jobId, jobId);
  return jobId;
}

export async function enqueueReembed(deps: AppDeps, versionId: string): Promise<void> {
  const data: EmbeddingJobData = { kind: 'version_reembed', versionId, correlationId: getCorrelationId() };
  await deps.queues.embeddings.add('version_reembed', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 500 },
  });
}

/** Não revela o identificador de documentos acima da credencial de quem enviou. */
async function visibleDocumentId(deps: AppDeps, documentId: string, principal: Principal): Promise<string | null> {
  const doc = await getDocumentRow(deps.runtime.db, documentId);
  return doc && canAccess(principal.clearance, doc.accessLevel as AccessLevel) ? doc.id : null;
}

/** Recebe um novo documento: validação, deduplicação, armazenamento, registro e enfileiramento. */
export async function ingestUpload(deps: AppDeps, file: ReceivedFile, principal: Principal, ip: string): Promise<UploadResultDto> {
  const { db, storage } = deps.runtime;
  const v = await validated(deps, file);
  const metadata = parseMetadata(file.fields, v.safeFileName);
  if (!canAccess(principal.clearance, metadata.accessLevel)) {
    throw new AppError('FORBIDDEN', 'Não é possível cadastrar documento com nível de acesso acima da sua credencial.');
  }
  const sha256 = sha256Hex(file.data);
  const existing = await findVersionBySha(db, sha256);
  if (existing) {
    return {
      fileName: v.safeFileName,
      status: 'duplicate',
      duplicateOfDocumentId: (await visibleDocumentId(deps, existing.documentId, principal)) ?? undefined,
      reason: 'Este arquivo já foi enviado anteriormente (conteúdo idêntico).',
    };
  }
  const storageKey = buildStorageKey(randomUUID(), v.extension);
  await storage.put(storageKey, file.data, v.mimeType);
  let ids: { documentId: string; versionId: string };
  try {
    ids = await createDocumentWithVersion(db, {
      metadata,
      file: { fileName: v.safeFileName, storageKey, format: v.format, mimeType: v.mimeType, sizeBytes: file.data.length, sha256 },
      actorId: principal.id,
    });
  } catch (err) {
    await storage.delete(storageKey).catch(() => {});
    throw err;
  }
  await enqueueIngestion(deps, ids.versionId, 'ingest');
  await insertAudit(db, {
    actorId: principal.id,
    action: 'document.upload',
    entityType: 'document',
    entityId: ids.documentId,
    details: { fileName: v.safeFileName, format: v.format, sizeBytes: file.data.length, warnings: v.warnings },
    ip,
    correlationId: getCorrelationId(),
  });
  return { fileName: v.safeFileName, status: 'accepted', documentId: ids.documentId, versionId: ids.versionId };
}

/** Nova versão de um documento existente. Torna-se atual somente após processamento concluído. */
export async function uploadNewVersion(
  deps: AppDeps,
  documentId: string,
  file: ReceivedFile,
  principal: Principal,
  ip: string,
): Promise<UploadResultDto & { versionNumber?: number }> {
  const { db, storage } = deps.runtime;
  const v = await validated(deps, file);
  const sha256 = sha256Hex(file.data);
  const existing = await findVersionBySha(db, sha256);
  if (existing) {
    return {
      fileName: v.safeFileName,
      status: 'duplicate',
      duplicateOfDocumentId: (await visibleDocumentId(deps, existing.documentId, principal)) ?? undefined,
      reason: 'Conteúdo idêntico a uma versão já existente.',
    };
  }
  const storageKey = buildStorageKey(randomUUID(), v.extension);
  await storage.put(storageKey, file.data, v.mimeType);
  let version: { versionId: string; versionNumber: number };
  try {
    version = await addDocumentVersion(
      db,
      documentId,
      { fileName: v.safeFileName, storageKey, format: v.format, mimeType: v.mimeType, sizeBytes: file.data.length, sha256 },
      principal.id,
    );
  } catch (err) {
    await storage.delete(storageKey).catch(() => {});
    throw err;
  }
  await enqueueIngestion(deps, version.versionId, 'ingest');
  await insertAudit(db, {
    actorId: principal.id,
    action: 'document.version.upload',
    entityType: 'document',
    entityId: documentId,
    details: { versionNumber: version.versionNumber, fileName: v.safeFileName },
    ip,
    correlationId: getCorrelationId(),
  });
  return { fileName: v.safeFileName, status: 'accepted', documentId, versionId: version.versionId, versionNumber: version.versionNumber };
}
