-- O nome do procedimento fica em heading_path (ex.: "4.3.4 Revista Pessoal Minuciosa"),
-- não no texto da seção "MATERIAL NECESSÁRIO". Sem ele no índice lexical, a lista
-- de material perde para trechos que repetem as palavras da pergunta e sai do rerank.
-- array_to_string é STABLE; a coluna gerada exige IMMUTABLE.
CREATE OR REPLACE FUNCTION heading_path_text(path text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_to_string(path, ' '), '')
$$;

DROP INDEX IF EXISTS document_chunks_tsv_idx;
DROP INDEX IF EXISTS document_chunks_tsv_simple_idx;

ALTER TABLE document_chunks DROP COLUMN tsv;
ALTER TABLE document_chunks DROP COLUMN tsv_simple;

ALTER TABLE document_chunks ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('pt_unaccent'::regconfig,
    coalesce(context_header, '') || ' ' || coalesce(section_title, '') || ' ' || heading_path_text(heading_path)), 'A') ||
  setweight(to_tsvector('pt_unaccent'::regconfig, content_normalized), 'B')
) STORED;

ALTER TABLE document_chunks ADD COLUMN tsv_simple tsvector GENERATED ALWAYS AS (
  to_tsvector('simple_unaccent'::regconfig,
    coalesce(context_header, '') || ' ' || heading_path_text(heading_path) || ' ' || content_normalized)
) STORED;

CREATE INDEX document_chunks_tsv_idx ON document_chunks USING gin (tsv);
CREATE INDEX document_chunks_tsv_simple_idx ON document_chunks USING gin (tsv_simple);
