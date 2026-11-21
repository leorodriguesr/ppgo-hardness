'use client';

import {
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  PROCESSING_STATUS_LABELS,
  PROCESSING_STATUSES,
  VALIDITY_STATUS_LABELS,
  VALIDITY_STATUSES,
  type DocumentDto,
  type Paginated,
} from '@rag/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileText, Search, Upload } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { AccessBadge, isProcessing, ProcessingStatus, ValidityBadge } from '@/components/documents/badges';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Input, NativeSelect, Skeleton } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { formatDate, formatDateTime } from '@/lib/utils';

const PAGE_SIZE = 20;

export default function DocumentsPage() {
  const { can } = useMe();
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [filters, setFilters] = useState({ documentType: '', validityStatus: '', status: '', active: '' });
  const [page, setPage] = useState(1);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort: 'updated_desc' });
  if (q) params.set('q', q);
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);

  const list = useQuery({
    queryKey: ['documents', params.toString()],
    queryFn: () => api<Paginated<DocumentDto>>(`/documents?${params}`),
    placeholderData: keepPreviousData,
    // Acompanha o processamento enquanto houver documentos em andamento
    refetchInterval: (query) => (query.state.data?.items.some((d) => isProcessing(d.currentVersion)) ? 2500 : false),
  });

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Biblioteca de documentos</h1>
          <p className="text-sm text-muted-foreground">{list.data ? `${list.data.total} documento(s)` : 'Documentos disponíveis para consulta'}</p>
        </div>
        {can('admin') && (
          <Button asChild>
            <Link href="/documentos/enviar">
              <Upload /> Enviar documentos
            </Link>
          </Button>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <div className="relative lg:col-span-2">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por título, número ou órgão"
            className="pl-8"
            aria-label="Buscar documentos"
          />
        </div>
        <NativeSelect value={filters.documentType} onChange={(e) => setFilter('documentType', e.target.value)} aria-label="Tipo de documento">
          <option value="">Todos os tipos</option>
          {DOCUMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {DOCUMENT_TYPE_LABELS[t]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={filters.validityStatus} onChange={(e) => setFilter('validityStatus', e.target.value)} aria-label="Situação de vigência">
          <option value="">Qualquer vigência</option>
          {VALIDITY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {VALIDITY_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={filters.status} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status de processamento">
          <option value="">Qualquer status</option>
          {PROCESSING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PROCESSING_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </div>

      {list.isError && <Alert variant="destructive">{errorMessage(list.error)}</Alert>}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Documento</th>
              <th className="px-3 py-2 font-medium">Tipo</th>
              <th className="px-3 py-2 font-medium">Publicação</th>
              <th className="px-3 py-2 font-medium">Vigência</th>
              <th className="px-3 py-2 font-medium">Acesso</th>
              <th className="px-3 py-2 font-medium">Processamento</th>
              <th className="px-3 py-2 font-medium">Atualizado</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading &&
              [1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-t">
                  <td colSpan={7} className="px-3 py-2">
                    <Skeleton className="h-6" />
                  </td>
                </tr>
              ))}
            {list.data?.items.map((d) => (
              <tr key={d.id} className="border-t hover:bg-muted/40" data-testid="document-row">
                <td className="max-w-md px-3 py-2">
                  <Link href={`/documentos/${d.id}`} className="font-medium hover:underline">
                    {d.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {d.documentNumber ?? 'Sem número'} {d.currentVersion && `· ${d.currentVersion.format.toUpperCase()} · v${d.currentVersion.versionNumber}`}
                    {!d.isActive && ' · desativado'}
                  </p>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{DOCUMENT_TYPE_LABELS[d.documentType]}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(d.publicationDate)}</td>
                <td className="px-3 py-2">
                  <ValidityBadge status={d.validityStatus} />
                </td>
                <td className="px-3 py-2">
                  <AccessBadge level={d.accessLevel} />
                </td>
                <td className="px-3 py-2">
                  <ProcessingStatus version={d.currentVersion} compact />
                </td>
                <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.items.length === 0 && (
          <EmptyState icon={<FileText />} title="Nenhum documento encontrado" className="m-4">
            {q || Object.values(filters).some(Boolean) ? 'Ajuste a busca ou os filtros.' : 'Envie documentos para que possam ser consultados.'}
          </EmptyState>
        )}
      </div>

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
