import { access } from 'node:fs/promises';
import { buildUnits, classifyLegalLine, classifyProcedureHeading, cleanLine, linearizeTable, parseElements, sanitizeFileName, validateUpload, withDocumentDescription, adoptAlternativePage, hasCorruptCharacters, readingIsHealthier, readPdfWithPdftotext, splitPdftotextPages } from '@rag/rag';
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

  it('mantém a tabela de nomes no artigo quando o cabeçalho da coluna quebrou a linha', () => {
    const el = (type: 'article' | 'heading' | 'table' | 'text', text: string, label?: string) => ({
      type,
      text,
      pageStart: 2,
      pageEnd: 2,
      label,
    });
    const units = buildUnits([
      el('article', 'Art. 1º. Conceder a gratificação de risco de vida ao servidor abaixo mencionado:', 'Art. 1'),
      el('heading', 'A PARTIR'),
      el('table', 'NOME | CPF | CARGO'),
      el('text', 'ANA LUIZA MENDES SANTOS'),
      el('article', 'Art. 2º Observar a lei.', 'Art. 2'),
    ]);
    const art1 = units.find((u) => u.structuralRef === 'Art. 1');
    expect(art1?.elements.map((e) => e.text).join('\n')).toContain('ANA LUIZA MENDES SANTOS');
    expect(units.find((u) => u.structuralRef === 'Art. 2')?.elements.map((e) => e.text).join(' ')).not.toContain('ANA LUIZA');
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

describe('texto extraído de PDF do SEI', () => {
  it('restaura a ligadura ti que o ToUnicode mapeia para nulo', () => {
    expect(cleanLine('A jus\u0000fica\u0000va de que trata o § 6º deste ar\u0000go')).toBe(
      'A justificativa de que trata o § 6º deste artigo',
    );
    expect(cleanLine('que ins\u0000tui diretrizes')).toBe('que institui diretrizes');
  });

  it('só troca a página quando a segunda leitura tem mais letras e nenhum caractere quebrado', () => {
    const broken = 'A jus\u0000fica\u0000va de que trata o § 6º deste ar\u0000go, no prazo de 48h.';
    const fixed = 'A justificativa de que trata o § 6º deste artigo, no prazo de 48h.';
    expect(hasCorruptCharacters(broken)).toBe(true);
    expect(readingIsHealthier(broken, fixed)).toBe(true);
    expect(readingIsHealthier(broken, 'A jus\u0000ficativa')).toBe(false);
    expect(readingIsHealthier(fixed, 'Art.')).toBe(false);
    const page: ExtractedPage = { pageNumber: 1, lines: [{ text: broken, kind: 'text' }], ocr: false, ocrConfidence: null, needsOcr: false };
    const adopted = adoptAlternativePage(page, fixed);
    expect(adopted.adopted).toBe(true);
    expect(adopted.page.lines.map((l) => l.text).join(' ')).toContain('justificativa');
    expect(adoptAlternativePage(page, 'Art.').adopted).toBe(false);
  });

  it('separa as páginas do pdftotext pelo form feed final', () => {
    expect(splitPdftotextPages('página 1\fpágina 2\f')).toEqual(['página 1', 'página 2']);
  });

  it('lê a Portaria 157 com justificativa, quando o pdftotext está disponível', async () => {
    const pdf = 'storage/documents/2026/11/6b555ecf-367d-47a6-9ff2-d1adf1bdd2a1/fc1374bc-9145-40f7-8756-466168970025.pdf';
    try {
      await access(pdf);
    } catch {
      return;
    }
    const { readFile } = await import('node:fs/promises');
    const pages = await readPdfWithPdftotext(await readFile(pdf));
    if (!pages) return;
    expect(pages[0]).toContain('justificativa');
    expect(pages[0]).not.toContain('jusficava');
  });

  it('anexa a ementa só quando o trecho não a repete', () => {
    const ementa = 'Altera a Portaria n.º 45, de 16 de fevereiro de 2024, que institui o Agenda AC4.';
    const artigo = '§ 7º. A justificativa deverá ocorrer no prazo de até 48h.';
    expect(withDocumentDescription(ementa, artigo)).toBe(`${ementa}\n${artigo}`);
    expect(withDocumentDescription(ementa, `Art. 1º ${ementa} passa a vigorar.`)).toBe(`Art. 1º ${ementa} passa a vigorar.`);
    expect(withDocumentDescription(null, artigo)).toBe(artigo);
  });
});
