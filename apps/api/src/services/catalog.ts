import { claimCatalogAct, getCatalogAct, markCatalogError, markCatalogIngested } from '@rag/database';
import { downloadActPdf } from '@rag/rag';
import { AppError, canAccess, type AccessLevel, type Principal } from '@rag/shared';
import type { AppDeps } from '../context';
import { ingestUpload, type ReceivedFile } from './documents';

type CatalogSource = 'legisla' | 'site';

function catalogReceivedFile(claimed: { documentNumber: string | null; documentType: string; title: string; issuingBody: string | null; publicationDate: string | null; effectiveDate: string | null; validityStatus: string; accessLevel: string; description: string | null }, data: Buffer, fileName?: string): ReceivedFile {
  const number = (claimed.documentNumber ?? 'ato').replaceAll('/', '-');
  const fallback = `${claimed.documentType === 'portaria' ? 'portaria' : 'ato'}-${number}.pdf`;
  const name = fileName?.toLowerCase().endsWith('.pdf') ? fileName : fallback;
  return {
    fileName: name,
    mimeType: 'application/pdf',
    data,
    fields: {
      metadata: JSON.stringify({
        title: claimed.title,
        documentType: claimed.documentType,
        issuingBody: claimed.issuingBody,
        documentNumber: claimed.documentNumber,
        publicationDate: claimed.publicationDate,
        effectiveDate: claimed.effectiveDate,
        validityStatus: claimed.validityStatus,
        accessLevel: claimed.accessLevel,
        description: claimed.description,
      }),
    },
  };
}

async function indexCatalogPdf(
  deps: AppDeps,
  externalId: number,
  source: CatalogSource,
  claimed: NonNullable<Awaited<ReturnType<typeof claimCatalogAct>>>,
  data: Buffer,
  etag: string | null,
  fileName: string | undefined,
  principal: Principal,
  ip: string,
  failure: string,
) {
  const { db } = deps.runtime;
  try {
    const result = await ingestUpload(deps, catalogReceivedFile(claimed, data, fileName), principal, ip);
    const documentId = result.documentId ?? result.duplicateOfDocumentId;
    if (!documentId) {
      const message = result.reason ?? 'Não foi possível indexar o ato.';
      await markCatalogError(db, externalId, message, source);
      throw new AppError('CONFLICT', message);
    }
    await markCatalogIngested(db, externalId, documentId, source, etag);
    return { externalId, documentId, status: result.status };
  } catch (err) {
    const message = err instanceof AppError ? err.message : failure;
    await markCatalogError(db, externalId, message, source).catch(() => {});
    if (err instanceof AppError) throw err;
    throw new AppError('PROVIDER_ERROR', message);
  }
}

async function readyCatalogAct(deps: AppDeps, externalId: number, source: CatalogSource, principal: Principal) {
  const existing = await getCatalogAct(deps.runtime.db, externalId, source);
  if (!existing) throw new AppError('NOT_FOUND', 'Ato não encontrado no acervo.');
  if (!canAccess(principal.clearance, existing.accessLevel as AccessLevel)) {
    throw new AppError('FORBIDDEN', 'Não é possível indexar um ato acima da sua credencial.');
  }
  if (existing.validityStatus === 'revogado') {
    throw new AppError('CONFLICT', 'Ato revogado não é indexado.');
  }
  if (existing.status === 'ingerido' && existing.documentId) {
    throw new AppError('CONFLICT', 'Este ato já foi indexado.');
  }
  return existing;
}

async function claimReadyAct(deps: AppDeps, externalId: number, source: CatalogSource, principal: Principal) {
  await readyCatalogAct(deps, externalId, source, principal);
  const claimed = await claimCatalogAct(deps.runtime.db, externalId, source);
  if (!claimed) throw new AppError('CONFLICT', 'Este ato já está sendo baixado.');
  return claimed;
}

/** Baixa o PDF de um ato do acervo e enfileira a mesma ingestão do envio avulso. */
export async function ingestCatalogAct(deps: AppDeps, externalId: number, source: CatalogSource, principal: Principal, ip: string) {
  const claimed = await claimReadyAct(deps, externalId, source, principal);
  try {
    const settings = await deps.runtime.settings.get();
    const maxBytes = Math.min(settings.upload.maxBytes, deps.runtime.env.UPLOAD_MAX_BYTES);
    const file = await downloadActPdf(
      { source, externalId, fileKind: claimed.fileKind === 'pdf' || claimed.fileKind === 'legisla' ? claimed.fileKind : null, fileUrl: claimed.fileUrl },
      maxBytes,
    );
    return await indexCatalogPdf(deps, externalId, source, claimed, file.data, file.etag, undefined, principal, ip, 'Não foi possível baixar o PDF deste ato.');
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'Não foi possível baixar o PDF deste ato.';
    await markCatalogError(deps.runtime.db, externalId, message, source).catch(() => {});
    if (err instanceof AppError) throw err;
    throw new AppError('PROVIDER_ERROR', message);
  }
}

/** Indexa um ato do acervo com o PDF enviado pelo usuário, quando a fonte não tem o arquivo. */
export async function ingestCatalogUpload(deps: AppDeps, externalId: number, source: CatalogSource, file: ReceivedFile, principal: Principal, ip: string) {
  if (!file.data.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Envie um arquivo PDF.');
  }
  const claimed = await claimReadyAct(deps, externalId, source, principal);
  return indexCatalogPdf(deps, externalId, source, claimed, file.data, null, file.fileName, principal, ip, 'Não foi possível indexar o PDF enviado.');
}
