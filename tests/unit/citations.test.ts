import { classifyAnswer, parseCitations } from '@rag/rag';
import { NO_EVIDENCE_MESSAGE } from '@rag/shared';
import { describe, expect, it } from 'vitest';

describe('parseCitations', () => {
  it('extrai fonte e página no formato canônico', () => {
    const c = parseCitations('O prazo é de 5 dias [Fonte 2, página 4].');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ sourceNumber: 2, page: 4, pageEnd: null });
  });

  it('aceita intervalos de páginas e várias fontes no mesmo colchete', () => {
    const c = parseCitations('Regra geral [Fonte 1, páginas 3-4; Fonte 3, p. 7].');
    expect(c.map((x) => [x.sourceNumber, x.page, x.pageEnd])).toEqual([
      [1, 3, 4],
      [3, 7, null],
    ]);
  });

  it('aceita citação sem página e com texto extra (ex.: artigo)', () => {
    const c = parseCitations('Comunicar em 2 horas [Fonte 1, Art. 2º].');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ sourceNumber: 1, page: null });
  });

  it('ignora colchetes que não são citações', () => {
    expect(parseCitations('Ver item [a] e [nota 3].')).toEqual([]);
  });
});

describe('classifyAnswer', () => {
  const sources = [
    { sourceNumber: 1, documentId: 'doc-a' },
    { sourceNumber: 2, documentId: 'doc-b' },
    { sourceNumber: 3, documentId: 'doc-a' },
  ];

  it('identifica ausência de evidência pela mensagem padrão', () => {
    expect(classifyAnswer(NO_EVIDENCE_MESSAGE)).toBe('insufficient_evidence');
  });

  it('classifica conflito afirmado entre documentos distintos', () => {
    const a = 'Há divergência entre as fontes: a portaria fixa 12 horas [Fonte 1], enquanto o POP fixa 24 horas [Fonte 2].';
    expect(classifyAnswer(a, sources)).toBe('conflict');
  });

  it('não classifica como conflito quando a divergência é negada', () => {
    const a = 'O prazo é de 5 dias [Fonte 1]. Não há divergência entre as fontes [Fonte 2].';
    expect(classifyAnswer(a, sources)).toBe('answered');
  });

  // Regressão: resposta real do modelo local classificada como conflito
  it('não classifica como conflito quando a divergência é apenas cogitada', () => {
    const a =
      'A comunicação deve ser feita em até 2 horas [Fonte 1, Art. 2º].\n\nNão encontrei informações suficientes nos documentos disponíveis para verificar se há alguma divergência com outra fonte vigente sobre este prazo.';
    expect(classifyAnswer(a, sources)).toBe('answered');
  });

  it('exige ao menos dois documentos distintos citados', () => {
    const a = 'Há divergência: 12 horas [Fonte 1] e 24 horas [Fonte 3].';
    expect(classifyAnswer(a, sources)).toBe('answered');
  });

  it('sem mapa de fontes, conta fontes distintas citadas', () => {
    expect(classifyAnswer('As fontes divergem: 12 horas [Fonte 1] e 24 horas [Fonte 2].')).toBe('conflict');
  });
});
