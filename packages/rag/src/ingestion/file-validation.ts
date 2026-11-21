import { inflateRawSync } from 'node:zlib';
import { AppError, FILE_FORMAT_MIME, type FileFormat } from '@rag/shared';

export interface ValidatedFile {
  format: FileFormat;
  mimeType: string;
  safeFileName: string;
  extension: string;
  /** Alertas não bloqueantes (ex.: PDF com JavaScript removido do processamento). */
  warnings: string[];
}

const EXTENSIONS: Record<string, FileFormat> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'txt',
  text: 'txt',
  md: 'md',
  markdown: 'md',
};

/**
 * Normaliza o nome do arquivo para exibição: remove diretórios, caracteres de controle,
 * separadores de caminho e sequências perigosas. O nome nunca é usado como caminho físico.
 */
export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s-]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return cleaned || 'documento';
}

export function fileExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

const startsWith = (buf: Buffer, sig: number[]) => sig.every((b, i) => buf[i] === b);

/** Lê as entradas do diretório central de um ZIP (sem extrair), para inspecionar DOCX. */
export function listZipEntries(buf: Buffer): string[] {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP sem diretório central');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Entrada ZIP corrompida');
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8'));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Extrai uma entrada específica de um ZIP (stored/deflate). Usado para validação de DOCX. */
export function readZipEntry(buf: Buffer, entryName: string, maxBytes = 50 * 1024 * 1024): Buffer | null {
  let offset = 0;
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const uncompSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    if (name === entryName) {
      if (uncompSize > maxBytes) throw new Error('Entrada ZIP excede o limite de descompressão');
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
      throw new Error('Método de compressão ZIP não suportado');
    }
    if (compSize === 0) return null; // data descriptor: recorre a outro leitor
    offset = dataStart + compSize;
  }
  return null;
}

function validatePdf(buf: Buffer, warnings: string[]): void {
  if (!startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Arquivo não é um PDF válido (assinatura ausente)');
  const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
  if (!tail.includes('%%EOF')) throw new AppError('PROCESSING_ERROR', 'PDF corrompido ou truncado (marcador %%EOF ausente)');
  const head = buf.toString('latin1');
  if (/\/Encrypt\s/.test(head)) throw new AppError('PROCESSING_ERROR', 'PDF protegido por senha/criptografia não é suportado');
  if (/\/(JavaScript|JS)\s*[(<\[]/.test(head) || /\/Launch\b/.test(head)) {
    warnings.push('pdf_active_content');
  }
  if (/\/EmbeddedFile\b/.test(head)) warnings.push('pdf_embedded_files');
}

function validateDocx(buf: Buffer, warnings: string[]): void {
  if (!startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Arquivo não é um DOCX válido (assinatura ZIP ausente)');
  let entries: string[];
  try {
    entries = listZipEntries(buf);
  } catch {
    throw new AppError('PROCESSING_ERROR', 'DOCX corrompido (estrutura ZIP inválida)');
  }
  if (!entries.includes('word/document.xml') || !entries.includes('[Content_Types].xml')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Arquivo ZIP não é um documento Word (.docx)');
  }
  if (entries.some((e) => /vbaProject\.bin$/i.test(e))) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Documentos com macros não são aceitos');
  }
  if (entries.some((e) => /^word\/embeddings\//i.test(e))) warnings.push('docx_embedded_objects');
  if (entries.some((e) => e.includes('..') || e.startsWith('/'))) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'DOCX contém caminhos internos inválidos');
  }
}

function validateText(buf: Buffer): void {
  if (buf.length === 0) throw new AppError('PROCESSING_ERROR', 'Arquivo de texto vazio');
  const sample = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  if (sample.includes(0)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Arquivo de texto contém dados binários');
  const text = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (replacement > Math.max(5, text.length * 0.01)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Arquivo de texto não está em UTF-8 válido');
  }
}

/**
 * Valida o arquivo pelo conteúdo (assinatura binária), não apenas pela extensão ou MIME
 * informados pelo cliente, que não são confiáveis.
 */
export function validateUpload(
  input: { fileName: string; declaredMime?: string; data: Buffer },
  limits: { maxBytes: number; allowedFormats: FileFormat[] },
): ValidatedFile {
  const safeFileName = sanitizeFileName(input.fileName);
  const extension = fileExtension(safeFileName);
  const format = EXTENSIONS[extension];
  if (!format) throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Formato não suportado: .${extension || '?'}. Aceitos: PDF, DOCX, TXT, MD`);
  if (!limits.allowedFormats.includes(format)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Formato ${format.toUpperCase()} desabilitado nas configurações`);
  if (input.data.length === 0) throw new AppError('VALIDATION_ERROR', 'Arquivo vazio');
  if (input.data.length > limits.maxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', `Arquivo excede o limite de ${Math.round(limits.maxBytes / 1024 / 1024)} MB`);
  }
  const warnings: string[] = [];
  switch (format) {
    case 'pdf':
      validatePdf(input.data, warnings);
      break;
    case 'docx':
      validateDocx(input.data, warnings);
      break;
    case 'txt':
    case 'md':
      if (startsWith(input.data, [0x25, 0x50, 0x44, 0x46]) || startsWith(input.data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(input.data, [0x4d, 0x5a])) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Conteúdo binário com extensão de texto');
      }
      validateText(input.data);
      break;
  }
  const declared = input.declaredMime?.split(';')[0]?.trim().toLowerCase();
  const textual = format === 'txt' || format === 'md';
  const acceptableDeclared =
    !declared ||
    declared === 'application/octet-stream' ||
    declared === FILE_FORMAT_MIME[format] ||
    (textual && declared.startsWith('text/')) ||
    (format === 'docx' && declared === 'application/zip');
  if (!acceptableDeclared) warnings.push('declared_mime_mismatch');
  return { format, mimeType: FILE_FORMAT_MIME[format], safeFileName, extension, warnings };
}
