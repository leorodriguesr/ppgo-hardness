import type {
  AccessLevel,
  DocumentDto,
  DocumentType,
  DocumentVersionDto,
  FileFormat,
  ProcessingStatus,
  ValidityStatus,
} from '@rag/shared';
import type { documents, documentVersions } from '../schema';

type DocumentRow = typeof documents.$inferSelect;
type VersionRow = typeof documentVersions.$inferSelect;

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toVersionDto(v: VersionRow): DocumentVersionDto {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    fileName: v.fileName,
    format: v.format as FileFormat,
    mimeType: v.mimeType,
    sizeBytes: v.sizeBytes,
    sha256: v.sha256,
    pageCount: v.pageCount,
    status: v.status as ProcessingStatus,
    progress: v.progress,
    stageDetail: v.stageDetail,
    errorMessage: v.errorMessage,
    extractionMethod: v.extractionMethod as DocumentVersionDto['extractionMethod'],
    ocrPages: v.ocrPages,
    qualityFlags: v.qualityFlags,
    chunkCount: v.chunkCount,
    isCurrent: v.isCurrent,
    processingMs: v.processingMs,
    createdAt: v.createdAt.toISOString(),
    processedAt: iso(v.processedAt),
  };
}

export function toDocumentDto(d: DocumentRow, version: VersionRow | null, categoryName: string | null): DocumentDto {
  return {
    id: d.id,
    title: d.title,
    documentType: d.documentType as DocumentType,
    categoryId: d.categoryId,
    categoryName,
    issuingBody: d.issuingBody,
    documentNumber: d.documentNumber,
    publicationDate: d.publicationDate,
    effectiveDate: d.effectiveDate,
    validityStatus: d.validityStatus as ValidityStatus,
    accessLevel: d.accessLevel as AccessLevel,
    description: d.description,
    isActive: d.isActive,
    supersededByDocumentId: d.supersededByDocumentId,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    currentVersion: version ? toVersionDto(version) : null,
  };
}
