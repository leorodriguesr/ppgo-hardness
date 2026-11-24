import { amendmentOnly, buildActLinks, type ActRelationInput } from '@rag/shared';
import { describe, expect, it } from 'vitest';

function act(partial: Partial<ActRelationInput> & Pick<ActRelationInput, 'externalId' | 'documentNumber'>): ActRelationInput {
  return {
    source: 'legisla',
    documentType: 'portaria',
    description: null,
    revokedBy: null,
    fileKind: 'legisla',
    validityStatus: 'vigente',
    ...partial,
  };
}

describe('vínculos entre atos', () => {
  const pai = act({
    externalId: 13905,
    documentNumber: '45/2024',
    description:
      'Institui diretrizes para o agendamento de serviço extraordinário e revoga a Portaria n.º 336, de 18 de outubro de 2023, bem como a Portaria n.º 26, de 19 de janeiro de 2024.',
  });
  const revogada = act({
    externalId: 1,
    documentNumber: '336/2023',
    validityStatus: 'revogado',
    revokedBy: 'Portaria nº 45, de 16 de fevereiro de 2024',
    description: 'Institui o serviço extraordinário.',
  });
  const outraRevogada = act({
    externalId: 2,
    documentNumber: '26/2024',
    validityStatus: 'revogado',
    description: 'Altera escala.',
  });
  const altera = act({
    externalId: 3,
    documentNumber: '255/2026',
    description: 'Altera a Portaria nº 45, de 16 de fevereiro de 2024, que institui diretrizes para o agendamento de serviço extraordinário.',
  });
  const anexo = act({
    externalId: 4,
    documentNumber: '316/2026',
    description: 'Revoga o Anexo Único da Portaria DGPP nº 229, de 4 de julho de 2026, que estabelece as denominações oficiais.',
  });
  const alvoAnexo = act({ externalId: 5, documentNumber: '229/2026', description: 'Estabelece denominações.' });
  const mista = act({
    externalId: 6,
    documentNumber: '315/2026',
    description: 'Revoga a Portaria n°120/2026 e designa gestor, suplente e fiscais para o contrato.',
  });
  const alvoMista = act({ externalId: 7, documentNumber: '120/2026', validityStatus: 'revogado', description: 'Designa gestor.' });

  const links = buildActLinks([pai, revogada, outraRevogada, altera, anexo, alvoAnexo, mista, alvoMista]);

  it('reconhece uma ementa que só altera outro ato', () => {
    expect(amendmentOnly(altera.description)).toBe(true);
    expect(amendmentOnly(anexo.description)).toBe(true);
    expect(amendmentOnly(mista.description)).toBe(false);
    expect(amendmentOnly(pai.description)).toBe(false);
  });

  it('liga a portaria que revoga às portarias revogadas, sem apontar para ela mesma', () => {
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parentExternalId: 13905, childExternalId: 1, kind: 'revogacao' }),
        expect.objectContaining({ parentExternalId: 13905, childExternalId: 2, kind: 'revogacao' }),
      ]),
    );
    expect(links.some((link) => link.parentExternalId === link.childExternalId)).toBe(false);
  });

  it('incorpora a alteração quando o pai tem o texto consolidado', () => {
    expect(links).toEqual(expect.arrayContaining([expect.objectContaining({ parentExternalId: 13905, childExternalId: 3, kind: 'alteracao', incorporated: true })]));
  });

  it('trata a revogação de um anexo como alteração do ato, e mantém na lista o ato que também designa', () => {
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parentExternalId: 5, childExternalId: 4, kind: 'alteracao', incorporated: true }),
        expect.objectContaining({ parentExternalId: 6, childExternalId: 7, kind: 'revogacao', incorporated: false }),
      ]),
    );
    expect(links.some((link) => link.childExternalId === 6 && link.incorporated)).toBe(false);
  });

  it('reconhece a alteração mesmo quando a ementa começa pelo título da própria portaria', () => {
    expect(amendmentOnly('PORTARIA Nº 163, DE 31 DE março DE 2025 Altera a Portaria n.º 45, de 16 de fevereiro de 2024.')).toBe(true);
    expect(amendmentOnly('Portaria publicada no portal Legisla Goiás — CLIQUE AQUI para acessar o documento. PORTARIA Nº 317, DE 23 DE JULHO DE 2025 Altera a Portaria nº 45, de 16 de fevereiro de 2024.')).toBe(true);
    const titled = buildActLinks([
      pai,
      act({
        externalId: 8,
        documentNumber: '163/2025',
        description: 'PORTARIA Nº 163, DE 31 DE março DE 2025 Altera a Portaria n.º 45, de 16 de fevereiro de 2024.',
      }),
    ]);
    expect(titled).toEqual(expect.arrayContaining([expect.objectContaining({ parentExternalId: 13905, childExternalId: 8, incorporated: true })]));
  });

  it('não incorpora alteração cujo pai não tem PDF consolidado', () => {
    const semPdf = buildActLinks([
      act({ externalId: 10, documentNumber: '45/2024', fileKind: 'pdf', description: 'Institui diretrizes.' }),
      act({ externalId: 11, documentNumber: '155/2024', description: 'Altera a Portaria nº 45, de 16 de fevereiro de 2024.' }),
    ]);
    expect(semPdf).toEqual([expect.objectContaining({ parentExternalId: 10, childExternalId: 11, incorporated: false })]);
  });
});
