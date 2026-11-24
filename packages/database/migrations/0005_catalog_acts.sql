-- Acervo externo (Legisla). Guarda o cadastro e o estado da indexação.
-- O arquivo só é baixado quando alguém pede, a partir da tela de documentos.
CREATE TABLE catalog_acts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'legisla',
  external_id integer NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  document_type text NOT NULL CHECK (document_type IN
    ('portaria','resolucao','instrucao_normativa','ordem_servico','decreto','lei','manual',
     'procedimento_operacional','oficio','nota_tecnica','outro')),
  document_number text,
  issuing_body text,
  publication_date date,
  effective_date date,
  validity_status text NOT NULL CHECK (validity_status IN ('vigente','revogado','substituido','expirado')),
  access_level text NOT NULL DEFAULT 'publico' CHECK (access_level IN ('publico','interno','restrito','sigiloso')),
  description text,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','baixando','ingerido','erro')),
  error_message text,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX catalog_acts_status_idx ON catalog_acts (status);
CREATE INDEX catalog_acts_publication_idx ON catalog_acts (publication_date DESC NULLS LAST, external_id DESC);
