import { z } from 'zod';
import { CHUNKING_STRATEGIES, FILE_FORMATS, RETRIEVAL_MODES } from './domain';

export const generationSettingsSchema = z.object({
  chatModel: z.string().min(1).max(200),
  temperature: z.number().min(0).max(1.5),
  maxOutputTokens: z.number().int().min(64).max(8192),
});

export const retrievalSettingsSchema = z
  .object({
    mode: z.enum(RETRIEVAL_MODES),
    vectorCandidates: z.number().int().min(1).max(500),
    lexicalCandidates: z.number().int().min(1).max(500),
    rrfK: z.number().int().min(1).max(1000),
    vectorWeight: z.number().min(0).max(10),
    lexicalWeight: z.number().min(0).max(10),
    /** Peso do canal de referências explícitas (número de ato/artigo citado na pergunta). 0 desativa. */
    referenceWeight: z.number().min(0).max(10).default(1.5),
    /** Similaridade de cosseno mínima para um candidato vetorial ser considerado. */
    minVectorSimilarity: z.number().min(-1).max(1),
    finalTopK: z.number().int().min(1).max(50),
    maxContextTokens: z.number().int().min(256).max(64_000),
    /** Máximo de chunks de um mesmo documento no contexto final (diversidade). */
    maxChunksPerDocument: z.number().int().min(1).max(50),
    /** Inclui chunks vizinhos do mesmo artigo/seção quando cabem no orçamento. */
    expandNeighbors: z.boolean(),
  })
  .refine((s) => s.vectorWeight + s.lexicalWeight > 0, { message: 'Ao menos um peso de busca deve ser positivo' });

export const rerankSettingsSchema = z.object({
  enabled: z.boolean(),
  model: z.string().min(1).max(200),
  candidates: z.number().int().min(2).max(100),
  /**
   * Escore normalizado (0–1) mínimo após reranking; abaixo disso o trecho é descartado.
   * 0,1 equivale a 0,3 na escala discreta do rerank por LLM (0; 0,33; 0,67; 1) e separa, no split dev,
   * as notas do cross-encoder em casos sem evidência (≤ 0,013) das de trechos relevantes (≥ 0,646).
   */
  minScore: z.number().min(0).max(1),
});

export const rewriteSettingsSchema = z.object({
  enabled: z.boolean(),
  model: z.string().min(1).max(200),
  historyMessages: z.number().int().min(0).max(50),
  historyTokenBudget: z.number().int().min(0).max(16_000),
});

export const chunkingSettingsSchema = z
  .object({
    strategy: z.enum(CHUNKING_STRATEGIES),
    maxTokens: z.number().int().min(64).max(4000),
    minTokens: z.number().int().min(1).max(1000),
    overlapTokens: z.number().int().min(0).max(1000),
  })
  .refine((c) => c.overlapTokens < c.maxTokens / 2, { message: 'Overlap deve ser menor que metade do tamanho máximo do chunk' })
  .refine((c) => c.minTokens < c.maxTokens, { message: 'Tamanho mínimo deve ser menor que o máximo' });

export const uploadSettingsSchema = z.object({
  maxBytes: z.number().int().min(1024).max(500 * 1024 * 1024),
  allowedFormats: z.array(z.enum(FILE_FORMATS)).min(1),
});

export const processingSettingsSchema = z.object({
  ocrEnabled: z.boolean(),
  /** Páginas com menos caracteres úteis que isso são consideradas digitalizadas. */
  ocrMinCharsPerPage: z.number().int().min(0).max(5000),
  /** Confiança média mínima do OCR (0–100) para aceitar a página sem alerta. */
  ocrMinConfidence: z.number().min(0).max(100),
});

export const groundingSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Usa a LLM como verificador de suporte (além da verificação lexical). */
  useLlmVerifier: z.boolean(),
  /** Escore mínimo para considerar uma afirmação sustentada pela fonte citada. */
  minSupportScore: z.number().min(0).max(1),
  /** Escore mínimo do melhor trecho recuperado para tentar responder. */
  minEvidenceScore: z.number().min(0).max(1),
});

export const ragSettingsSchema = z.object({
  generation: generationSettingsSchema,
  retrieval: retrievalSettingsSchema,
  rerank: rerankSettingsSchema,
  rewrite: rewriteSettingsSchema,
  chunking: chunkingSettingsSchema,
  upload: uploadSettingsSchema,
  processing: processingSettingsSchema,
  grounding: groundingSettingsSchema,
});

export type RagSettings = z.infer<typeof ragSettingsSchema>;
export type RetrievalSettings = z.infer<typeof retrievalSettingsSchema>;
export type RerankSettings = z.infer<typeof rerankSettingsSchema>;
export type ChunkingSettings = z.infer<typeof chunkingSettingsSchema>;
export type GroundingSettings = z.infer<typeof groundingSettingsSchema>;

export const settingsUpdateSchema = z.object({
  settings: ragSettingsSchema,
  /** Versão lida pelo cliente; impede sobrescrever alterações concorrentes. */
  expectedVersion: z.number().int().min(0),
});

export function defaultRagSettings(models: { chatModel: string; utilityModel: string; maxUploadBytes: number }): RagSettings {
  return {
    generation: { chatModel: models.chatModel, temperature: 0.1, maxOutputTokens: 1024 },
    retrieval: {
      mode: 'hybrid',
      vectorCandidates: 40,
      lexicalCandidates: 40,
      rrfK: 60,
      vectorWeight: 1,
      lexicalWeight: 1,
      referenceWeight: 1.5,
      minVectorSimilarity: 0.3,
      finalTopK: 6,
      maxContextTokens: 3500,
      maxChunksPerDocument: 4,
      expandNeighbors: false,
    },
    rerank: { enabled: true, model: models.utilityModel, candidates: 40, minScore: 0.1 },
    rewrite: { enabled: true, model: models.utilityModel, historyMessages: 6, historyTokenBudget: 1500 },
    chunking: { strategy: 'structural', maxTokens: 450, minTokens: 40, overlapTokens: 60 },
    upload: { maxBytes: models.maxUploadBytes, allowedFormats: ['pdf', 'docx', 'txt', 'md'] },
    processing: { ocrEnabled: true, ocrMinCharsPerPage: 40, ocrMinConfidence: 60 },
    grounding: { enabled: true, useLlmVerifier: false, minSupportScore: 0.5, minEvidenceScore: 0.1 },
  };
}
