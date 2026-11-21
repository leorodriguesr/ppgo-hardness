import { answerCacheKey, normalizeQuestionForCache } from '@rag/rag';
import { describe, expect, it } from 'vitest';

describe('cache de respostas', () => {
  it('normaliza caixa, espaços e pontuação final da pergunta', () => {
    expect(normalizeQuestionForCache('  Qual o PRAZO   de arquivamento?? ')).toBe('qual o prazo de arquivamento');
    expect(normalizeQuestionForCache('Qual o prazo de arquivamento')).toBe('qual o prazo de arquivamento');
  });

  it('preserva diferenças de conteúdo na pergunta', () => {
    expect(normalizeQuestionForCache('Art. 5º')).not.toBe(normalizeQuestionForCache('Art. 6º'));
  });

  it('chave muda com contexto, modelo ou parâmetros de geração', () => {
    const base = { model: 'qwen2.5:7b', temperature: 0.1, maxTokens: 900, system: 'S', user: 'pergunta + contexto A' };
    const k = answerCacheKey(base);
    expect(answerCacheKey({ ...base })).toBe(k);
    expect(answerCacheKey({ ...base, user: 'pergunta + contexto B' })).not.toBe(k);
    expect(answerCacheKey({ ...base, model: 'gpt-4o-mini' })).not.toBe(k);
    expect(answerCacheKey({ ...base, temperature: 0.2 })).not.toBe(k);
    expect(answerCacheKey({ ...base, maxTokens: 800 })).not.toBe(k);
    expect(answerCacheKey({ ...base, system: 'S2' })).not.toBe(k);
  });
});
