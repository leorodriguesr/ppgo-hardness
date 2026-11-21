-- Hash do texto efetivamente enviado ao modelo de embedding (cabeçalho + hierarquia + conteúdo).
-- É a chave do cache de embeddings; difere de content_hash quando o contexto do documento muda.
ALTER TABLE document_chunks ADD COLUMN embedding_input_hash char(64);
UPDATE document_chunks SET embedding_input_hash = content_hash WHERE embedding_input_hash IS NULL;
ALTER TABLE document_chunks ALTER COLUMN embedding_input_hash SET NOT NULL;
CREATE INDEX document_chunks_embedding_hash_idx ON document_chunks (embedding_input_hash);
