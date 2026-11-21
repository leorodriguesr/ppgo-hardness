import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash estável de conteúdo textual: insensível a diferenças de espaços em branco. */
export function contentHash(text: string): string {
  return sha256Hex(text.normalize('NFC').replace(/\s+/g, ' ').trim());
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
