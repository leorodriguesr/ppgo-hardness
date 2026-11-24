import { addDocumentVersion, claimCatalogRefresh, findVersionBySha, markCatalogIngested, markCatalogRefreshFailed } from '@rag/database';
import type { Runtime } from '../runtime';
import { validateUpload } from '../ingestion/file-validation';
import { downloadActPdf, type ActFileRef } from './files';
import { buildStorageKey } from '@rag/storage';
import { sha256Hex } from '@rag/shared/server';
import { randomUUID } from 'node:crypto';

const ACTOR = 'catalog-sync';

export interface RefreshedAct {
  documentId: string;
  versionId: string | null;
  changed: boolean;
}

/**
 * Baixa um único ato já indexado. Se o PDF for idêntico, só registra o identificador da fonte.
 * Se mudou, grava uma nova versão e devolve o id para a fila de indexação.
 */
export async function refreshIndexedAct(runtime: Runtime, source: 'legisla' | 'site', externalId: number): Promise<RefreshedAct | null> {
  const claimed = await claimCatalogRefresh(runtime.db, source, externalId);
  if (!claimed?.documentId) return null;
  const ref: ActFileRef = {
    source: source,
    externalId,
    fileKind: claimed.fileKind === 'pdf' || claimed.fileKind === 'legisla' ? claimed.fileKind : null,
    fileUrl: claimed.fileUrl,
  };
  try {
    const settings = await runtime.settings.get();
    const maxBytes = Math.min(settings.upload.maxBytes, runtime.env.UPLOAD_MAX_BYTES);
    const { data, etag } = await downloadActPdf(ref, maxBytes);
    const sha256 = sha256Hex(data);
    const same = await findVersionBySha(runtime.db, sha256);
    if (same?.documentId === claimed.documentId) {
      await markCatalogIngested(runtime.db, externalId, claimed.documentId, source, etag);
      return { documentId: claimed.documentId, versionId: null, changed: false };
    }
    if (same) {
      await markCatalogRefreshFailed(runtime.db, source, externalId, 'O arquivo novo é idêntico a outro documento já indexado.');
      return { documentId: claimed.documentId, versionId: null, changed: false };
    }
    const validated = validateUpload(
      { fileName: `ato-${externalId}.pdf`, declaredMime: 'application/pdf', data },
      { maxBytes, allowedFormats: settings.upload.allowedFormats },
    );
    const storageKey = buildStorageKey(randomUUID(), validated.extension);
    await runtime.storage.put(storageKey, data, validated.mimeType);
    try {
      const version = await addDocumentVersion(
        runtime.db,
        claimed.documentId,
        {
          fileName: validated.safeFileName,
          storageKey,
          format: validated.format,
          mimeType: validated.mimeType,
          sizeBytes: data.length,
          sha256,
        },
        ACTOR,
      );
      await markCatalogIngested(runtime.db, externalId, claimed.documentId, source, etag);
      return { documentId: claimed.documentId, versionId: version.versionId, changed: true };
    } catch (err) {
      await runtime.storage.delete(storageKey).catch(() => {});
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Não foi possível atualizar o ato.';
    await markCatalogRefreshFailed(runtime.db, source, externalId, message).catch(() => {});
    throw err;
  }
}
