/** Estados do pipeline de processamento, na ordem em que ocorrem. */
export const PROCESSING_STATUSES = [
  'pending',
  'extracting',
  'ocr',
  'normalizing',
  'chunking',
  'embedding',
  'indexing',
  'completed',
  'error',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const PROCESSING_STATUS_LABELS: Record<ProcessingStatus, string> = {
  pending: 'Pendente',
  extracting: 'Extraindo conteúdo',
  ocr: 'Executando OCR',
  normalizing: 'Normalizando',
  chunking: 'Gerando chunks',
  embedding: 'Gerando embeddings',
  indexing: 'Indexando',
  completed: 'Concluído',
  error: 'Erro',
};

/**
 * Faixas de progresso de cada etapa. O progresso exibido é calculado a partir
 * de contadores reais (páginas extraídas, chunks com embedding) dentro de cada faixa.
 */
export const STAGE_PROGRESS_RANGES: Record<ProcessingStatus, readonly [number, number]> = {
  pending: [0, 0],
  extracting: [0, 25],
  ocr: [25, 45],
  normalizing: [45, 50],
  chunking: [50, 55],
  embedding: [55, 95],
  indexing: [95, 100],
  completed: [100, 100],
  error: [0, 0],
};

export function stageProgress(stage: ProcessingStatus, done: number, total: number): number {
  const [start, end] = STAGE_PROGRESS_RANGES[stage];
  if (total <= 0) return start;
  const ratio = Math.min(1, Math.max(0, done / total));
  return Math.round(start + (end - start) * ratio);
}

/** Classificação de acesso em ordem crescente de restrição. */
export const ACCESS_LEVELS = ['publico', 'interno', 'restrito', 'sigiloso'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, string> = {
  publico: 'Público',
  interno: 'Interno',
  restrito: 'Restrito',
  sigiloso: 'Sigiloso',
};

/** Retorna os níveis de acesso permitidos para uma credencial. */
export function allowedAccessLevels(clearance: AccessLevel): AccessLevel[] {
  const idx = ACCESS_LEVELS.indexOf(clearance);
  return ACCESS_LEVELS.slice(0, idx + 1);
}

export function canAccess(clearance: AccessLevel, level: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(level) <= ACCESS_LEVELS.indexOf(clearance);
}

export const VALIDITY_STATUSES = ['vigente', 'revogado', 'substituido', 'expirado'] as const;
export type ValidityStatus = (typeof VALIDITY_STATUSES)[number];

export const VALIDITY_STATUS_LABELS: Record<ValidityStatus, string> = {
  vigente: 'Vigente',
  revogado: 'Revogado',
  substituido: 'Substituído',
  expirado: 'Expirado',
};

export const FILE_FORMATS = ['pdf', 'docx', 'txt', 'md'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export const FILE_FORMAT_MIME: Record<FileFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
};

export const DOCUMENT_TYPES = [
  'portaria',
  'resolucao',
  'instrucao_normativa',
  'ordem_servico',
  'decreto',
  'lei',
  'manual',
  'procedimento_operacional',
  'oficio',
  'nota_tecnica',
  'outro',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  portaria: 'Portaria',
  resolucao: 'Resolução',
  instrucao_normativa: 'Instrução Normativa',
  ordem_servico: 'Ordem de Serviço',
  decreto: 'Decreto',
  lei: 'Lei',
  manual: 'Manual',
  procedimento_operacional: 'Procedimento Operacional Padrão',
  oficio: 'Ofício',
  nota_tecnica: 'Nota Técnica',
  outro: 'Outro',
};

export const CHUNKING_STRATEGIES = ['structural', 'recursive', 'fixed', 'semantic'] as const;
export type ChunkingStrategy = (typeof CHUNKING_STRATEGIES)[number];

export const RETRIEVAL_MODES = ['hybrid', 'vector', 'lexical'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export const ANSWER_TYPES = ['answered', 'insufficient_evidence', 'conflict', 'refused', 'error'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export const MESSAGE_STATUSES = ['streaming', 'completed', 'cancelled', 'error'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const EMBEDDING_MODEL_STATUSES = ['pending', 'indexing', 'ready', 'active', 'retired', 'failed'] as const;
export type EmbeddingModelStatus = (typeof EMBEDDING_MODEL_STATUSES)[number];

export const ROLES = ['viewer', 'analyst', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Identidade de quem faz a requisição. Preparado para autenticação institucional futura. */
export interface Principal {
  id: string;
  displayName: string;
  roles: Role[];
  clearance: AccessLevel;
  authenticated: boolean;
}

export const NO_EVIDENCE_MESSAGE =
  'Não encontrei informações suficientes nos documentos disponíveis para responder com segurança a essa pergunta.';
