-- Esquema inicial do RAG institucional
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Busca lexical em português, insensível a acentos, com stemming
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pt_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese);
    ALTER TEXT SEARCH CONFIGURATION pt_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;
  END IF;
  -- Busca exata (sem stemming/stopwords): números de portarias, siglas, identificadores
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'simple_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION simple_unaccent (COPY = simple);
    ALTER TEXT SEARCH CONFIGURATION simple_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Documentos
-- ---------------------------------------------------------------------------
CREATE TABLE document_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  document_type text NOT NULL DEFAULT 'outro' CHECK (document_type IN
    ('portaria','resolucao','instrucao_normativa','ordem_servico','decreto','lei','manual',
     'procedimento_operacional','oficio','nota_tecnica','outro')),
  category_id uuid REFERENCES document_categories(id) ON DELETE SET NULL,
  issuing_body text,
  document_number text,
  publication_date date,
  effective_date date,
  validity_status text NOT NULL DEFAULT 'vigente' CHECK (validity_status IN ('vigente','revogado','substituido','expirado')),
  access_level text NOT NULL DEFAULT 'interno' CHECK (access_level IN ('publico','interno','restrito','sigiloso')),
  description text,
  is_active boolean NOT NULL DEFAULT true,
  superseded_by_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  current_version_id uuid,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple_unaccent'::regconfig,
      coalesce(title, '') || ' ' || coalesce(document_number, '') || ' ' || coalesce(issuing_body, ''))
  ) STORED,
  CHECK (superseded_by_document_id IS NULL OR superseded_by_document_id <> id)
);
CREATE INDEX documents_active_idx ON documents (validity_status, is_active, access_level) WHERE deleted_at IS NULL;
CREATE INDEX documents_search_idx ON documents USING gin (search_tsv);
CREATE INDEX documents_title_trgm_idx ON documents USING gin (title gin_trgm_ops);
CREATE INDEX documents_number_idx ON documents (document_number);
CREATE INDEX documents_created_idx ON documents (created_at DESC);
CREATE INDEX documents_category_idx ON documents (category_id);
CREATE TRIGGER documents_updated_at BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number >= 1),
  file_name text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  format text NOT NULL CHECK (format IN ('pdf','docx','txt','md')),
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  page_count integer,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','extracting','ocr','normalizing','chunking','embedding','indexing','completed','error')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage_detail text,
  error_message text,
  extraction_method text CHECK (extraction_method IN ('text','ocr','mixed')),
  ocr_pages integer NOT NULL DEFAULT 0,
  quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  processing_config jsonb,
  is_current boolean NOT NULL DEFAULT false,
  chunk_count integer NOT NULL DEFAULT 0,
  processing_ms integer,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  superseded_at timestamptz,
  UNIQUE (document_id, version_number)
);
CREATE UNIQUE INDEX document_versions_one_current_idx ON document_versions (document_id) WHERE is_current;
CREATE INDEX document_versions_sha_idx ON document_versions (sha256);
CREATE INDEX document_versions_status_idx ON document_versions (status);

ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk FOREIGN KEY (current_version_id)
  REFERENCES document_versions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE document_pages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number >= 1),
  text text NOT NULL,
  ocr boolean NOT NULL DEFAULT false,
  ocr_confidence real,
  char_count integer NOT NULL DEFAULT 0,
  UNIQUE (version_id, page_number)
);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  page_start integer,
  page_end integer,
  section_title text,
  heading_path text[] NOT NULL DEFAULT '{}',
  structural_ref text,
  context_header text NOT NULL DEFAULT '',
  content text NOT NULL CHECK (length(content) > 0),
  content_normalized text NOT NULL,
  token_count integer NOT NULL CHECK (token_count > 0),
  char_count integer NOT NULL,
  content_hash char(64) NOT NULL,
  chunking_strategy text NOT NULL,
  flags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('pt_unaccent'::regconfig, coalesce(context_header, '') || ' ' || coalesce(section_title, '')), 'A') ||
    setweight(to_tsvector('pt_unaccent'::regconfig, content_normalized), 'B')
  ) STORED,
  tsv_simple tsvector GENERATED ALWAYS AS (
    to_tsvector('simple_unaccent'::regconfig, coalesce(context_header, '') || ' ' || content_normalized)
  ) STORED,
  UNIQUE (version_id, chunk_index),
  CHECK (page_start IS NULL OR page_end IS NULL OR page_end >= page_start)
);
CREATE INDEX document_chunks_document_idx ON document_chunks (document_id);
CREATE INDEX document_chunks_hash_idx ON document_chunks (content_hash);
CREATE INDEX document_chunks_tsv_idx ON document_chunks USING gin (tsv);
CREATE INDEX document_chunks_tsv_simple_idx ON document_chunks USING gin (tsv_simple);

-- ---------------------------------------------------------------------------
-- Embeddings: um índice lógico por modelo (índices HNSW parciais criados pela aplicação)
-- ---------------------------------------------------------------------------
CREATE TABLE embedding_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 8 AND 4000),
  distance text NOT NULL DEFAULT 'cosine' CHECK (distance IN ('cosine')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','indexing','ready','active','retired','failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  UNIQUE (provider, model, dimensions)
);
CREATE UNIQUE INDEX embedding_models_one_active_idx ON embedding_models ((true)) WHERE status = 'active';

CREATE TABLE chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  embedding_model_id uuid NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, embedding_model_id)
);
CREATE INDEX chunk_embeddings_model_idx ON chunk_embeddings (embedding_model_id);

CREATE TABLE embedding_cache (
  embedding_model_id uuid NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
  content_hash char(64) NOT NULL,
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (embedding_model_id, content_hash)
);

-- ---------------------------------------------------------------------------
-- Processamento
-- ---------------------------------------------------------------------------
CREATE TABLE document_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  job_type text NOT NULL CHECK (job_type IN ('ingest','reprocess','reindex_embeddings')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  stage text,
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts integer NOT NULL DEFAULT 0,
  queue_job_id text,
  error text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX processing_jobs_version_idx ON document_processing_jobs (version_id, created_at DESC);
CREATE INDEX processing_jobs_status_idx ON document_processing_jobs (status);

CREATE TABLE document_processing_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES document_processing_jobs(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  stage text NOT NULL,
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  message text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processing_events_version_idx ON document_processing_events (version_id, created_at);

-- ---------------------------------------------------------------------------
-- Conversas
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'Nova conversa',
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX conversations_owner_idx ON conversations (owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX conversations_title_trgm_idx ON conversations USING gin (title gin_trgm_ops);
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('streaming','completed','cancelled','error')),
  answer_type text CHECK (answer_type IN ('answered','insufficient_evidence','conflict','refused','error')),
  rewritten_query text,
  parent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  model text,
  tokens_in integer,
  tokens_out integer,
  latency_ms integer,
  grounding jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE message_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_number integer NOT NULL,
  chunk_id uuid REFERENCES document_chunks(id) ON DELETE SET NULL,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  version_id uuid REFERENCES document_versions(id) ON DELETE SET NULL,
  page integer,
  page_start integer,
  page_end integer,
  quote text NOT NULL DEFAULT '',
  valid boolean NOT NULL,
  support_score real,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_citations_message_idx ON message_citations (message_id);
CREATE INDEX message_citations_document_idx ON message_citations (document_id);

CREATE TABLE user_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating IN (-1, 1)),
  reason text,
  comment text,
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Observabilidade
-- ---------------------------------------------------------------------------
CREATE TABLE retrieval_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  correlation_id text,
  mode text NOT NULL,
  rewritten boolean NOT NULL DEFAULT false,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  vector_candidates integer NOT NULL DEFAULT 0,
  lexical_candidates integer NOT NULL DEFAULT 0,
  fused_candidates integer NOT NULL DEFAULT 0,
  reranked_candidates integer NOT NULL DEFAULT 0,
  selected jsonb NOT NULL DEFAULT '[]'::jsonb,
  timings jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  no_evidence boolean NOT NULL DEFAULT false,
  answer_type text,
  embedding_model_id uuid REFERENCES embedding_models(id) ON DELETE SET NULL,
  chat_model text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrieval_logs_created_idx ON retrieval_logs (created_at DESC);

CREATE TABLE llm_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  success boolean NOT NULL DEFAULT true,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_usage_created_idx ON llm_usage (created_at DESC);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Avaliação
-- ---------------------------------------------------------------------------
CREATE TABLE evaluation_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  split text NOT NULL CHECK (split IN ('dev','validation')),
  description text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  category text NOT NULL,
  question text NOT NULL,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_behavior text NOT NULL CHECK (expected_behavior IN ('answer','abstain','conflict','historical','refuse')),
  reference_answer text,
  relevant jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  forbidden jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags text[] NOT NULL DEFAULT '{}',
  UNIQUE (dataset_id, external_id)
);

CREATE TABLE evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
  experiment_name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX evaluation_runs_started_idx ON evaluation_runs (started_at DESC);

CREATE TABLE evaluation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
  retrieved jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer text,
  answer_type text,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  judge jsonb,
  latency_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, case_id)
);
