import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class PdftotextUnavailable extends Error {
  constructor() {
    super('pdftotext não está instalado');
    this.name = 'PdftotextUnavailable';
  }
}

export class PdftotextFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdftotextFailed';
  }
}

/** Páginas na ordem do PDF. O Poppler separa cada página com um form feed final. */
export function splitPdftotextPages(stdout: string): string[] {
  const parts = stdout.split('\f');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

let available: Promise<boolean> | null = null;

export function pdftotextAvailable(): Promise<boolean> {
  available ??= exec('pdftotext', ['-v'], { timeout: 5_000 })
    .then(() => true)
    .catch((err: { code?: string | number }) => err.code !== 'ENOENT');
  return available;
}

/** Lê o PDF inteiro uma vez. Devolve null quando o programa não está instalado. */
export async function readPdfWithPdftotext(data: Buffer, signal?: AbortSignal): Promise<string[] | null> {
  if (!(await pdftotextAvailable())) return null;
  const dir = await mkdtemp(join(tmpdir(), 'rag-pdftotext-'));
  try {
    const pdfPath = join(dir, 'doc.pdf');
    await writeFile(pdfPath, data);
    try {
      const { stdout } = await exec('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        signal,
        encoding: 'utf8',
      });
      return splitPdftotextPages(stdout);
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
      const code = (err as { code?: string | number }).code;
      if (code === 'ENOENT') return null;
      throw new PdftotextFailed(err instanceof Error ? err.message : 'pdftotext falhou');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
