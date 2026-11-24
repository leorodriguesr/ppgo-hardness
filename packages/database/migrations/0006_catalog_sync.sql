-- Origem no site da Polícia Penal e controle da sincronização.
-- O PDF continua fora da indexação até alguém pedir, salvo ato que já estava indexado e mudou.

ALTER TABLE catalog_acts
  ADD COLUMN wp_post_id integer,
  ADD COLUMN page_url text,
  ADD COLUMN file_url text,
  ADD COLUMN file_kind text CHECK (file_kind IS NULL OR file_kind IN ('legisla', 'pdf')),
  ADD COLUMN content_hash text,
  ADD COLUMN file_etag text,
  ADD COLUMN revoked_by text,
  ADD COLUMN site_category text,
  ADD COLUMN checked_at timestamptz;

CREATE UNIQUE INDEX catalog_acts_wp_post_idx ON catalog_acts (wp_post_id) WHERE wp_post_id IS NOT NULL;

CREATE TABLE catalog_sync_state (
  id text PRIMARY KEY,
  cursor_at timestamptz,
  cursor_modified text,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO catalog_sync_state (id) VALUES ('site');
