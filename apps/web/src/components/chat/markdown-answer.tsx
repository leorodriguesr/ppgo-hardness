'use client';

import { ExternalLink } from 'lucide-react';
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const BRACKET_RE = /\[([^\]\n]{1,200})\](?!\()/g;
const ITEM_RE = /Fontes?\s*(\d{1,3})(?:\s*[,–-]?\s*(?:p(?:á|a)g(?:ina)?s?\.?|p\.)\s*(\d{1,5})(?:\s*(?:[-–]|a|e)\s*(\d{1,5}))?)?/gi;

/** Converte marcadores "[Fonte N, página P]" em links internos (#fonte-N-P) renderizados como botões. */
export function linkCitations(text: string): string {
  return text.replace(BRACKET_RE, (whole, inner: string) => {
    if (!/fonte/i.test(inner)) return whole;
    if (/\bdocumento\b/i.test(inner)) {
      const n = inner.match(/Fontes?\s*(\d{1,3})/i)?.[1];
      return n ? `[Ver documento completo](#original-${n})` : whole;
    }
    const items = [...inner.matchAll(ITEM_RE)];
    if (!items.length) return whole;
    return items
      .map((m) => {
        const label = m[2] ? `Fonte ${m[1]}, p. ${m[2]}${m[3] ? `–${m[3]}` : ''}` : `Fonte ${m[1]}`;
        return `[${label}](#fonte-${m[1]}-${m[2] ?? '0'})`;
      })
      .join(' ');
  });
}

export const MarkdownAnswer = memo(function MarkdownAnswer({
  content,
  onCite,
  onOpenOriginal,
}: {
  content: string;
  onCite: (sourceNumber: number, page: number | null) => void;
  onOpenOriginal?: (sourceNumber: number) => void;
}) {
  const components: Components = {
    a: ({ href, children }) => {
      const original = href?.match(/^#original-(\d+)$/);
      if (original) {
        return (
          <button
            type="button"
            onClick={() => onOpenOriginal?.(Number(original[1]))}
            className="mx-0.5 inline-flex size-5 items-center justify-center rounded border border-primary/30 bg-primary/10 align-text-bottom text-primary hover:bg-primary/20"
            aria-label="Ver documento completo"
          >
            <ExternalLink className="size-3" />
          </button>
        );
      }
      const m = href?.match(/^#fonte-(\d+)-(\d+)$/);
      if (m) {
        const page = Number(m[2]) || null;
        return (
          <button
            type="button"
            onClick={() => onCite(Number(m[1]), page)}
            className="mx-0.5 inline-flex items-center rounded border border-primary/30 bg-primary/10 px-1 py-px align-baseline text-[0.78em] font-medium text-primary hover:bg-primary/20"
            aria-label={`Abrir ${String(children)}`}
          >
            {children}
          </button>
        );
      }
      // Links externos vindos do conteúdo não são seguidos automaticamente
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline">
          {children}
        </a>
      );
    },
  };
  // Sem rehype-raw: HTML presente na resposta é exibido como texto, nunca interpretado
  return (
    <div className="prose-answer">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {linkCitations(content)}
      </ReactMarkdown>
    </div>
  );
});
