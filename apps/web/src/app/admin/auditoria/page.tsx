'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Input, Skeleton } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

interface AuditEntry {
  id: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  correlationId: string | null;
  createdAt: string;
}

export default function AuditPage() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api<{ items: AuditEntry[] }>('/audit?limit=500') });
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const items = (q.data?.items ?? []).filter((e) => !f || `${e.actorId} ${e.action} ${e.entityType} ${e.entityId ?? ''}`.toLowerCase().includes(f));
  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Trilha de auditoria</h1>
          <p className="text-sm text-muted-foreground">Envios, alterações, exclusões, downloads e mudanças de configuração (últimos 500 registros).</p>
        </div>
        <Input className="max-w-xs" placeholder="Filtrar por usuário, ação ou entidade" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar auditoria" />
      </div>
      {q.isError && <Alert variant="destructive">{errorMessage(q.error)}</Alert>}
      {q.isLoading && <Skeleton className="h-64" />}
      {q.data && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Data</th>
                <th className="px-3 py-2 font-medium">Usuário</th>
                <th className="px-3 py-2 font-medium">Ação</th>
                <th className="px-3 py-2 font-medium">Entidade</th>
                <th className="px-3 py-2 font-medium">Detalhes</th>
                <th className="px-3 py-2 font-medium">Correlação</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className="border-t align-top">
                  <td className="px-3 py-1.5 text-xs whitespace-nowrap">{formatDateTime(e.createdAt)}</td>
                  <td className="px-3 py-1.5 text-xs">
                    {e.actorId}
                    {e.ip && <span className="block text-muted-foreground">{e.ip}</span>}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">{e.action}</td>
                  <td className="px-3 py-1.5 text-xs">
                    {e.entityType}
                    {e.entityId && <span className="block font-mono text-[10px] text-muted-foreground">{e.entityId}</span>}
                  </td>
                  <td className="max-w-sm px-3 py-1.5 font-mono text-[11px] break-all text-muted-foreground">{Object.keys(e.details).length ? JSON.stringify(e.details) : '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground">{e.correlationId?.slice(0, 8) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">Nenhum registro.</p>}
        </div>
      )}
    </div>
  );
}
