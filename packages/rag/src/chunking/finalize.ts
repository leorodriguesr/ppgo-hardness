import { countTokens } from '@rag/ai';
import type { ChunkingSettings } from '@rag/shared';
import { contentHash } from '@rag/shared/server';
import type { ChunkInput } from '@rag/database';
import { usableChars } from '../ingestion/extractors/types';
import { normalizeForIndex } from '../ingestion/normalization';
import { detectPromptInjection } from '../security/injection';
import { recursiveSplit } from './text-split';
import type { DraftChunk } from './types';

export interface FinalizeStats {
  input: number;
  output: number;
  droppedEmpty: number;
  duplicates: number;
  hardSplits: number;
  injectionFlagged: number;
}

/**
 * Pós-processamento comum às estratégias:
 * - descarta chunks vazios ou sem texto utilizável;
 * - quebra chunks que ultrapassam 1,5× o limite (salvaguarda);
 * - remove duplicatas exatas dentro da versão;
 * - calcula hash, tokens, texto normalizado e sinalizações de segurança.
 */
export function finalizeChunks(
  drafts: DraftChunk[],
  settings: ChunkingSettings,
  ctx: { contextHeader: string },
): { chunks: ChunkInput[]; stats: FinalizeStats } {
  const stats: FinalizeStats = { input: drafts.length, output: 0, droppedEmpty: 0, duplicates: 0, hardSplits: 0, injectionFlagged: 0 };
  const hardLimit = Math.floor(settings.maxTokens * 1.5);
  const expanded: DraftChunk[] = [];
  for (const d of drafts) {
    const content = d.content.trim();
    if (usableChars(content) < 3) {
      stats.droppedEmpty++;
      continue;
    }
    if (countTokens(content) > hardLimit) {
      stats.hardSplits++;
      for (const part of recursiveSplit(content, settings.maxTokens, settings.overlapTokens)) {
        expanded.push({ ...d, content: part.trim(), flags: [...d.flags, 'hard_split'] });
      }
      continue;
    }
    expanded.push({ ...d, content });
  }

  const seen = new Set<string>();
  const chunks: ChunkInput[] = [];
  for (const d of expanded) {
    const normalized = normalizeForIndex(d.content);
    const hash = contentHash(normalized);
    if (seen.has(hash)) {
      stats.duplicates++;
      continue;
    }
    seen.add(hash);
    const flags = [...new Set(d.flags)];
    const injection = detectPromptInjection(d.content);
    if (injection.suspicious) {
      flags.push('possible_prompt_injection');
      stats.injectionFlagged++;
    }
    const tokenCount = countTokens(d.content);
    if (tokenCount === 0) continue;
    const metadata = d.contextNote ? { contextNote: d.contextNote } : {};
    const embeddingInputHash = contentHash(
      embeddingText({ contextHeader: ctx.contextHeader, headingPath: d.headingPath, structuralRef: d.structuralRef, content: d.content, metadata }),
    );
    chunks.push({
      chunkIndex: chunks.length,
      pageStart: d.pageStart,
      pageEnd: d.pageEnd,
      sectionTitle: d.sectionTitle,
      headingPath: d.headingPath,
      structuralRef: d.structuralRef,
      contextHeader: ctx.contextHeader,
      content: d.content,
      contentNormalized: normalized,
      tokenCount,
      contentHash: hash,
      embeddingInputHash,
      chunkingStrategy: settings.strategy,
      flags,
      metadata,
    });
  }
  stats.output = chunks.length;
  return { chunks, stats };
}

/** Texto usado para gerar o embedding: contexto do documento + hierarquia + conteúdo. */
export function embeddingText(chunk: {
  contextHeader: string;
  headingPath?: string[];
  structuralRef?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
}): string {
  const parts = [chunk.contextHeader];
  if (chunk.headingPath?.length) parts.push(chunk.headingPath.join(' › '));
  const note = chunk.metadata?.contextNote;
  if (typeof note === 'string') parts.push(note);
  parts.push(chunk.content);
  return parts.filter(Boolean).join('\n');
}
