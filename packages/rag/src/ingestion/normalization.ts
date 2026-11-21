import type { ExtractedPage } from './extractors/types';

const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
};

/**
 * Limpeza de uma linha sem alterar conteúdo substantivo:
 * - normalização Unicode NFC (não NFKC, que transformaria "1º" em "1o");
 * - remove caracteres de controle, de largura zero, hífen suave e marcas bidi;
 * - expande ligaduras tipográficas (ﬁ → fi) e converte espaços especiais em espaço comum.
 */
export function cleanLine(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] ?? c)
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000\t]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Assinatura de linha para detectar cabeçalhos/rodapés repetidos (dígitos neutralizados). */
export function lineSignature(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

const PAGE_NUMBER_RE = /^(?:-\s*)?(?:p[aá]g(?:ina)?\.?\s*)?\d{1,4}(?:\s*(?:\/|de)\s*\d{1,4})?(?:\s*-)?$/i;

export function isPageNumberLine(text: string): boolean {
  return PAGE_NUMBER_RE.test(text.trim());
}

const EDGE_LINES = 3;

/**
 * Remove cabeçalhos e rodapés que se repetem em várias páginas (ex.: brasão, nome do órgão,
 * "Página 3 de 10") e números de página isolados nas bordas. Só atua em documentos com 3+ páginas
 * e apenas nas primeiras/últimas linhas de cada página, para não remover conteúdo legítimo.
 */
export function removeRepeatedEdges(pages: ExtractedPage[]): { pages: ExtractedPage[]; removed: number } {
  let removed = 0;
  const textPages = pages.filter((p) => p.lines.length > 0);
  const counts = new Map<string, number>();
  if (textPages.length >= 3) {
    for (const p of textPages) {
      const seen = new Set<string>();
      const edges = [...p.lines.slice(0, EDGE_LINES), ...p.lines.slice(-EDGE_LINES)];
      for (const l of edges) {
        const sig = lineSignature(l.text);
        if (sig.length < 3 || seen.has(sig)) continue;
        seen.add(sig);
        counts.set(sig, (counts.get(sig) ?? 0) + 1);
      }
    }
  }
  const threshold = Math.max(3, Math.ceil(textPages.length * 0.6));
  const repeated = new Set([...counts].filter(([, c]) => c >= threshold).map(([s]) => s));

  const out = pages.map((p) => {
    const n = p.lines.length;
    const lines = p.lines.filter((l, idx) => {
      const atEdge = idx < EDGE_LINES || idx >= n - EDGE_LINES;
      if (!atEdge) return true;
      if (repeated.has(lineSignature(l.text)) || isPageNumberLine(l.text)) {
        removed++;
        return false;
      }
      return true;
    });
    return { ...p, lines };
  });
  return { pages: out, removed };
}

/** Une linhas quebradas por hifenização de fim de linha ("procedi-" + "mento"). */
export function joinWrappedLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) {
      out = line;
      continue;
    }
    if (/\p{Ll}-$/u.test(out) && /^\p{Ll}/u.test(line)) {
      out = out.slice(0, -1) + line;
    } else {
      out += ' ' + line;
    }
  }
  return out;
}

/** Texto normalizado para indexação: espaços colapsados, sem quebras de linha. */
export function normalizeForIndex(text: string): string {
  return cleanLine(text.replace(/\n+/g, ' '));
}

export function normalizePages(pages: ExtractedPage[]): { pages: ExtractedPage[]; removedEdgeLines: number } {
  const cleaned = pages.map((p) => ({
    ...p,
    lines: p.lines.map((l) => ({ ...l, text: cleanLine(l.text) })).filter((l, i, arr) => l.text.length > 0 || (i > 0 && arr[i - 1]!.text.length > 0)),
  }));
  const { pages: out, removed } = removeRepeatedEdges(cleaned);
  return { pages: out, removedEdgeLines: removed };
}
