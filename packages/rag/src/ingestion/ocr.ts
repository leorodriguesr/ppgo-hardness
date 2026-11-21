import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface OcrPageResult {
  pageNumber: number;
  lines: string[];
  /** Confiança média das palavras (0–100). */
  confidence: number;
  words: number;
}

export interface OcrEngine {
  readonly name: string;
  available(): Promise<boolean>;
  recognizePdfPages(pdf: Buffer, pageNumbers: number[], opts?: { signal?: AbortSignal; onPage?: (done: number, total: number) => Promise<void> | void }): Promise<OcrPageResult[]>;
}

export interface TesseractOptions {
  tesseractPath: string;
  pdftoppmPath: string;
  languages: string;
  dpi: number;
  timeoutMs: number;
}

/** Reconstrói linhas a partir da saída TSV do Tesseract e calcula a confiança média. */
export function parseTesseractTsv(tsv: string): { lines: string[]; confidence: number; words: number } {
  const rows = tsv.split('\n').slice(1);
  const lines = new Map<string, string[]>();
  let confSum = 0;
  let words = 0;
  for (const row of rows) {
    const cols = row.split('\t');
    if (cols.length < 12) continue;
    const [level, , block, par, line, , , , , , conf, ...rest] = cols;
    const text = rest.join('\t').trim();
    if (level !== '5' || !text) continue;
    const c = Number(conf);
    if (Number.isFinite(c) && c >= 0) {
      confSum += c;
      words++;
    }
    const key = `${block}.${par}.${line}`;
    const list = lines.get(key) ?? [];
    list.push(text);
    lines.set(key, list);
  }
  return {
    lines: [...lines.values()].map((w) => w.join(' ')),
    confidence: words ? confSum / words : 0,
    words,
  };
}

const MINIMAL_ENV = () => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
  OMP_THREAD_LIMIT: '2',
  ...(process.env.TESSDATA_PREFIX ? { TESSDATA_PREFIX: process.env.TESSDATA_PREFIX } : {}),
});

export class TesseractOcrEngine implements OcrEngine {
  readonly name = 'tesseract';

  constructor(private readonly opts: TesseractOptions) {}

  async available(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(this.opts.tesseractPath, ['--list-langs'], { timeout: 10_000, env: MINIMAL_ENV() });
      const langs = new Set(stdout.split('\n').map((l) => l.trim()));
      await execFileAsync(this.opts.pdftoppmPath, ['-v'], { timeout: 10_000, env: MINIMAL_ENV() });
      return this.opts.languages.split('+').every((l) => langs.has(l));
    } catch {
      return false;
    }
  }

  async recognizePdfPages(
    pdf: Buffer,
    pageNumbers: number[],
    o: { signal?: AbortSignal; onPage?: (done: number, total: number) => Promise<void> | void } = {},
  ): Promise<OcrPageResult[]> {
    const dir = await mkdtemp(join(tmpdir(), 'rag-ocr-'));
    try {
      const input = join(dir, 'input.pdf');
      await writeFile(input, pdf, { mode: 0o600 });
      const results: OcrPageResult[] = [];
      let done = 0;
      for (const n of pageNumbers) {
        if (o.signal?.aborted) throw o.signal.reason;
        const prefix = join(dir, `p${n}`);
        await execFileAsync(
          this.opts.pdftoppmPath,
          ['-r', String(this.opts.dpi), '-f', String(n), '-l', String(n), '-gray', '-png', input, prefix],
          { timeout: this.opts.timeoutMs, env: MINIMAL_ENV(), signal: o.signal, maxBuffer: 1024 * 1024 },
        );
        const image = (await readdir(dir)).find((f) => f.startsWith(`p${n}-`) && f.endsWith('.png'));
        if (!image) throw new Error(`Falha ao rasterizar a página ${n}`);
        const { stdout } = await execFileAsync(
          this.opts.tesseractPath,
          [join(dir, image), 'stdout', '-l', this.opts.languages, '--psm', '3', '--oem', '1', 'tsv'],
          { timeout: this.opts.timeoutMs, env: MINIMAL_ENV(), signal: o.signal, maxBuffer: 64 * 1024 * 1024 },
        );
        const parsed = parseTesseractTsv(stdout);
        results.push({ pageNumber: n, ...parsed });
        await rm(join(dir, image), { force: true });
        done++;
        await o.onPage?.(done, pageNumbers.length);
      }
      return results;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export class DisabledOcrEngine implements OcrEngine {
  readonly name = 'none';
  async available(): Promise<boolean> {
    return false;
  }
  async recognizePdfPages(): Promise<OcrPageResult[]> {
    throw new Error('OCR desabilitado');
  }
}
