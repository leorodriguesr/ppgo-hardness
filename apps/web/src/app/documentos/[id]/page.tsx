'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  DOCUMENT_TYPE_LABELS,
  PROCESSING_STATUS_LABELS,
  type ChunkDto,
  type DocumentDetailDto,
  type DocumentVersionDto,
  type PageDto,
  type Paginated,
  type ProcessingEventDto,
  type UploadResultDto,
} from '@rag/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FilePlus2, Power, RefreshCw, Save, Unlink } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { AccessBadge, isProcessing, ProcessingStatus, ValidityBadge } from '@/components/documents/badges';
import { MetadataFields, toMetadataPayload, type MetadataFormValues } from '@/components/documents/metadata-fields';
import { fileUrl } from '@/components/chat/source-panel';
import { RelatedActs } from '../relacoes';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Progress, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { api, errorMessage, uploadWithProgress } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { formatBytes, formatDate, formatDateTime, formatMs } from '@/lib/utils';

const optionalDate = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')]);
const formSchema = z.object({
  title: z.string().trim().min(1, 'Título é obrigatório').max(500),
  documentNumber: z.string().max(120),
  documentType: z.string(),
  categoryId: z.string(),
  issuingBody: z.string().max(300),
  publicationDate: optionalDate,
  effectiveDate: optionalDate,
  validityStatus: z.string(),
  accessLevel: z.string(),
  description: z.string().max(4000),
});

const QUALITY_FLAG_LABELS: Record<string, string> = {
  low_text_density: 'pouco texto extraível',
  ocr_low_confidence: 'OCR com baixa confiança',
  low_ocr_confidence: 'OCR com baixa confiança',
  pages_without_text: 'páginas sem texto aproveitável',
  unreadable_text_layer: 'texto digital ilegível (lido por OCR)',
  leitura_alternativa: 'página relida porque o texto digital veio quebrado',
  ocr_unavailable: 'OCR indisponível',
  ocr_disabled: 'OCR desativado',
  pdf_active_content: 'PDF com conteúdo ativo (não executado)',
  pdf_embedded_files: 'PDF com arquivos anexos (ignorados)',
  docx_embedded_objects: 'DOCX com objetos incorporados (ignorados)',
  prompt_injection_suspected: 'texto com instruções ao assistente (neutralizado)',
  declared_mime_mismatch: 'tipo declarado divergente do conteúdo',
};

function VersionRow({ v, documentId }: { v: DocumentVersionDto; documentId: string }) {
  return (
    <tr className="border-t align-top">
      <td className="px-3 py-2 whitespace-nowrap">
        v{v.versionNumber} {v.isCurrent && <Badge variant="default">atual</Badge>}
      </td>
      <td className="px-3 py-2">
        <p className="max-w-56 truncate" title={v.fileName}>
          {v.fileName}
        </p>
        <p className="text-xs text-muted-foreground">
          {v.format.toUpperCase()} · {formatBytes(v.sizeBytes)} {v.pageCount ? `· ${v.pageCount} pág.` : ''}
        </p>
      </td>
      <td className="px-3 py-2">
        <ProcessingStatus version={v} compact />
        {v.errorMessage && <p className="mt-1 max-w-64 text-xs text-destructive">{v.errorMessage}</p>}
      </td>
      <td className="px-3 py-2 text-xs">
        <p>{v.chunkCount} trechos</p>
        <p className="text-muted-foreground">
          {v.extractionMethod === 'ocr' ? 'OCR' : v.extractionMethod === 'mixed' ? `texto + OCR (${v.ocrPages} pág.)` : v.extractionMethod === 'text' ? 'texto nativo' : '—'}
        </p>
        {v.qualityFlags.map((f) => (
          <Badge key={f} variant="warning" className="mt-1 mr-1">
            {QUALITY_FLAG_LABELS[f] ?? f}
          </Badge>
        ))}
      </td>
      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
        <p>{formatDateTime(v.createdAt)}</p>
        <p>{v.processingMs !== null ? `processado em ${formatMs(v.processingMs)}` : ''}</p>
      </td>
      <td className="px-3 py-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label={`Baixar versão ${v.versionNumber}`}>
          <a href={fileUrl(documentId, v.id, false)}>
            <Download />
          </a>
        </Button>
      </td>
    </tr>
  );
}

function ChunksTab({ documentId }: { documentId: string }) {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['chunks', documentId, page], queryFn: () => api<Paginated<ChunkDto>>(`/documents/${documentId}/chunks?page=${page}&pageSize=20`) });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) return <Alert variant="destructive">{errorMessage(q.error)}</Alert>;
  if (!q.data?.items.length) return <EmptyState title="Nenhum trecho gerado ainda." />;
  const pages = Math.ceil(q.data.total / 20);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{q.data.total} trechos na versão atual</p>
      {q.data.items.map((c) => (
        <div key={c.id} className="rounded-md border p-3 text-sm">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="secondary">#{c.chunkIndex + 1}</Badge>
            {c.structuralRef && <Badge variant="outline">{c.structuralRef}</Badge>}
            {c.pageStart && <span>p. {c.pageStart === c.pageEnd || !c.pageEnd ? c.pageStart : `${c.pageStart}–${c.pageEnd}`}</span>}
            <span>{c.tokenCount} tokens</span>
            {c.headingPath.length > 0 && <span className="truncate">{c.headingPath.join(' › ')}</span>}
            {c.flags.map((f) => (
              <Badge key={f} variant="warning">
                {QUALITY_FLAG_LABELS[f] ?? f}
              </Badge>
            ))}
          </div>
          <p className="whitespace-pre-wrap">{c.content}</p>
        </div>
      ))}
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Anterior
          </Button>
          <span>
            {page}/{pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Próxima
          </Button>
        </div>
      )}
    </div>
  );
}

function PagesTab({ documentId }: { documentId: string }) {
  const q = useQuery({ queryKey: ['pages', documentId], queryFn: () => api<{ pages: PageDto[] }>(`/documents/${documentId}/pages`) });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) return <Alert variant="destructive">{errorMessage(q.error)}</Alert>;
  if (!q.data?.pages.length) return <EmptyState title="Nenhuma página extraída." />;
  return (
    <div className="space-y-3">
      {q.data.pages.map((p) => (
        <div key={p.pageNumber} className="rounded-md border">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
            <span className="font-medium">Página {p.pageNumber}</span>
            {p.ocr && <Badge variant={p.ocrConfidence !== null && p.ocrConfidence < 70 ? 'warning' : 'secondary'}>OCR {p.ocrConfidence !== null ? `· ${Math.round(p.ocrConfidence)}%` : ''}</Badge>}
          </div>
          <p className="max-h-72 overflow-y-auto p-3 text-xs leading-relaxed whitespace-pre-wrap">{p.text || <em className="text-muted-foreground">(sem texto)</em>}</p>
        </div>
      ))}
    </div>
  );
}

function EventsTab({ documentId, live }: { documentId: string; live: boolean }) {
  const q = useQuery({ queryKey: ['events', documentId], queryFn: () => api<{ items: ProcessingEventDto[] }>(`/documents/${documentId}/events`), refetchInterval: live ? 2000 : false });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) return <Alert variant="destructive">{errorMessage(q.error)}</Alert>;
  return (
    <ol className="space-y-1.5 text-sm">
      {q.data?.items.map((e) => (
        <li key={e.id} className="flex gap-3 rounded-md border px-3 py-1.5">
          <span className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">{formatDateTime(e.createdAt)}</span>
          <Badge variant={e.level === 'error' ? 'destructive' : e.level === 'warn' ? 'warning' : 'secondary'} className="h-fit">
            {e.stage in PROCESSING_STATUS_LABELS ? PROCESSING_STATUS_LABELS[e.stage as keyof typeof PROCESSING_STATUS_LABELS] : e.stage === 'queued' ? 'Na fila' : e.stage}
          </Badge>
          <span className="min-w-0 break-words">{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { can } = useMe();
  const isAdmin = can('admin');
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [versionProgress, setVersionProgress] = useState<number | null>(null);
  const versionInput = useRef<HTMLInputElement>(null);

  const doc = useQuery({
    queryKey: ['document', id],
    queryFn: () => api<DocumentDetailDto>(`/documents/${id}`),
    refetchInterval: (query) => (query.state.data?.versions.some(isProcessing) ? 2000 : false),
  });
  const d = doc.data;
  const processing = !!d?.versions.some(isProcessing);

  const form = useForm<z.infer<typeof formSchema>>({ resolver: zodResolver(formSchema) });
  useEffect(() => {
    if (!d) return;
    form.reset({
      title: d.title,
      documentNumber: d.documentNumber ?? '',
      documentType: d.documentType,
      categoryId: d.categoryId ?? '',
      issuingBody: d.issuingBody ?? '',
      publicationDate: d.publicationDate?.slice(0, 10) ?? '',
      effectiveDate: d.effectiveDate?.slice(0, 10) ?? '',
      validityStatus: d.validityStatus,
      accessLevel: d.accessLevel,
      description: d.description ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.updatedAt]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['document', id] });
    void qc.invalidateQueries({ queryKey: ['documents'] });
  };
  const save = useMutation({
    mutationFn: (v: MetadataFormValues) => api<{ reembedQueued: boolean }>(`/documents/${id}`, { method: 'PATCH', json: { ...toMetadataPayload(v), expectedUpdatedAt: d?.updatedAt } }),
    onSuccess: (r) => {
      toast.success(r.reembedQueued ? 'Metadados salvos. Os embeddings serão atualizados.' : 'Metadados salvos.');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reprocess = useMutation({
    mutationFn: () => api(`/documents/${id}/reprocess`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Reprocessamento iniciado.');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggleActive = useMutation({
    mutationFn: (isActive: boolean) => api(`/documents/${id}`, { method: 'PATCH', json: { isActive } }),
    onSuccess: (_r, isActive) => {
      toast.success(isActive ? 'Documento reativado.' : 'Documento desativado: não será mais usado nas respostas.');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const detach = useMutation({
    mutationFn: () => api(`/documents/${id}/detach`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Documento desanexado. O ato continua na lista do site.');
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['catalog'] });
      router.push('/documentos');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const uploadVersion = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    setVersionProgress(0);
    try {
      const r = await uploadWithProgress<UploadResultDto & { versionNumber?: number }>(`/documents/${id}/versions`, fd, setVersionProgress);
      if (r.status === 'duplicate') toast.warning(r.reason ?? 'Arquivo idêntico a uma versão existente.');
      else toast.success(`Versão ${r.versionNumber} enviada. Ela se tornará a atual quando o processamento terminar.`);
      invalidate();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setVersionProgress(null);
    }
  };

  if (doc.isLoading)
    return (
      <div className="mx-auto max-w-6xl space-y-3 p-6">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40" />
      </div>
    );
  if (doc.isError || !d)
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert variant="destructive">{doc.isError ? errorMessage(doc.error) : 'Documento não encontrado.'}</Alert>
      </div>
    );

  const latest = d.versions[0] ?? null;
  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div>
        <Link href="/documentos" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Biblioteca
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold break-words">{d.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <span>{d.documentNumber ?? 'Sem número'}</span>·<span>{DOCUMENT_TYPE_LABELS[d.documentType]}</span>·<span>publicado em {formatDate(d.publicationDate)}</span>
              <ValidityBadge status={d.validityStatus} />
              <AccessBadge level={d.accessLevel} />
              {!d.isActive && <Badge variant="destructive">Desativado</Badge>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {d.currentVersion && (
              <Button asChild variant="outline" size="sm">
                <a href={fileUrl(d.id, d.currentVersion.id, d.currentVersion.format === 'pdf')} target="_blank" rel="noopener noreferrer">
                  <Download /> Original
                </a>
              </Button>
            )}
            {isAdmin && (
              <>
                <Button variant="outline" size="sm" onClick={() => reprocess.mutate()} disabled={processing || reprocess.isPending}>
                  <RefreshCw /> Reprocessar
                </Button>
                <Button variant="outline" size="sm" onClick={() => versionInput.current?.click()} disabled={processing || versionProgress !== null}>
                  <FilePlus2 /> Nova versão
                </Button>
                <input
                  ref={versionInput}
                  type="file"
                  className="hidden"
                  accept=".pdf,.docx,.txt,.md"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadVersion(f);
                    e.target.value = '';
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => toggleActive.mutate(!d.isActive)} disabled={toggleActive.isPending}>
                  <Power /> {d.isActive ? 'Desativar' : 'Reativar'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmDetach(true)}>
                  <Unlink /> Desanexar
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <RelatedActs documentId={d.id} />

      {versionProgress !== null && (
        <div className="flex items-center gap-2 text-sm">
          Enviando nova versão <Progress value={Math.round(versionProgress * 100)} className="max-w-xs" /> {Math.round(versionProgress * 100)}%
        </div>
      )}
      {latest && isProcessing(latest) && (
        <Card>
          <CardContent className="pt-4">
            <p className="mb-2 text-sm font-medium">Processando versão {latest.versionNumber}</p>
            <ProcessingStatus version={latest} />
          </CardContent>
        </Card>
      )}
      {latest?.status === 'error' && (
        <Alert variant="destructive">
          Falha no processamento da versão {latest.versionNumber}: {latest.errorMessage ?? 'erro desconhecido'}. {isAdmin && 'Corrija o arquivo e envie nova versão, ou tente reprocessar.'}
        </Alert>
      )}

      <Tabs defaultValue="metadados">
        <TabsList>
          <TabsTrigger value="metadados">Metadados</TabsTrigger>
          <TabsTrigger value="versoes">Versões ({d.versions.length})</TabsTrigger>
          <TabsTrigger value="trechos">Trechos</TabsTrigger>
          <TabsTrigger value="paginas">Páginas</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
        </TabsList>
        <TabsContent value="metadados">
          <Card>
            <CardHeader>
              <CardTitle>Metadados</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
                <fieldset disabled={!isAdmin} className="space-y-4">
                  <MetadataFields register={form.register} errors={form.formState.errors} withTitle withNumber />
                </fieldset>
                {isAdmin && (
                  <div className="flex justify-end">
                    <Button type="submit" disabled={!form.formState.isDirty || save.isPending}>
                      <Save /> Salvar alterações
                    </Button>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="versoes">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Versão</th>
                  <th className="px-3 py-2 font-medium">Arquivo</th>
                  <th className="px-3 py-2 font-medium">Processamento</th>
                  <th className="px-3 py-2 font-medium">Resultado</th>
                  <th className="px-3 py-2 font-medium">Data</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.versions.map((v) => (
                  <VersionRow key={v.id} v={v} documentId={d.id} />
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="trechos">
          <ChunksTab documentId={d.id} />
        </TabsContent>
        <TabsContent value="paginas">
          <PagesTab documentId={d.id} />
        </TabsContent>
        <TabsContent value="historico">
          <EventsTab documentId={d.id} live={processing} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDetach}
        onOpenChange={setConfirmDetach}
        title="Desanexar documento?"
        description="O arquivo sai do chat e da indexação. O ato permanece na lista, como no site da Polícia Penal, e pode ser indexado de novo se estiver em vigor."
        confirmLabel="Desanexar"
        pending={detach.isPending}
        onConfirm={() => detach.mutate()}
      />
    </div>
  );
}
