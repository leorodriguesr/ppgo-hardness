/**
 * Gera os arquivos do corpus sintético (PDF digital, PDF digitalizado, DOCX, TXT, MD)
 * em tests/fixtures/generated/, junto com manifest.json.
 * Uso: npm run fixtures:generate
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { CORPUS, type Block, type CorpusDocument } from './corpus/documents';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const GENERATED_DIR = join(here, 'generated');

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) > width && current) {
      lines.push(current);
      current = w;
    } else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

export async function renderPdf(doc: CorpusDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.metadata.title);
  pdf.setProducer('rag-institucional corpus sintético');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595;
  const H = 842;
  const M = 60;
  const width = W - 2 * M;
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    pages.push(page);
    page.drawText('ESTADO DE GOIÁS — DIRETORIA-GERAL DE POLÍCIA PENAL — DOCUMENTO SINTÉTICO', { x: M, y: H - 35, size: 8, font: regular, color: rgb(0.3, 0.3, 0.3) });
    y = H - 70;
  };
  const ensure = (needed: number) => {
    if (y - needed < M + 20) newPage();
  };
  newPage();
  const draw = (b: Block) => {
    if (b.t === 'pagebreak') return newPage();
    if (b.t === 'table') {
      const colX = [M, M + 150, M + 360];
      for (const [i, row] of b.rows.entries()) {
        ensure(16);
        row.forEach((cell, c) => page.drawText(cell, { x: colX[c]!, y, size: 9.5, font: i === 0 ? bold : regular }));
        y -= 16;
      }
      y -= 8;
      return;
    }
    const size = b.t === 'title' ? 15 : b.t === 'h' ? 12 : 11;
    const font = b.t === 'p' ? regular : bold;
    const lines = wrap(b.text, font, size, width);
    for (const line of lines) {
      ensure(size + 4);
      page.drawText(line, { x: M, y, size, font });
      y -= size + 4;
    }
    y -= b.t === 'p' ? 8 : 6;
  };
  for (const b of doc.blocks) draw(b);
  pages.forEach((p, i) => p.drawText(`Página ${i + 1} de ${pages.length}`, { x: W / 2 - 30, y: 30, size: 8, font: regular }));
  return pdf.save();
}

/** Rasteriza o PDF e gera um novo PDF só com imagens (simula documento digitalizado). */
async function renderScannedPdf(doc: CorpusDocument): Promise<Uint8Array> {
  const digital = await renderPdf(doc);
  const dir = await mkdtemp(join(tmpdir(), 'rag-scan-'));
  try {
    await writeFile(join(dir, 'in.pdf'), digital);
    await exec(process.env.PDFTOPPM_PATH ?? 'pdftoppm', ['-r', '150', '-gray', '-png', join(dir, 'in.pdf'), join(dir, 'page')]);
    const images = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    const out = await PDFDocument.create();
    for (const img of images) {
      const png = await out.embedPng(await readFile(join(dir, img)));
      const p = out.addPage([595, 842]);
      p.drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
    }
    return out.save();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function renderDocx(doc: CorpusDocument): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  for (const b of doc.blocks) {
    if (b.t === 'pagebreak') continue;
    if (b.t === 'title') children.push(new Paragraph({ text: b.text, heading: HeadingLevel.TITLE }));
    else if (b.t === 'h') children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_2 }));
    else if (b.t === 'p') children.push(new Paragraph({ children: [new TextRun(b.text)] }));
    else
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph(c)] })) })),
        }),
      );
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

function renderMarkdown(doc: CorpusDocument): string {
  return doc.blocks
    .map((b) => {
      if (b.t === 'title') return `# ${b.text}`;
      if (b.t === 'h') return `## ${b.text}`;
      if (b.t === 'p') return b.text;
      if (b.t === 'table') return [`| ${b.rows[0]!.join(' | ')} |`, `|${b.rows[0]!.map(() => ' --- ').join('|')}|`, ...b.rows.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n');
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function renderText(doc: CorpusDocument): string {
  return doc.blocks
    .map((b) => {
      if (b.t === 'title' || b.t === 'h') return b.text.toLocaleUpperCase('pt-BR');
      if (b.t === 'p') return b.text;
      if (b.t === 'table') return b.rows.map((r) => r.join(' | ')).join('\n');
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export async function generateCorpus(outDir = GENERATED_DIR): Promise<{ file: string; doc: CorpusDocument }[]> {
  await mkdir(outDir, { recursive: true });
  const out: { file: string; doc: CorpusDocument }[] = [];
  for (const doc of CORPUS) {
    let data: Uint8Array | Buffer | string;
    switch (doc.format) {
      case 'pdf':
        data = await renderPdf(doc);
        break;
      case 'pdf_scanned':
        data = await renderScannedPdf(doc);
        break;
      case 'docx':
        data = await renderDocx(doc);
        break;
      case 'md':
        data = renderMarkdown(doc);
        break;
      case 'txt':
        data = renderText(doc);
        break;
    }
    const file = join(outDir, doc.fileName);
    await writeFile(file, data);
    out.push({ file, doc });
  }
  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify(out.map((o) => ({ key: o.doc.key, fileName: o.doc.fileName, metadata: o.doc.metadata })), null, 2),
  );
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = await generateCorpus();
  for (const f of files) console.log(`gerado: ${f.doc.fileName}`);
}
