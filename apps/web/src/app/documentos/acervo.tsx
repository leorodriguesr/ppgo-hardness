'use client';

import {
  CATALOG_STATUSES,
  CATALOG_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  type CatalogActDto,
  type CatalogListDto,
  type CatalogRelationAct,
  type CatalogRelationsDto,
  type CatalogStatus,
  type CatalogSyncDto,
  type ValidityStatus,
} from '@rag/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Download, FileText, RefreshCw, Search, Unlink, Upload } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { isProcessing, ProcessingStatus, ValidityBadge } from '@/components/documents/badges';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, Badge, EmptyState, Input, NativeSelect, Skeleton } from '@/components/ui/primitives';
import { api, errorMessage, uploadWithProgress } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { formatDate, formatDateTime } from '@/lib/utils';

const PAGE_SIZE = 20;

type Indexable = {
  origin: 'catalog' | 'upload';
  source: 'legisla' | 'site' | null;
  externalId: number | null;
  fileKind: 'legisla' | 'pdf' | null;
  status: CatalogStatus;
  documentId: string | null;
  validityStatus: ValidityStatus;
  title: string;
  incorporatedInto: string | null;
};

function linkSummary(act: CatalogActDto): string | null {
  const parts: string[] = [];
  if (act.amendments > 0) parts.push(`${act.amendments} ${act.amendments === 1 ? 'alteração' : 'alterações'}`);
  if (act.revocations > 0) parts.push(`${act.revocations} ${act.revocations === 1 ? 'revogada' : 'revogadas'}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function CatalogEntry({ act, actions }: { act: CatalogActDto; actions: (target: Indexable) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const summary = linkSummary(act);
  const related = useQuery({
    queryKey: ['catalog-links', act.source, act.externalId],
    queryFn: () => api<CatalogRelationsDto>(`/catalog/links?source=${act.source}&externalId=${act.externalId}`),
    enabled: open && act.source != null && act.externalId != null,
  });
  return (
    <>
      <tr className="border-t align-top hover:bg-muted/40" data-testid="document-row">
        <td className="max-w-md px-3 py-2">
          {act.documentId ? (
            <Link href={`/documentos/${act.documentId}`} className="font-medium hover:underline">
              {act.title}
            </Link>
          ) : (
            <p className="font-medium">{act.title}</p>
          )}
          {act.description && <p className="line-clamp-2 text-xs text-muted-foreground">{act.description}</p>}
          {act.incorporatedInto && <p className="text-xs text-muted-foreground">Incorporada a {act.incorporatedInto}</p>}
          {!act.isActive && <p className="text-xs text-muted-foreground">Desativado</p>}
          {summary && (
            <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary" onClick={() => setOpen((value) => !value)}>
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {summary}
            </button>
          )}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">{DOCUMENT_TYPE_LABELS[act.documentType]}</td>
        <td className="px-3 py-2 whitespace-nowrap">{formatDate(act.publicationDate)}</td>
        <td className="px-3 py-2">
          <ValidityBadge status={act.validityStatus} />
          {act.revokedBy && <p className="mt-1 max-w-48 text-xs text-muted-foreground">Revogado por {act.revokedBy}</p>}
        </td>
        <td className="px-3 py-2">
          <CatalogStatusBadge act={act} />
          {act.errorMessage && act.status !== 'pendente' && <p className="mt-1 max-w-56 text-xs text-destructive">{act.errorMessage}</p>}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">{actions(act)}</td>
      </tr>
      {open && (
        <tr className="border-t bg-muted/30">
          <td colSpan={6} className="px-3 py-2">
            {related.isLoading && <Skeleton className="h-8" />}
            {related.isError && <p className="text-xs text-destructive">{errorMessage(related.error)}</p>}
            <div className="ml-3 flex flex-col gap-2 border-l pl-3">
              {related.data?.children.map((child) => (
                <LinkedChild key={`${child.linkKind}-${child.source}-${child.externalId}`} child={child} actions={actions} />
              ))}
              {related.data?.children.length === 0 && <p className="text-xs text-muted-foreground">Nenhum ato vinculado.</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function LinkedChild({ child, actions }: { child: CatalogRelationAct; actions: (target: Indexable) => ReactNode }) {
  const label = child.linkKind === 'revogacao' ? 'Revogada' : child.incorporated ? 'Alteração incorporada' : 'Alteração';
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          {label}
          {child.publicationDate ? ` · ${formatDate(child.publicationDate)}` : ''}
        </p>
        {child.documentId ? (
          <Link href={`/documentos/${child.documentId}`} className="text-sm font-medium hover:underline">
            {child.title}
          </Link>
        ) : (
          <p className="text-sm font-medium">{child.title}</p>
        )}
      </div>
      {actions({
        origin: 'catalog',
        source: child.source,
        externalId: child.externalId,
        fileKind: child.fileKind,
        status: child.status,
        documentId: child.documentId,
        validityStatus: child.validityStatus,
        title: child.title,
        incorporatedInto: child.incorporated ? child.title : null,
      })}
    </div>
  );
}

function CatalogStatusBadge({ act }: { act: CatalogActDto }) {
  if (act.status === 'ingerido' && act.currentVersion) return <ProcessingStatus version={act.currentVersion} compact />;
  if (act.status === 'ingerido') return <Badge variant="success">{CATALOG_STATUS_LABELS.ingerido}</Badge>;
  if (act.status === 'erro') {
    return (
      <Badge variant="destructive" title={act.errorMessage ?? undefined}>
        {CATALOG_STATUS_LABELS.erro}
      </Badge>
    );
  }
  if (act.status === 'baixando') return <Badge variant="secondary">{CATALOG_STATUS_LABELS.baixando}</Badge>;
  return <Badge variant="outline">{CATALOG_STATUS_LABELS.pendente}</Badge>;
}

export function AcervoPanel() {
  const { can } = useMe();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [showLinked, setShowLinked] = useState(false);
  const [ingestingId, setIngestingId] = useState<number | null>(null);
  const [detachTarget, setDetachTarget] = useState<{ id: string; title: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (showLinked) params.set('vinculos', 'mostrar');

  const list = useQuery({
    queryKey: ['catalog', params.toString()],
    queryFn: () => api<CatalogListDto>(`/catalog?${params}`),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      const busy = items.some((act) => act.status === 'baixando' || (act.status === 'ingerido' && isProcessing(act.currentVersion)));
      return busy ? 2500 : false;
    },
  });

  const syncState = useQuery({
    queryKey: ['catalog-sync'],
    queryFn: () => api<CatalogSyncDto>('/catalog/sync'),
    enabled: can('admin'),
  });

  const syncNow = useMutation({
    mutationFn: () => api<{ queued: boolean }>('/catalog/sync', { method: 'POST' }),
    onSuccess: (result) => {
      toast.success(result.queued ? 'Sincronização iniciada.' : 'Já existe uma sincronização em andamento.');
      void queryClient.invalidateQueries({ queryKey: ['catalog-sync'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const ingest = useMutation({
    mutationFn: (act: { externalId: number; source: 'legisla' | 'site' }) =>
      api<{ documentId: string }>(`/catalog/${act.externalId}/ingest?source=${act.source}`, { method: 'POST' }),
    onMutate: (act) => setIngestingId(act.externalId),
    onSuccess: () => {
      toast.success('PDF recebido. A indexação continua em segundo plano.');
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
    onSettled: () => setIngestingId(null),
  });

  const uploadPdf = useMutation({
    mutationFn: ({ externalId, source, file }: { externalId: number; source: 'legisla' | 'site'; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      return uploadWithProgress<{ documentId: string }>(`/catalog/${externalId}/file?source=${source}`, form, () => {});
    },
    onMutate: ({ externalId }) => setIngestingId(externalId),
    onSuccess: () => {
      toast.success('PDF recebido. A indexação continua em segundo plano.');
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    },
    onSettled: () => setIngestingId(null),
  });

  const detach = useMutation({
    mutationFn: (documentId: string) => api(`/documents/${documentId}/detach`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Documento desanexado. Ele continua na lista.');
      setDetachTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const renderActions = (act: Indexable) => {
    const busy = act.origin === 'catalog' && (ingestingId === act.externalId || act.status === 'baixando');
    const source = act.source ?? 'legisla';
    const canDownload = act.fileKind === 'pdf' || act.fileKind === 'legisla' || (source === 'legisla' && act.fileKind == null);
    const canIngest =
      act.validityStatus !== 'revogado' &&
      act.origin === 'catalog' &&
      act.externalId !== null &&
      can('admin') &&
      (act.status === 'pendente' || act.status === 'erro' || (act.status === 'ingerido' && !act.documentId));
    return (
      <div className="flex flex-wrap gap-1">
        {canIngest && canDownload && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act.externalId !== null && ingest.mutate({ externalId: act.externalId, source })}>
            <Download /> {busy ? (uploadPdf.isPending ? 'Enviando…' : 'Baixando…') : act.status === 'erro' ? 'Tentar de novo' : act.incorporatedInto ? 'Indexar mesmo assim' : 'Baixar e indexar'}
          </Button>
        )}
        {canIngest && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (!fileRef.current || act.externalId === null) return;
              fileRef.current.dataset.externalId = String(act.externalId);
              fileRef.current.dataset.source = source;
              fileRef.current.click();
            }}
          >
            <Upload /> Enviar PDF
          </Button>
        )}
        {act.documentId && can('admin') && (
          <Button size="sm" variant="outline" disabled={detach.isPending} onClick={() => act.documentId && setDetachTarget({ id: act.documentId, title: act.title })}>
            <Unlink /> Desanexar
          </Button>
        )}
      </div>
    );
  };

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;
  const counts = list.data?.counts;
  const totalActs = counts ? CATALOG_STATUSES.reduce((sum, key) => sum + counts[key], 0) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {totalActs !== null
            ? `${totalActs} documentos · ${counts?.ingerido ?? 0} indexados · ${counts?.pendente ?? 0} aguardando${counts?.erro ? ` · ${counts.erro} com falha` : ''}${!showLinked && list.data?.nested ? ` · ${list.data.nested} agrupados` : ''}`
            : 'Carregando a lista…'}
          {syncState.data?.lastSuccessAt ? ` · sincronizado em ${formatDateTime(syncState.data.lastSuccessAt)}` : ''}
        </p>
        <div className="flex flex-wrap gap-2">
          {(list.data?.nested ?? 0) > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowLinked((value) => !value);
                setPage(1);
              }}
            >
              {showLinked ? 'Ocultar atos vinculados' : 'Mostrar atos vinculados'}
            </Button>
          )}
          {can('admin') && (
            <Button size="sm" variant="outline" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
              <RefreshCw /> {syncNow.isPending ? 'Enfileirando…' : 'Sincronizar agora'}
            </Button>
          )}
        </div>
      </div>
      {syncState.data?.lastError && <Alert variant="destructive">Última sincronização: {syncState.data.lastError}</Alert>}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative lg:col-span-2">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por número, título ou ementa"
            className="pl-8"
            aria-label="Buscar no acervo"
          />
        </div>
        <NativeSelect
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          aria-label="Situação da indexação"
        >
          <option value="">Qualquer indexação</option>
          {CATALOG_STATUSES.map((item) => (
            <option key={item} value={item}>
              {CATALOG_STATUS_LABELS[item as CatalogStatus]}
            </option>
          ))}
        </NativeSelect>
      </div>

      {list.isError && <Alert variant="destructive">{errorMessage(list.error)}</Alert>}
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        aria-label="PDF do ato"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const externalId = Number(e.currentTarget.dataset.externalId);
          e.target.value = '';
          const source = e.currentTarget.dataset.source === 'site' ? 'site' : 'legisla';
          if (file && Number.isInteger(externalId) && externalId > 0) uploadPdf.mutate({ externalId, source, file });
        }}
      />

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Documento</th>
              <th className="px-3 py-2 font-medium">Tipo</th>
              <th className="px-3 py-2 font-medium">Publicação</th>
              <th className="px-3 py-2 font-medium">Vigência</th>
              <th className="px-3 py-2 font-medium">Indexação</th>
              <th className="px-3 py-2 font-medium">Ação</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading &&
              [1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-t">
                  <td colSpan={6} className="px-3 py-2">
                    <Skeleton className="h-6" />
                  </td>
                </tr>
              ))}
            {list.data?.items.map((act) => (
              <CatalogEntry key={`${act.origin}-${act.externalId ?? act.documentId}`} act={act} actions={renderActions} />
            ))}
          </tbody>
        </table>
        {list.data?.items.length === 0 && (
          <EmptyState icon={<FileText />} title="Nenhum ato encontrado" className="m-4">
            {q || status ? 'Ajuste a busca ou o filtro.' : 'O acervo ainda não foi carregado.'}
          </EmptyState>
        )}
      </div>

      <ConfirmDialog
        open={detachTarget !== null}
        onOpenChange={(open) => !open && setDetachTarget(null)}
        title="Desanexar documento?"
        description={detachTarget ? `${detachTarget.title} sai do chat. O ato permanece na lista do site e só pode ser indexado de novo se estiver em vigor.` : ''}
        confirmLabel="Desanexar"
        pending={detach.isPending}
        onConfirm={() => detachTarget && detach.mutate(detachTarget.id)}
      />

      {list.data && list.data.total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            Página {page} de {totalPages}
          </span>
          <Button variant="outline" size="icon-sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1} aria-label="Página anterior">
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages} aria-label="Próxima página">
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}
