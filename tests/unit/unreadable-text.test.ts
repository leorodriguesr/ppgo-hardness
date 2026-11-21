import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultExtractors, isUnreadableText, vowelRatio } from '@rag/rag';
import { describe, expect, it } from 'vitest';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'generated');

/** Trecho real de PDF com fonte sem mapa Unicode ("Procedimento Operacional Padrão — POP" etc.). */
const GARBLED = `3URFHGLPHQWR2SHUDFLRQDO3DGUmR323
3URFHGLPHQWR2SHUDFLRQDO3DGUmRQ | &21752/('($&(662
'LUHWRULD*HUDOGH$GPLQLVWUDomR3HQLWHQFLiULDGR(VWDGRGH*RLiV
4XHDVSUHUURJDWLYDVVHMDPUHVSHLWDGDVVHPTXHDVHJXUDQoD¿TXHSUHMXGLFDGD`;

describe('detecção de camada de texto ilegível', () => {
  it('marca texto de fonte sem mapa Unicode, inclusive títulos curtos', () => {
    expect(isUnreadableText(GARBLED)).toBe(true);
    expect(isUnreadableText('3URFHGLPHQWR3URFHGLPHQWR\n6,67(0$6,67(0$\n\'(\'(\n(6&2/7$6(6&2/7$6\n*RLkQLD*RLkQLD\n')).toBe(true);
  });

  it('não marca texto em português, títulos em caixa alta, siglas ou páginas quase vazias', () => {
    expect(isUnreadableText('Art. 3º A movimentação interna será autorizada pelo Diretor da unidade prisional.')).toBe(false);
    expect(isUnreadableText('PROCEDIMENTO OPERACIONAL PADRÃO — CONTROLE DE ACESSO DE VEÍCULOS')).toBe(false);
    expect(isUnreadableText('SIGEP-S; CPF; RG; DGAP; GOIASPEN; SSP; CPD; POP-REV-01; Goiânia')).toBe(false);
    expect(isUnreadableText('ANEXO I')).toBe(false);
    expect(isUnreadableText('12/03/2025 — 14h30 — 1.234')).toBe(false);
  });

  it('textos do corpus de teste ficam longe do limiar', async () => {
    for (const f of (await readdir(FIXTURES)).filter((n) => /\.(md|txt)$/.test(n))) {
      const text = await readFile(join(FIXTURES, f), 'utf8');
      expect(vowelRatio(text).ratio, f).toBeGreaterThan(0.4);
      expect(isUnreadableText(text), f).toBe(false);
    }
  });

  it('PDFs do corpus de teste não têm páginas marcadas como ilegíveis', async () => {
    const pdf = defaultExtractors().get('pdf');
    for (const f of (await readdir(FIXTURES)).filter((n) => n.endsWith('.pdf'))) {
      const doc = await pdf.extract(await readFile(join(FIXTURES, f)), { minCharsPerPage: 50 });
      expect(doc.pages.filter((p) => p.unreadableTextLayer).map((p) => p.pageNumber), f).toEqual([]);
    }
  });
});
