import { buildUnits, classifyLegalLine, classifyProcedureHeading, linearizeTable, parseElements, sanitizeFileName, validateUpload } from '@rag/rag';
import type { ExtractedPage } from '@rag/rag';
import { describe, expect, it } from 'vitest';

describe('estrutura normativa', () => {
  it.each([
    ['Art. 12. A escolta será...', 'article', 'Art. 12'],
    ['Art. 1º Fica instituído...', 'article', 'Art. 1'],
    ['§ 2º A defesa escrita...', 'paragraph_sign', '§ 2º'],
    ['Parágrafo único. Em caso de...', 'paragraph_sign', 'Parágrafo único'],
    ['IV – técnicas de submissão;', 'inciso', 'IV'],
    ['a) registro em livro próprio;', 'alinea', 'a)'],
    ['CAPÍTULO II', 'heading', 'CAPÍTULO II'],
  ])('classifica "%s" como %s', (text, type, label) => {
    expect(classifyLegalLine(text)).toMatchObject({ type, label });
  });

  it('não classifica texto corrido como item normativo', () => {
    expect(classifyLegalLine('A unidade deverá manter registro atualizado.')).toBeNull();
  });

  it('aninha a seção do POP sob o procedimento, sem engolir o título', () => {
    expect(classifyProcedureHeading('4.5 Revista em Estruturas Físicas das Celas')).toMatchObject({ level: 3 });
    expect(classifyProcedureHeading('MATERIAL NECESSÁRIO')).toMatchObject({ level: 5 });
    expect(classifyProcedureHeading('4.5 Revista em Estruturas ........ Pág. 93')).toBeNull();

    const page = (lines: ExtractedPage['lines']): ExtractedPage => ({
      pageNumber: 93,
      lines,
      ocr: false,
      ocrConfidence: null,
      needsOcr: false,
    });
    const units = buildUnits(
      parseElements(
        [
          page([
            { text: '7. Risco à integridade física dos envolvidos.', kind: 'text' },
            { text: 'Procedimento Operacional Padrão nº 04 SISTEMA DE REVISTAS', kind: 'text' },
            { text: '4.5 Revista em Estruturas Físicas das Celas', kind: 'text' },
            { text: 'MATERIAL NECESSÁRIO', kind: 'heading', level: 2 },
            { text: '1. Chaves;', kind: 'text' },
            { text: '2. Rádio transmissor;', kind: 'text' },
            { text: 'OMAN AN', kind: 'heading', level: 2 },
            { text: 'ATIVIDADES CRÍTICAS', kind: 'heading', level: 2 },
            { text: '1. Risco de agressão durante a revista.', kind: 'text' },
          ]),
        ],
        true,
      ),
    );
    const material = units.find((u) => u.sectionTitle === 'MATERIAL NECESSÁRIO');
    expect(material?.headingPath).toEqual([
      'Procedimento Operacional Padrão nº 04 SISTEMA DE REVISTAS',
      '4.5 Revista em Estruturas Físicas das Celas',
      'MATERIAL NECESSÁRIO',
    ]);
    expect(material?.elements.map((e) => e.text).join(' ')).toContain('Chaves');
    expect(units[0]?.elements.map((e) => e.text).join(' ')).not.toContain('4.5 Revista');
    expect(units.find((u) => u.sectionTitle === 'ATIVIDADES CRÍTICAS')?.headingPath[1]).toBe('4.5 Revista em Estruturas Físicas das Celas');
  });

  it('linearizeTable rotula cada célula com o cabeçalho da coluna', () => {
    const out = linearizeTable(['Função | Periodicidade', 'Revista em celas | Diária', 'Troca de cadeados | A cada 6 meses']);
    expect(out.split('\n')).toEqual([
      'Função | Periodicidade',
      'Função: Revista em celas; Periodicidade: Diária',
      'Função: Troca de cadeados; Periodicidade: A cada 6 meses',
    ]);
  });

  it('linearizeTable mantém linhas com número de colunas diferente', () => {
    const out = linearizeTable(['A | B', 'só uma célula']);
    expect(out.split('\n')[1]).toBe('só uma célula');
  });
});

describe('validação de upload', () => {
  const limits = { maxBytes: 1024 * 1024, allowedFormats: ['pdf', 'docx', 'txt', 'md'] as ('pdf' | 'docx' | 'txt' | 'md')[] };
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF');

  it('aceita PDF pela assinatura binária', () => {
    expect(validateUpload({ fileName: 'portaria.pdf', declaredMime: 'application/pdf', data: pdf }, limits)).toMatchObject({ format: 'pdf', warnings: [] });
  });

  it('rejeita extensão não suportada', () => {
    expect(() => validateUpload({ fileName: 'script.sh', data: Buffer.from('echo') }, limits)).toThrow(/não suportado/);
  });

  it('rejeita PDF falso (extensão sem assinatura)', () => {
    expect(() => validateUpload({ fileName: 'falso.pdf', data: Buffer.from('<html>oi</html>') }, limits)).toThrow();
  });

  it('rejeita binário com extensão de texto', () => {
    expect(() => validateUpload({ fileName: 'nota.txt', data: Buffer.from([0x4d, 0x5a, 0x90, 0x00]) }, limits)).toThrow(/binário/);
  });

  it('rejeita arquivo acima do limite e vazio', () => {
    expect(() => validateUpload({ fileName: 'a.txt', data: Buffer.alloc(2 * 1024 * 1024, 0x61) }, limits)).toThrow(/limite/);
    expect(() => validateUpload({ fileName: 'a.txt', data: Buffer.alloc(0) }, limits)).toThrow(/vazio/);
  });

  it('sinaliza conteúdo ativo em PDF sem executá-lo', () => {
    const active = Buffer.from('%PDF-1.7\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF');
    expect(validateUpload({ fileName: 'x.pdf', data: active }, limits).warnings).toContain('pdf_active_content');
  });

  it('sinaliza MIME declarado divergente', () => {
    expect(validateUpload({ fileName: 'x.pdf', declaredMime: 'image/png', data: pdf }, limits).warnings).toContain('declared_mime_mismatch');
  });

  it('sanitiza nomes de arquivo contra travessia de diretório', () => {
    const safe = sanitizeFileName('../../etc/passwd.txt');
    expect(safe).not.toContain('/');
    expect(safe).not.toContain('..');
  });
});
