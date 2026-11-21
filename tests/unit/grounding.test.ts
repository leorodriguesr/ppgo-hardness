import { maskAbbreviationDots, parseCitations, splitClaims, splitSentences, type CitationCheck } from '@rag/rag';
import { describe, expect, it } from 'vitest';

const claimsOf = (answer: string) =>
  splitClaims(
    answer,
    parseCitations(answer).map((citation): CitationCheck => ({ citation, source: null, valid: true, problem: null })),
  );

describe('splitClaims', () => {
  it('não divide afirmações em abreviações normativas (Art., nº, inc.)', () => {
    const claims = claimsOf('A movimentação deve ser registrada em até 2 horas, conforme o § 1º do Art. 3º da Portaria nº 101/2025 [Fonte 1, p. 1].');
    expect(claims).toHaveLength(1);
    expect(claims[0]!.citations).toHaveLength(1);
    expect(claims[0]!.text).toContain('Art. 3º');
  });

  it('continua separando frases distintas e associando cada citação à sua frase', () => {
    const claims = claimsOf('O prazo é de 5 dias [Fonte 1, p. 2]. A escolta exige 3 policiais penais [Fonte 2, p. 4].');
    expect(claims.map((c) => c.citations.map((x) => x.citation.sourceNumber))).toEqual([[1], [2]]);
  });

  it('não divide dentro do marcador de citação (ex.: seção "2. Periodicidade")', () => {
    const claims = claimsOf('A revista geral deve ser semanal [Fonte 1, seção POP-REV-01 › 2. Periodicidade]. Revistas extras dependem do Chefe [Fonte 2].');
    expect(claims).toHaveLength(2);
    expect(claims.map((c) => c.citations.map((x) => x.citation.sourceNumber))).toEqual([[1], [2]]);
    expect(claims[0]!.text).not.toContain('Periodicidade');
  });

  it('não divide números com ponto de milhar', () => {
    expect(claimsOf('O limite é de 1.500 reais por mês [Fonte 1].')).toHaveLength(1);
  });
});

describe('maskAbbreviationDots', () => {
  it('preserva o comprimento para que os índices de citação continuem válidos', () => {
    const text = 'Conforme Art. 5º, inc. II, e o valor 1.234.';
    expect(maskAbbreviationDots(text)).toHaveLength(text.length);
  });

  it('não mascara palavras que apenas terminam com as letras de uma abreviação', () => {
    expect(splitSentences('O relatório foi enviado ao chefe. Depois foi arquivado.')).toHaveLength(2);
    expect(splitSentences('Vide o Art. 2º desta norma. Ele trata de escolta.')).toHaveLength(2);
  });
});
