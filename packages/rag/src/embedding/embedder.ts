import type { EmbeddingProvider } from '@rag/ai';
import {
  getCachedEmbeddings,
  putCachedEmbeddings,
  setEmbeddingInputHash,
  upsertChunkEmbeddings,
  type Database,
  type EmbeddableChunk,
} from '@rag/database';
import { contentHash } from '@rag/shared/server';
import { embeddingText } from '../chunking/finalize';

export interface EmbedChunksResult {
  embedded: number;
  cacheHits: number;
  providerCalls: number;
  tokens: number;
}

/**
 * Gera e persiste embeddings para chunks de um modelo específico.
 * Reaproveita vetores do cache (chave: hash do texto de entrada) e processa em lotes.
 */
export async function embedChunks(opts: {
  db: Database;
  provider: EmbeddingProvider;
  modelId: string;
  chunks: EmbeddableChunk[];
  batchSize: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => Promise<void> | void;
}): Promise<EmbedChunksResult> {
  const { db, provider, modelId, chunks } = opts;
  const result: EmbedChunksResult = { embedded: 0, cacheHits: 0, providerCalls: 0, tokens: 0 };
  const items = chunks.map((c) => {
    const text = embeddingText(c);
    return { chunk: c, text, hash: contentHash(text) };
  });

  for (const item of items) {
    if (item.hash !== item.chunk.embeddingInputHash) await setEmbeddingInputHash(db, item.chunk.id, item.hash);
  }

  const total = items.length;
  for (let i = 0; i < items.length; i += opts.batchSize) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const batch = items.slice(i, i + opts.batchSize);
    const cached = await getCachedEmbeddings(db, modelId, [...new Set(batch.map((b) => b.hash))]);
    const missing = batch.filter((b) => !cached.has(b.hash));
    const uniqueMissing = [...new Map(missing.map((m) => [m.hash, m])).values()];
    if (uniqueMissing.length > 0) {
      const res = await provider.embed(
        uniqueMissing.map((m) => m.text),
        { signal: opts.signal, operation: 'embedding_ingest' },
      );
      result.providerCalls++;
      result.tokens += res.usage.tokensIn;
      const fresh = uniqueMissing.map((m, idx) => ({ contentHash: m.hash, embedding: res.vectors[idx]! }));
      await putCachedEmbeddings(db, modelId, fresh);
      for (const f of fresh) cached.set(f.contentHash, f.embedding);
    }
    result.cacheHits += batch.length - missing.length;
    await upsertChunkEmbeddings(
      db,
      modelId,
      batch.map((b) => ({ chunkId: b.chunk.id, embedding: cached.get(b.hash)! })),
    );
    result.embedded += batch.length;
    await opts.onProgress?.(Math.min(total, i + batch.length), total);
  }
  return result;
}
