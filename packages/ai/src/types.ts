export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** JSON Schema para saída estruturada. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
  /** Rótulo da operação para métricas de uso (chat, rewrite, rerank, judge...). */
  operation: string;
}

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  /** true quando o provedor não informou o uso e os valores foram estimados. */
  estimated: boolean;
}

export interface ChatResult {
  content: string;
  usage: TokenUsage;
  model: string;
  finishReason: string | null;
  latencyMs: number;
}

export type ChatStreamChunk = { type: 'delta'; text: string } | { type: 'done'; result: ChatResult };

export interface ChatProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  stream(req: ChatRequest): AsyncIterable<ChatStreamChunk>;
}

export interface EmbeddingResult {
  vectors: number[][];
  usage: TokenUsage;
  latencyMs: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], opts?: { signal?: AbortSignal; operation?: string }): Promise<EmbeddingResult>;
}

export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  /** Escore normalizado em [0, 1]. */
  score: number;
}

export interface Reranker {
  readonly name: string;
  readonly model?: string;
  rerank(query: string, docs: RerankDocument[], opts?: { signal?: AbortSignal }): Promise<RerankResult[]>;
}

export interface UsageEvent {
  operation: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  success: boolean;
}

export type UsageSink = (event: UsageEvent) => void;
