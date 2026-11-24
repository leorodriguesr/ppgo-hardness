import { catalogActFromLegisla, catalogIsoDate, legislaCatalogFileSchema } from '@rag/shared';
import { describe, expect, it } from 'vitest';

const ato = {
  id: 27207,
  ano: 2026,
  numero: 351,
  data: '29/10/2026',
  data_inicio_vigencia: null,
  ementa: 'Dispõe sobre a Progressão Funcional.',
  tipo_ato_infralegal: 'Portaria',
  situacao_ato_infralegal: 'Em vigor',
  orgao_relacionado_nome: 'Diretoria-Geral de Polícia Penal',
  orgao_relacionado_sigla: 'DGPP',
};

describe('cadastro do acervo Legisla', () => {
  it('monta título curto, número e ementa', () => {
    expect(catalogActFromLegisla(ato)).toMatchObject({
      externalId: 27207,
      title: 'Portaria DGPP nº 351/2026',
      documentType: 'portaria',
      documentNumber: '351/2026',
      publicationDate: '2026-10-29',
      effectiveDate: null,
      validityStatus: 'vigente',
      accessLevel: 'publico',
      description: 'Dispõe sobre a Progressão Funcional.',
    });
  });

  it('mapeia edital, portaria normativa e situações', () => {
    expect(catalogActFromLegisla({ ...ato, tipo_ato_infralegal: 'Edital' }).documentType).toBe('outro');
    expect(catalogActFromLegisla({ ...ato, tipo_ato_infralegal: 'Portaria Normativa' })).toMatchObject({
      documentType: 'portaria',
      title: 'Portaria Normativa DGPP nº 351/2026',
    });
    expect(catalogActFromLegisla({ ...ato, situacao_ato_infralegal: 'Revogada' }).validityStatus).toBe('revogado');
    expect(catalogActFromLegisla({ ...ato, situacao_ato_infralegal: 'Caducada' }).validityStatus).toBe('expirado');
  });

  it('descarta data impossível e ementa vazia', () => {
    expect(catalogIsoDate('31/02/2026')).toBeNull();
    expect(catalogIsoDate('2026-10-29')).toBe('2026-10-29');
    expect(catalogActFromLegisla({ ...ato, ementa: '   ' }).description).toBeNull();
  });

  it('aceita o arquivo com campos extras', () => {
    const parsed = legislaCatalogFileSchema.parse({ total_resultados: 1, resultados: [{ ...ato, diarios: [], legislacoes: [] }] });
    expect(parsed.resultados).toHaveLength(1);
  });
});
