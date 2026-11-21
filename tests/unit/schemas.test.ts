import { documentMetadataSchema, documentUpdateSchema } from '@rag/shared';
import { describe, expect, it } from 'vitest';

describe('schemas de documento', () => {
  it('cadastro aplica valores padrão', () => {
    expect(documentMetadataSchema.parse({ title: 'Portaria' })).toMatchObject({ documentType: 'outro', validityStatus: 'vigente', accessLevel: 'interno' });
  });

  it('atualização parcial não preenche campos ausentes com valores padrão', () => {
    expect(documentUpdateSchema.parse({ title: 'Novo título' })).toEqual({ title: 'Novo título' });
  });

  it('remove caracteres de controle de textos', () => {
    expect(documentMetadataSchema.parse({ title: 'Título\u0000\u0007 limpo' }).title).toBe('Título limpo');
  });
});
