import type {
  AccessLevel,
  AnswerType,
  DocumentType,
  EmbeddingModelStatus,
  FileFormat,
  MessageStatus,
  ProcessingStatus,
  ValidityStatus,
} from './domain';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; correlationId?: string };
}

export interface DocumentVersionDto {
  id: string;
  versionNumber: number;
  fileName: string;
  format: FileFormat;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number | null;
  status: ProcessingStatus;
  progress: number;
  stageDetail: string | null;
  errorMessage: string | null;
  extractionMethod: 'text' | 'ocr' | 'mixed' | null;
  ocrPages: number;
  qualityFlags: string[];
  chunkCount: number;
  isCurrent: boolean;
  processingMs: number | null;
  createdAt: string;
  processedAt: string | null;
}

export interface DocumentDto {
  id: string;
  title: string;
  documentType: DocumentType;
  categoryId: string | null;
  categoryName: string | null;
  issuingBody: string | null;
  documentNumber: string | null;
  publicationDate: string | null;
  effectiveDate: string | null;
  validityStatus: ValidityStatus;
  accessLevel: AccessLevel;
  description: string | null;
  isActive: boolean;
  supersededByDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
  currentVersion: DocumentVersionDto | null;
}

export interface DocumentDetailDto extends DocumentDto {
  versions: DocumentVersionDto[];
}

export interface ChunkDto {
  id: string;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  sectionTitle: string | null;
  headingPath: string[];
  structuralRef: string | null;
  content: string;
  tokenCount: number;
  contentHash: string;
  flags: string[];
}

export interface PageDto {
  pageNumber: number;
  text: string;
  ocr: boolean;
  ocrConfidence: number | null;
}

export interface ProcessingEventDto {
  id: string;
  jobId: string;
  stage: ProcessingStatus | 'queued' | 'info';
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

export interface UploadResultDto {
  fileName: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  documentId?: string;
  versionId?: string;
  duplicateOfDocumentId?: string;
  reason?: string;
}

export interface SourceDto {
  /** Número exibido na resposta: [Fonte N, página P]. */
  sourceNumber: number;
  chunkId: string;
  documentId: string;
  versionId: string;
  documentTitle: string;
  documentNumber: string | null;
  documentType: DocumentType;
  validityStatus: ValidityStatus;
  isCurrentVersion: boolean;
  versionNumber: number;
  pageStart: number | null;
  pageEnd: number | null;
  sectionTitle: string | null;
  structuralRef: string | null;
  excerpt: string;
  score: number;
}

export interface CitationDto {
  id: string;
  sourceNumber: number;
  chunkId: string;
  documentId: string;
  versionId: string;
  documentTitle: string;
  documentNumber: string | null;
  page: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  quote: string;
  valid: boolean;
  supportScore: number | null;
  available: boolean;
}

export interface GroundingReportDto {
  score: number;
  totalClaims: number;
  supportedClaims: number;
  uncitedClaims: number;
  invalidCitations: number;
  warnings: string[];
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  answerType: AnswerType | null;
  rewrittenQuery: string | null;
  parentMessageId: string | null;
  citations: CitationDto[];
  sources: SourceDto[];
  grounding: GroundingReportDto | null;
  feedback: 1 | -1 | null;
  createdAt: string;
}

export interface ConversationDto {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string | null;
}

export type ChatStreamEvent =
  | { type: 'meta'; conversationId: string; userMessageId: string; assistantMessageId: string; correlationId: string }
  | { type: 'status'; stage: 'rewriting' | 'retrieving' | 'reranking' | 'generating' | 'verifying'; detail?: string }
  | { type: 'rewrite'; rewrittenQuery: string }
  | { type: 'sources'; sources: SourceDto[] }
  | { type: 'token'; text: string }
  | { type: 'done'; message: MessageDto }
  | { type: 'error'; code: string; message: string };

export interface EmbeddingModelDto {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  status: EmbeddingModelStatus;
  embeddedChunks: number;
  totalChunks: number;
  createdAt: string;
  activatedAt: string | null;
}

export interface DashboardDto {
  documents: { total: number; completed: number; pending: number; processing: number; error: number; inactive: number };
  chunks: number;
  storageBytes: number;
  avgProcessingMs: number | null;
  queries: { total: number; last24h: number; noEvidenceRate: number | null; avgLatencyMs: number | null; p95LatencyMs: number | null };
  feedback: { positive: number; negative: number };
  recentDocuments: DocumentDto[];
  latestEvaluation: { runId: string; experimentName: string; finishedAt: string | null; scores: Record<string, number> } | null;
  usage: { tokensIn24h: number; tokensOut24h: number; estimatedCostUsd24h: number };
}
