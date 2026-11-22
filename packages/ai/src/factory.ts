import { OllamaChatProvider, OllamaEmbeddingProvider } from './providers/ollama';
import { OpenAIChatProvider, OpenAIEmbeddingProvider } from './providers/openai';
import { HttpReranker, LlmReranker, NoopReranker, type RerankScoreType } from './rerankers';
import type { ChatProvider, EmbeddingProvider, Reranker, UsageSink } from './types';

export interface AiEnv {
  LLM_PROVIDER: 'openai' | 'ollama';
  EMBEDDING_PROVIDER: 'openai' | 'ollama';
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL: string;
  OLLAMA_BASE_URL: string;
  OLLAMA_NUM_CTX: number;
  LLM_REQUEST_TIMEOUT_MS: number;
  LLM_REASONING_EFFORT?: string;
  EMBEDDING_MAX_RPM: number;
  RERANK_PROVIDER: 'none' | 'llm' | 'http';
  RERANK_MODEL: string;
  RERANK_HTTP_URL?: string;
  RERANK_HTTP_API_KEY?: string;
  RERANK_HTTP_SCORE_TYPE: RerankScoreType;
}

export function createChatProvider(env: AiEnv, onUsage?: UsageSink): ChatProvider {
  if (env.LLM_PROVIDER === 'openai') {
    return new OpenAIChatProvider({
      baseUrl: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
      timeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
      reasoningEffort: env.LLM_REASONING_EFFORT,
      onUsage,
    });
  }
  return new OllamaChatProvider({
    baseUrl: env.OLLAMA_BASE_URL,
    numCtx: env.OLLAMA_NUM_CTX,
    timeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    onUsage,
  });
}

/** Provedor do juiz das avaliações; sem `JUDGE_*` definidos, reutiliza o provedor principal. */
export function createJudgeProvider(
  env: AiEnv & { JUDGE_PROVIDER?: 'openai' | 'ollama'; JUDGE_BASE_URL?: string; JUDGE_API_KEY?: string },
  onUsage?: UsageSink,
): ChatProvider | undefined {
  if (!env.JUDGE_PROVIDER && !env.JUDGE_BASE_URL) return undefined;
  return createChatProvider(
    {
      ...env,
      LLM_PROVIDER: env.JUDGE_PROVIDER ?? env.LLM_PROVIDER,
      OPENAI_BASE_URL: env.JUDGE_BASE_URL ?? env.OPENAI_BASE_URL,
      OPENAI_API_KEY: env.JUDGE_API_KEY ?? env.OPENAI_API_KEY,
      LLM_REASONING_EFFORT: undefined,
    },
    onUsage,
  );
}

export function createEmbeddingProvider(
  env: AiEnv,
  model: { provider: string; model: string; dimensions: number },
  onUsage?: UsageSink,
): EmbeddingProvider {
  if (model.provider === 'openai') {
    return new OpenAIEmbeddingProvider(
      { baseUrl: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY, timeoutMs: env.LLM_REQUEST_TIMEOUT_MS, onUsage, maxRpm: env.EMBEDDING_MAX_RPM },
      model.model,
      model.dimensions,
    );
  }
  if (model.provider === 'ollama') {
    return new OllamaEmbeddingProvider(
      { baseUrl: env.OLLAMA_BASE_URL, numCtx: env.OLLAMA_NUM_CTX, timeoutMs: env.LLM_REQUEST_TIMEOUT_MS, onUsage, maxRpm: env.EMBEDDING_MAX_RPM },
      model.model,
      model.dimensions,
    );
  }
  throw new Error(`Provedor de embedding não suportado: ${model.provider}`);
}

export function createReranker(env: AiEnv, chat: ChatProvider, model = env.RERANK_MODEL): Reranker {
  switch (env.RERANK_PROVIDER) {
    case 'none':
      return new NoopReranker();
    case 'http':
      return new HttpReranker(env.RERANK_HTTP_URL!, model, env.RERANK_HTTP_API_KEY, undefined, env.RERANK_HTTP_SCORE_TYPE);
    case 'llm':
      return new LlmReranker(chat, model);
  }
}
