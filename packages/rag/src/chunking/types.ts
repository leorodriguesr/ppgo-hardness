import type { ChunkingSettings } from '@rag/shared';
import type { StructElement, StructUnit } from '../ingestion/structure';

export interface DraftChunk {
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  headingPath: string[];
  sectionTitle: string | null;
  structuralRef: string | null;
  /** Contexto adicional (ex.: caput do artigo em continuações), usado em embeddings e no prompt. */
  contextNote?: string;
  flags: string[];
}

export interface ChunkingInput {
  units: StructUnit[];
  elements: StructElement[];
  settings: ChunkingSettings;
  /** Necessário apenas para a estratégia semântica. */
  embed?: (texts: string[]) => Promise<number[][]>;
}

export interface Chunker {
  readonly strategy: ChunkingSettings['strategy'];
  chunk(input: ChunkingInput): Promise<DraftChunk[]>;
}
