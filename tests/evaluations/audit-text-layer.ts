/**
 * Auditoria da camada de texto das páginas já ingeridas: aponta páginas ilegíveis
 * (ex.: fontes sem mapa Unicode) que deveriam ter passado por OCR.
 * Uso: npx tsx tests/evaluations/audit-text-layer.ts [--verbose]
 */
import { loadEnv } from '@rag/config';
import { createRuntime, isUnreadableText, vowelRatio } from '@rag/rag';

const verbose = process.argv.includes('--verbose');
const runtime = createRuntime(loadEnv(), 'audit-text-layer');
try {
  const rows = await runtime.database.sql<{ title: string; page_number: number; text: string; ocr: boolean }[]>`
    SELECT d.title, p.page_number, p.text, p.ocr
    FROM document_pages p
    JOIN document_versions v ON v.id = p.version_id AND v.is_current
    JOIN documents d ON d.id = v.document_id AND d.deleted_at IS NULL
    ORDER BY d.title, p.page_number`;
  const byDoc = new Map<string, { pages: number; unreadable: number[]; ocr: number; ratios: number[] }>();
  for (const r of rows) {
    const s = byDoc.get(r.title) ?? { pages: 0, unreadable: [], ocr: 0, ratios: [] };
    s.pages++;
    if (r.ocr) s.ocr++;
    const { ratio, letters } = vowelRatio(r.text);
    if (letters >= 30) s.ratios.push(ratio);
    if (isUnreadableText(r.text)) s.unreadable.push(r.page_number);
    byDoc.set(r.title, s);
  }
  for (const [title, s] of byDoc) {
    const sorted = [...s.ratios].sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.toFixed(3) : '-');
    console.log(
      `${title.slice(0, 60).padEnd(60)} páginas=${s.pages} ocr=${s.ocr} ilegíveis=${s.unreadable.length} vogais(min/p10/mediana)=${q(0)}/${q(0.1)}/${q(0.5)}`,
    );
    if (verbose && s.unreadable.length) console.log(`  páginas ilegíveis: ${s.unreadable.join(', ')}`);
  }
} finally {
  await runtime.close();
}
