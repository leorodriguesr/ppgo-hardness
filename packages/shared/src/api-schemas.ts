import { z } from 'zod';
import {
  ACCESS_LEVELS,
  DOCUMENT_TYPES,
  FILE_FORMATS,
  PROCESSING_STATUSES,
  VALIDITY_STATUSES,
} from './domain';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato AAAA-MM-DD');
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // Remove caracteres de controle (exceto quebra de linha e tabulação)
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));

export const uuidSchema = z.string().uuid();

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Campos sem valores padrão: a atualização parcial não pode sobrescrever o que não foi enviado. */
const documentFields = {
  title: safeText(500).pipe(z.string().min(1, 'Título é obrigatório')),
  documentType: z.enum(DOCUMENT_TYPES),
  categoryId: uuidSchema.nullable().optional(),
  issuingBody: safeText(300).nullable().optional(),
  documentNumber: safeText(120).nullable().optional(),
  publicationDate: isoDate.nullable().optional(),
  effectiveDate: isoDate.nullable().optional(),
  validityStatus: z.enum(VALIDITY_STATUSES),
  accessLevel: z.enum(ACCESS_LEVELS),
  description: safeText(4000).nullable().optional(),
};

export const documentMetadataSchema = z.object({
  ...documentFields,
  documentType: documentFields.documentType.default('outro'),
  validityStatus: documentFields.validityStatus.default('vigente'),
  accessLevel: documentFields.accessLevel.default('interno'),
});
export type DocumentMetadataInput = z.infer<typeof documentMetadataSchema>;

export const documentUpdateSchema = z.object(documentFields).partial().extend({
  isActive: z.boolean().optional(),
  supersededByDocumentId: uuidSchema.nullable().optional(),
  /** Controle de concorrência otimista. */
  expectedUpdatedAt: z.string().datetime().optional(),
});
export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;

export const documentListQuerySchema = paginationQuerySchema.extend({
  q: safeText(200).optional(),
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  categoryId: uuidSchema.optional(),
  status: z.enum(PROCESSING_STATUSES).optional(),
  validityStatus: z.enum(VALIDITY_STATUSES).optional(),
  format: z.enum(FILE_FORMATS).optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sort: z.enum(['created_desc', 'created_asc', 'title_asc', 'updated_desc']).default('created_desc'),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export const categoryInputSchema = z.object({
  name: safeText(120).pipe(z.string().min(1)),
  description: safeText(1000).nullable().optional(),
});

export const retrievalFiltersSchema = z
  .object({
    documentIds: z.array(uuidSchema).max(50).optional(),
    categoryIds: z.array(uuidSchema).max(50).optional(),
    documentTypes: z.array(z.enum(DOCUMENT_TYPES)).max(20).optional(),
    issuingBodies: z.array(safeText(300)).max(20).optional(),
    publishedFrom: isoDate.optional(),
    publishedTo: isoDate.optional(),
    /** Inclui documentos revogados/substituídos e versões anteriores, rotulados como históricos. */
    includeHistorical: z.boolean().optional(),
    accessLevels: z.array(z.enum(ACCESS_LEVELS)).max(4).optional(),
  })
  .strict();
export type RetrievalFilters = z.infer<typeof retrievalFiltersSchema>;

export const conversationCreateSchema = z.object({
  title: safeText(200).optional(),
});

export const conversationUpdateSchema = z.object({
  title: safeText(200).pipe(z.string().min(1)),
});

export const conversationListQuerySchema = paginationQuerySchema.extend({
  q: safeText(200).optional(),
});

export const chatRequestSchema = z.object({
  conversationId: uuidSchema.optional(),
  content: safeText(20_000).pipe(z.string().min(1, 'A mensagem não pode estar vazia')),
  filters: retrievalFiltersSchema.optional(),
  /** Quando informado, gera nova resposta para a mesma pergunta (regenerar). */
  regenerateFromMessageId: uuidSchema.optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const feedbackSchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  reason: z
    .enum(['incorreta', 'incompleta', 'sem_fonte', 'fonte_errada', 'irrelevante', 'util', 'precisa', 'outro'])
    .optional(),
  comment: safeText(2000).optional(),
});
export type FeedbackInput = z.infer<typeof feedbackSchema>;

export const embeddingModelCreateSchema = z.object({
  provider: z.enum(['openai', 'ollama']),
  model: safeText(200).pipe(z.string().min(1)),
  dimensions: z.number().int().min(8).max(4000),
});

export const evaluationRunRequestSchema = z.object({
  datasetId: uuidSchema,
  experimentName: safeText(200).pipe(z.string().min(1)),
  overrides: z.record(z.string(), z.unknown()).optional(),
});
