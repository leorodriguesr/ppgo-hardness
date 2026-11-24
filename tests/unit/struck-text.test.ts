import { readFile } from 'node:fs/promises';
import { PdfExtractor } from '@rag/rag';
import { describe, expect, it } from 'vitest';

describe('texto riscado do Legisla', () => {
  it('descarta a redação antiga da Portaria 45 e conserva a nota da alteração', async () => {
    const data = await readFile(new URL('../fixtures/portaria-45-legisla.pdf', import.meta.url));
    const doc = await new PdfExtractor().extract(data, { minCharsPerPage: 1 });
    const text = doc.pages.map((page) => page.lines.map((line) => line.text).join('\n')).join('\n');

    expect(text).toMatch(/Regional de Ara\p{L}+/u);
    expect(text).toContain('Redação dada pela Portaria nº 317');
    expect(text).toContain('No dia 11 de cada mês de referência');
    expect(text).not.toContain('No dia 11 do mês referência');
    expect(text).not.toContain('GTAE e Seção Integrada');
    expect(text.match(/Art\. 7º/g)).toHaveLength(1);
  });
});
