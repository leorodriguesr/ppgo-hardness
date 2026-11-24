import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** Coluna `vector` sem dimensão fixa: a dimensão é imposta por modelo via índice parcial. */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const documentCategories = pgTable('document_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  documentType: text('document_type').notNull().default('outro'),
  categoryId: uuid('category_id').references(() => documentCategories.id, { onDelete: 'set null' }),
  issuingBody: text('issuing_body'),
  documentNumber: text('document_number'),
  publicationDate: date('publication_date', { mode: 'string' }),
  effectiveDate: date('effective_date', { mode: 'string' }),
  validityStatus: text('validity_status').notNull().default('vigente'),
  accessLevel: text('access_level').notNull().default('interno'),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  supersededByDocumentId: uuid('superseded_by_document_id'),
  currentVersionId: uuid('current_version_id'),
  createdBy: text('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
  searchTsv: tsvector('search_tsv').generatedAlwaysAs(sql``),
});

export const documentVersions = pgTable('document_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number').notNull(),
  fileName: text('file_name').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  format: text('format').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  pageCount: integer('page_count'),
  status: text('status').notNull().default('pending'),
  progress: smallint('progress').notNull().default(0),
  stageDetail: text('stage_detail'),
  errorMessage: text('error_message'),
  extractionMethod: text('extraction_method'),
  ocrPages: integer('ocr_pages').notNull().default(0),
  qualityFlags: jsonb('quality_flags').$type<string[]>().notNull().default([]),
  processingConfig: jsonb('processing_config').$type<Record<string, unknown>>(),
  isCurrent: boolean('is_current').notNull().default(false),
  chunkCount: integer('chunk_count').notNull().default(0),
  processingMs: integer('processing_ms'),
  createdBy: text('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  supersededAt: ts('superseded_at'),
});

export const documentPages = pgTable('document_pages', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => documentVersions.id, { onDelete: 'cascade' }),
  pageNumber: integer('page_number').notNull(),
  text: text('text').notNull(),
  ocr: boolean('ocr').notNull().default(false),
  ocrConfidence: real('ocr_confidence'),
  charCount: integer('char_count').notNull().default(0),
});

export const documentChunks = pgTable('document_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => documentVersions.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  pageStart: integer('page_start'),
  pageEnd: integer('page_end'),
  sectionTitle: text('section_title'),
  headingPath: text('heading_path').array().notNull().default(sql`'{}'`),
  structuralRef: text('structural_ref'),
  contextHeader: text('context_header').notNull().default(''),
  content: text('content').notNull(),
  contentNormalized: text('content_normalized').notNull(),
  tokenCount: integer('token_count').notNull(),
  charCount: integer('char_count').notNull(),
  contentHash: char('content_hash', { length: 64 }).notNull(),
  embeddingInputHash: char('embedding_input_hash', { length: 64 }).notNull(),
  chunkingStrategy: text('chunking_strategy').notNull(),
  flags: text('flags').array().notNull().default(sql`'{}'`),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  tsv: tsvector('tsv').generatedAlwaysAs(sql``),
  tsvSimple: tsvector('tsv_simple').generatedAlwaysAs(sql``),
});

export const embeddingModels = pgTable('embedding_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  distance: text('distance').notNull().default('cosine'),
  status: text('status').notNull().default('pending'),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  activatedAt: ts('activated_at'),
  retiredAt: ts('retired_at'),
});

export const chunkEmbeddings = pgTable(
  'chunk_embeddings',
  {
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => documentChunks.id, { onDelete: 'cascade' }),
    embeddingModelId: uuid('embedding_model_id')
      .notNull()
      .references(() => embeddingModels.id, { onDelete: 'cascade' }),
    embedding: vector('embedding').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chunkId, t.embeddingModelId] })],
);

export const embeddingCache = pgTable(
  'embedding_cache',
  {
    embeddingModelId: uuid('embedding_model_id')
      .notNull()
      .references(() => embeddingModels.id, { onDelete: 'cascade' }),
    contentHash: char('content_hash', { length: 64 }).notNull(),
    embedding: vector('embedding').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.embeddingModelId, t.contentHash] })],
);

export const documentProcessingJobs = pgTable('document_processing_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => documentVersions.id, { onDelete: 'cascade' }),
  jobType: text('job_type').notNull(),
  status: text('status').notNull().default('queued'),
  stage: text('stage'),
  progress: smallint('progress').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  queueJobId: text('queue_job_id'),
  error: text('error'),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
});

export const documentProcessingEvents = pgTable('document_processing_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => documentProcessingJobs.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id')
    .notNull()
    .references(() => documentVersions.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  level: text('level').notNull().default('info'),
  message: text('message').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull().default('Nova conversa'),
  ownerId: text('owner_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  status: text('status').notNull().default('completed'),
  answerType: text('answer_type'),
  rewrittenQuery: text('rewritten_query'),
  parentMessageId: uuid('parent_message_id'),
  model: text('model'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  latencyMs: integer('latency_ms'),
  grounding: jsonb('grounding').$type<Record<string, unknown>>(),
  sources: jsonb('sources').$type<unknown[]>().notNull().default([]),
  correlationId: text('correlation_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const messageCitations = pgTable('message_citations', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  sourceNumber: integer('source_number').notNull(),
  chunkId: uuid('chunk_id').references(() => documentChunks.id, { onDelete: 'set null' }),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  versionId: uuid('version_id').references(() => documentVersions.id, { onDelete: 'set null' }),
  page: integer('page'),
  pageStart: integer('page_start'),
  pageEnd: integer('page_end'),
  quote: text('quote').notNull().default(''),
  valid: boolean('valid').notNull(),
  supportScore: real('support_score'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const userFeedback = pgTable('user_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id')
    .notNull()
    .unique()
    .references(() => messages.id, { onDelete: 'cascade' }),
  rating: smallint('rating').notNull(),
  reason: text('reason'),
  comment: text('comment'),
  actorId: text('actor_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const retrievalLogs = pgTable('retrieval_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  correlationId: text('correlation_id'),
  mode: text('mode').notNull(),
  rewritten: boolean('rewritten').notNull().default(false),
  filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
  vectorCandidates: integer('vector_candidates').notNull().default(0),
  lexicalCandidates: integer('lexical_candidates').notNull().default(0),
  fusedCandidates: integer('fused_candidates').notNull().default(0),
  rerankedCandidates: integer('reranked_candidates').notNull().default(0),
  selected: jsonb('selected').$type<unknown[]>().notNull().default([]),
  timings: jsonb('timings').$type<Record<string, number>>().notNull().default({}),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
  noEvidence: boolean('no_evidence').notNull().default(false),
  answerType: text('answer_type'),
  embeddingModelId: uuid('embedding_model_id').references(() => embeddingModels.id, { onDelete: 'set null' }),
  chatModel: text('chat_model'),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const llmUsage = pgTable('llm_usage', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  operation: text('operation').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  success: boolean('success').notNull().default(true),
  correlationId: text('correlation_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  ip: text('ip'),
  correlationId: text('correlation_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  version: integer('version').notNull().default(1),
  updatedBy: text('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const evaluationDatasets = pgTable('evaluation_datasets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  split: text('split').notNull(),
  description: text('description'),
  version: integer('version').notNull().default(1),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const evaluationCases = pgTable('evaluation_cases', {
  id: uuid('id').primaryKey().defaultRandom(),
  datasetId: uuid('dataset_id')
    .notNull()
    .references(() => evaluationDatasets.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  category: text('category').notNull(),
  question: text('question').notNull(),
  history: jsonb('history').$type<{ role: 'user' | 'assistant'; content: string }[]>().notNull().default([]),
  expectedBehavior: text('expected_behavior').notNull(),
  referenceAnswer: text('reference_answer'),
  relevant: jsonb('relevant').$type<unknown[]>().notNull().default([]),
  requiredFacts: jsonb('required_facts').$type<unknown[]>().notNull().default([]),
  forbidden: jsonb('forbidden').$type<string[]>().notNull().default([]),
  tags: text('tags').array().notNull().default(sql`'{}'`),
});

export const evaluationRuns = pgTable('evaluation_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  datasetId: uuid('dataset_id')
    .notNull()
    .references(() => evaluationDatasets.id, { onDelete: 'cascade' }),
  experimentName: text('experiment_name').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('running'),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
  scores: jsonb('scores').$type<Record<string, number>>().notNull().default({}),
  notes: text('notes'),
  error: text('error'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

/** Fila do acervo externo (Legisla). O PDF só entra na biblioteca quando alguém pede a indexação. */
export const catalogActs = pgTable(
  'catalog_acts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull().default('legisla'),
    externalId: integer('external_id').notNull(),
    title: text('title').notNull(),
    documentType: text('document_type').notNull(),
    documentNumber: text('document_number'),
    issuingBody: text('issuing_body'),
    publicationDate: date('publication_date', { mode: 'string' }),
    effectiveDate: date('effective_date', { mode: 'string' }),
    validityStatus: text('validity_status').notNull(),
    accessLevel: text('access_level').notNull().default('publico'),
    description: text('description'),
    status: text('status').notNull().default('pendente'),
    errorMessage: text('error_message'),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    wpPostId: integer('wp_post_id'),
    pageUrl: text('page_url'),
    fileUrl: text('file_url'),
    fileKind: text('file_kind'),
    contentHash: text('content_hash'),
    fileEtag: text('file_etag'),
    revokedBy: text('revoked_by'),
    siteCategory: text('site_category'),
    checkedAt: ts('checked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('catalog_acts_source_external_id').on(t.source, t.externalId)],
);

/** Vínculo entre o ato consolidado e os atos que o alteram ou que ele revoga. */
export const catalogActLinks = pgTable(
  'catalog_act_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentSource: text('parent_source').notNull(),
    parentExternalId: integer('parent_external_id').notNull(),
    childSource: text('child_source').notNull(),
    childExternalId: integer('child_external_id').notNull(),
    kind: text('kind').notNull(),
    incorporated: boolean('incorporated').notNull().default(false),
    origin: text('origin').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('catalog_act_links_pair').on(t.parentSource, t.parentExternalId, t.childSource, t.childExternalId, t.kind),
    index('catalog_act_links_parent_idx').on(t.parentSource, t.parentExternalId),
    index('catalog_act_links_child_idx').on(t.childSource, t.childExternalId),
    foreignKey({
      columns: [t.parentSource, t.parentExternalId],
      foreignColumns: [catalogActs.source, catalogActs.externalId],
      name: 'catalog_act_links_parent_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.childSource, t.childExternalId],
      foreignColumns: [catalogActs.source, catalogActs.externalId],
      name: 'catalog_act_links_child_fk',
    }).onDelete('cascade'),
  ],
);

/** Cursor da sincronização com o site da Polícia Penal. */
export const catalogSyncState = pgTable('catalog_sync_state', {
  id: text('id').primaryKey(),
  cursorAt: ts('cursor_at'),
  cursorModified: text('cursor_modified'),
  lastRunAt: ts('last_run_at'),
  lastSuccessAt: ts('last_success_at'),
  lastError: text('last_error'),
  stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
});

export const evaluationResults = pgTable('evaluation_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => evaluationRuns.id, { onDelete: 'cascade' }),
  caseId: uuid('case_id')
    .notNull()
    .references(() => evaluationCases.id, { onDelete: 'cascade' }),
  retrieved: jsonb('retrieved').$type<unknown[]>().notNull().default([]),
  answer: text('answer'),
  answerType: text('answer_type'),
  citations: jsonb('citations').$type<unknown[]>().notNull().default([]),
  metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
  judge: jsonb('judge').$type<Record<string, unknown>>(),
  humanReview: jsonb('human_review').$type<Record<string, unknown>>(),
  latencyMs: integer('latency_ms'),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
});
