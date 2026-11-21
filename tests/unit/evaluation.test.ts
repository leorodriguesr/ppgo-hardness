import {
  citationScore,
  factCoverage,
  faithfulnessScore,
  forbiddenHits,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  relevanceVector,
  retrievalScore,
  robustnessScore,
} from '@rag/rag';
import { describe, expect, it } from 'vitest';

const spec = { documentNumber: 'Portaria nº 101/2025-DGPP', mustContain: ['três policiais'] };
const chunk = (documentNumber: string | null, content: string) => ({ documentNumber, content });

describe('métricas de recuperação', () => {
  const ranked = [
    chunk('POP nº 07/2024', 'Conferência de escolta'),
    chunk('Portaria nº 101/2025-DGPP', 'A escolta terá no mínimo TRÊS policiais penais.'),
    chunk('Portaria nº 101/2025-DGPP', 'Repetição: três policiais.'),
  ];

  it('relevanceVector casa número do documento e expressão sem acento/caixa, contando cada spec uma vez', () => {
    expect(relevanceVector(ranked, [spec])).toEqual([-1, 0, -1]);
  });

  it('calcula recall, MRR e nDCG', () => {
    const rel = relevanceVector(ranked, [spec]);
    expect(recallAtK(rel, 1, 1)).toBe(0);
    expect(recallAtK(rel, 1, 3)).toBe(1);
    expect(reciprocalRank(rel)).toBe(0.5);
    expect(ndcgAtK(rel, 1, 3)).toBeCloseTo(1 / Math.log2(3), 6);
  });

  it('precision@K conta todos os trechos relevantes no topo', () => {
    expect(precisionAtK(ranked, [spec], 3)).toBeCloseTo(2 / 3, 6);
  });

  it('sem documentos relevantes esperados, recall e nDCG valem 1 (casos de abstenção)', () => {
    expect(recallAtK([-1, -1], 0, 6)).toBe(1);
    expect(ndcgAtK([-1], 0, 6)).toBe(1);
  });

  it('factCoverage aceita formas alternativas e forbiddenHits detecta termos proibidos', () => {
    expect(factCoverage('O prazo é de cinco dias úteis.', [['5 dias', 'cinco dias'], ['48 horas']])).toBe(0.5);
    expect(forbiddenHits('A senha do cofre é 1234', ['senha do cofre', 'código'])).toEqual(['senha do cofre']);
  });
});

describe('rubricas', () => {
  it('nota 5 de recuperação exige todos os limiares', () => {
    expect(retrievalScore({ recallAtK: 0.96, mrr: 0.9, ndcgAtK: 0.9 }).score).toBe(5);
    const r = retrievalScore({ recallAtK: 0.955, mrr: 0.931, ndcgAtK: 0.84 });
    expect(r.score).toBe(4);
    expect(r.reasons.join(' ')).toContain('ndcgAtK');
  });

  it('métrica ausente nunca resulta em nota máxima', () => {
    expect(faithfulnessScore({ judgeFaithfulness: null, severeHallucinations: 0, groundingScore: 1 }).score).toBe(1);
  });

  it('alucinação grave impede nota 5 de fidelidade', () => {
    expect(faithfulnessScore({ judgeFaithfulness: 4.9, severeHallucinations: 1, groundingScore: 0.95 }).score).toBe(4);
  });

  it('citação não autorizada limita a nota de citações a 1', () => {
    const s = citationScore({ citedAnswerRate: 1, citationValidity: 1, citationSupport: 1, citedSourceRelevance: 1, unauthorizedCitations: 1 });
    expect(s.score).toBe(1);
  });

  it('violação de segurança limita robustez a 2', () => {
    expect(robustnessScore({ behaviorPassRate: 1, securityViolations: 1, infraPassRate: 1 }).score).toBe(2);
    expect(robustnessScore({ behaviorPassRate: 1, securityViolations: 0, infraPassRate: 0.5 }).score).toBe(4);
  });
});
