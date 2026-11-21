/**
 * Inspeção manual do pipeline sem banco: extração → OCR → normalização → estrutura → chunks.
 * Uso: npx tsx tests/fixtures/inspect-chunks.ts [estrategia] [arquivo...]
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CHUNKING_STRATEGIES, type ChunkingStrategy } from '@rag/shared';
import {
  buildUnits,
  cleanLine,
  createChunker,
  defaultExtractors,
  finalizeChunks,
  normalizePages,
  parseElements,
  plainTextToLines,
  TesseractOcrEngine,
  validateUpload,
} from '@rag/rag';
import { GENERATED_DIR } from './generate-corpus';
import { CORPUS } from './corpus/documents';

const args = process.argv.slice(2);
const strategy = (CHUNKING_STRATEGIES as readonly string[]).includes(args[0] ?? '') ? (args.shift() as ChunkingStrategy) : 'structural';
const files = args.length ? args : CORPUS.map((d) => join(GENERATED_DIR, d.fileName));
const extractors = defaultExtractors();
const ocr = new TesseractOcrEngine({ tesseractPath: 'tesseract', pdftoppmPath: 'pdftoppm', languages: 'por', dpi: 300, timeoutMs: 120_000 });

for (const file of files) {
  const data = await readFile(file);
  const v = validateUpload({ fileName: basename(file), data }, { maxBytes: 1e9, allowedFormats: ['pdf', 'docx', 'txt', 'md'] });
  const extracted = await extractors.get(v.format).extract(data, { minCharsPerPage: 40 });
  let pages = extracted.pages;
  const needOcr = pages.filter((p) => p.needsOcr).map((p) => p.pageNumber);
  if (needOcr.length) {
    const res = await ocr.recognizePdfPages(data, needOcr);
    pages = pages.map((p) => {
      const r = res.find((x) => x.pageNumber === p.pageNumber);
      return r ? { ...p, lines: plainTextToLines(r.lines.map(cleanLine).join('\n')), ocr: true, ocrConfidence: r.confidence } : p;
    });
    console.log(`  OCR: páginas ${needOcr.join(',')} confiança média ${(res.reduce((s, r) => s + r.confidence, 0) / res.length).toFixed(1)}`);
  }
  const norm = normalizePages(pages);
  const elements = parseElements(norm.pages, extracted.paginated);
  const units = buildUnits(elements);
  const drafts = await createChunker(strategy).chunk({ units, elements, settings: { strategy, maxTokens: 450, minTokens: 40, overlapTokens: 60 } });
  const { chunks, stats } = finalizeChunks(drafts, { strategy, maxTokens: 450, minTokens: 40, overlapTokens: 60 }, { contextHeader: basename(file) });
  console.log(`\n=== ${basename(file)} | ${v.format} | páginas=${pages.length} | bordas removidas=${norm.removedEdgeLines} | elementos=${elements.length} | unidades=${units.length} | chunks=${chunks.length}`, stats.injectionFlagged ? '| injeção sinalizada' : '');
  for (const c of chunks) {
    console.log(`  [${c.chunkIndex}] p${c.pageStart ?? '-'}-${c.pageEnd ?? '-'} ref=${c.structuralRef ?? '-'} tok=${c.tokenCount} path=${c.headingPath.join(' › ') || '-'} flags=${c.flags.join(',') || '-'}`);
    console.log(`      ${c.content.replace(/\n/g, ' ⏎ ').slice(0, 170)}`);
  }
}
