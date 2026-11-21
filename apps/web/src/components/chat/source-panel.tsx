'use client';

import { DOCUMENT_TYPE_LABELS, VALIDITY_STATUS_LABELS, type DocumentType, type SourceDto, type ValidityStatus } from '@rag/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, FileText, X } from 'lucide-react';
import Link from 'next/link';
import { api, API_BASE, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Button } from '../ui/button';
import { Alert, Badge, Skeleton } from '../ui/primitives';

interface SourceDetail {
  chunk: { id: string; content: string; pageStart: number | null; pageEnd: number | null; headingPath: string[]; sectionTitle: string | null; structuralRef: string | null; flags: string[] };
  document: { id: string; title: string; documentNumber: string | null; documentType: DocumentType; validityStatus: ValidityStatus; publicationDate: string | null; issuingBody: string | null; accessLevel: string };
  version: { id: string; versionNumber: number; isCurrent: boolean; format: string; fileName: string; pageCount: number | null } | null;
  pages: { pageNumber: number; text: string; ocr: boolean; ocrConfidence: number | null }[];
}

export function fileUrl(documentId: string, versionId: string | undefined, pdf: boolean, page?: number | null) {
  const qs = new URLSearchParams();
  if (versionId) qs.set('versionId', versionId);
  if (pdf) qs.set('disposition', 'inline');
  return `${API_BASE}/documents/${documentId}/file?${qs}${pdf && page ? `#page=${page}` : ''}`;
}

export interface OpenSource {
  source: SourceDto;
  page: number | null;
}

/** Marca o trecho citado dentro do texto da página (correspondência pelo início do trecho). */
function highlight(pageText: string, chunk: string) {
  const probe = chunk.replace(/\s+/g, ' ').trim().slice(0, 80);
  const flat = pageText.replace(/\s+/g, ' ');
  const idx = probe.length > 20 ? flat.indexOf(probe.slice(0, 40)) : -1;
  if (idx < 0) return <>{flat}</>;
  const end = Math.min(flat.length, idx + chunk.replace(/\s+/g, ' ').length);
  return (
    <>
      {flat.slice(0, idx)}
      <mark className="rounded bg-warning/40 px-0.5 text-foreground">{flat.slice(idx, end)}</mark>
      {flat.slice(end)}
    </>
  );
}

export function SourcePanel({ open, onClose }: { open: OpenSource | null; onClose: () => void }) {
  const chunkId = open?.source.chunkId;
  const q = useQuery({ queryKey: ['source', chunkId], queryFn: () => api<SourceDetail>(`/sources/${chunkId}`), enabled: !!chunkId, retry: false });
  if (!open) return null;
  const d = q.data;
  const historical = d && (d.document.validityStatus !== 'vigente' || (d.version && !d.version.isCurrent));
  const pages = d ? (open.page ? d.pages.filter((p) => p.pageNumber === open.page) : d.pages) : [];
  return (
    <aside className="flex h-full w-full flex-col border-l bg-card md:w-[420px]" aria-label="Fonte citada">
      <div className="flex items-start gap-2 border-b p-3">
        <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            Fonte {open.source.sourceNumber}
            {open.page ? ` · página ${open.page}` : ''}
          </p>
          <h2 className="truncate text-sm font-semibold" title={open.source.documentTitle}>
            {open.source.documentNumber ?? open.source.documentTitle}
          </h2>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fechar painel da fonte">
          <X />
        </Button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {q.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {q.isError && <Alert variant="destructive">{errorMessage(q.error)}</Alert>}
        {d && (
          <>
            <div className="space-y-1">
              <p className="font-medium">{d.document.title}</p>
              <div className="flex flex-wrap gap-1">
                <Badge variant="secondary">{DOCUMENT_TYPE_LABELS[d.document.documentType]}</Badge>
                <Badge variant={d.document.validityStatus === 'vigente' ? 'success' : 'warning'}>{VALIDITY_STATUS_LABELS[d.document.validityStatus]}</Badge>
                {d.version && <Badge variant="outline">v{d.version.versionNumber}</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                {d.document.issuingBody ?? 'Órgão não informado'} · publicado em {formatDate(d.document.publicationDate)}
              </p>
            </div>
            {historical && (
              <Alert variant="warning" className="flex gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{d.version && !d.version.isCurrent ? 'Este trecho pertence a uma versão anterior do documento.' : 'Documento não vigente: use apenas como referência histórica.'}</span>
              </Alert>
            )}
            {d.chunk.headingPath.length > 0 && <p className="text-xs text-muted-foreground">{d.chunk.headingPath.join(' › ')}</p>}
            <div>
              <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Trecho utilizado</p>
              <blockquote className="rounded-md border-l-4 border-primary/60 bg-muted/60 p-2 whitespace-pre-wrap">{d.chunk.content}</blockquote>
            </div>
            {pages.map((p) => (
              <div key={p.pageNumber}>
                <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Página {p.pageNumber}
                  {p.ocr && ` · OCR${p.ocrConfidence !== null ? ` (confiança ${Math.round(p.ocrConfidence)}%)` : ''}`}
                </p>
                <div className="max-h-80 overflow-y-auto rounded-md border p-2 text-xs leading-relaxed">{highlight(p.text, d.chunk.content)}</div>
              </div>
            ))}
            {open.page && d.pages.length > 0 && !pages.length && (
              <Alert variant="warning">A página citada ({open.page}) não está no intervalo deste trecho. A citação pode estar incorreta.</Alert>
            )}
          </>
        )}
      </div>
      {d && (
        <div className="flex gap-2 border-t p-3">
          <Button asChild variant="outline" size="sm">
            <a href={fileUrl(d.document.id, d.version?.id, d.version?.format === 'pdf', open.page)} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> Abrir original
            </a>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/documentos/${d.document.id}`}>Ver documento</Link>
          </Button>
        </div>
      )}
    </aside>
  );
}
