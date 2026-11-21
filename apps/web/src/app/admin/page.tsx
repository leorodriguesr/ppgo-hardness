'use client';

import type { DashboardDto } from '@rag/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ProcessingStatus } from '@/components/documents/badges';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime, formatMs, formatPct } from '@/lib/utils';

type Check = { ok: boolean; latencyMs: number; detail?: string };
type JobCounts = Record<string, number>;
interface QueryPoint {
  bucket: string;
  queries: number;
  total_ms: number | null;
  p95_ms: number | null;
  retrieval_ms: number | null;
  rerank_ms: number | null;
  generation_ms: number | null;
  no_evidence_rate: number | null;
  errors: number;
}
interface Retrieval {
  id: string;
  correlationId: string | null;
  answerType: string | null;
  noEvidence: boolean;
  timings: Record<string, number>;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
  createdAt: string;
}

const CHECK_LABELS: Record<string, string> = { database: 'Banco de dados', redis: 'Fila (Redis)', storage: 'Armazenamento', worker: 'Worker', llm: 'Modelos de IA', ocr: 'OCR' };

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </CardHeader>
      {hint && <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}

/** Barras horárias simples (sem dependência de biblioteca de gráficos). */
function Bars({ points, value, format, label }: { points: QueryPoint[]; value: (p: QueryPoint) => number | null; format: (v: number) => string; label: string }) {
  const values = points.map((p) => value(p) ?? 0);
  const max = Math.max(1, ...values);
  if (!points.length) return <p className="py-6 text-center text-xs text-muted-foreground">Sem dados no período.</p>;
  return (
    <div>
      <div className="flex h-28 items-end gap-px" role="img" aria-label={label}>
        {points.map((p, i) => (
          <div key={p.bucket} className="flex-1 rounded-t bg-primary/70 hover:bg-primary" style={{ height: `${Math.max(2, (values[i]! / max) * 100)}%` }} title={`${formatDateTime(p.bucket)} — ${format(values[i]!)}`} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{formatDateTime(points[0]!.bucket)}</span>
        <span>máx. {format(max)}</span>
        <span>{formatDateTime(points[points.length - 1]!.bucket)}</span>
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardDto>('/metrics/dashboard'), refetchInterval: 15_000 });
  const health = useQuery({ queryKey: ['system-health'], queryFn: () => api<{ checks: Record<string, Check>; queues: Record<string, JobCounts> }>('/system/health'), refetchInterval: 15_000 });
  const series = useQuery({ queryKey: ['timeseries', 7], queryFn: () => api<{ queries: QueryPoint[] }>('/metrics/timeseries?days=7') });
  const recent = useQuery({ queryKey: ['retrievals'], queryFn: () => api<{ items: Retrieval[] }>('/metrics/retrievals?limit=20'), refetchInterval: 15_000 });
  const d = dash.data;

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">Painel operacional</h1>
        <p className="text-sm text-muted-foreground">Indicadores calculados a partir dos registros reais de processamento e consultas.</p>
      </div>
      {dash.isError && <Alert variant="destructive">{errorMessage(dash.error)}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>Saúde dos serviços</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {health.isLoading && <Skeleton className="h-6 w-80" />}
          {health.data &&
            Object.entries(health.data.checks).map(([k, c]) => (
              <Badge key={k} variant={c.ok ? 'success' : 'destructive'} title={c.detail}>
                {CHECK_LABELS[k] ?? k}: {c.ok ? `ok (${c.latencyMs} ms)` : (c.detail ?? 'falha')}
              </Badge>
            ))}
          {health.data &&
            Object.entries(health.data.queues).map(([name, c]) => (
              <Badge key={name} variant={c.failed ? 'warning' : 'outline'}>
                fila {name}: {c.waiting ?? 0} aguardando · {c.active ?? 0} ativos · {c.failed ?? 0} falhas
              </Badge>
            ))}
        </CardContent>
      </Card>

      {d ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Documentos" value={d.documents.total} hint={`${d.documents.completed} processados · ${d.documents.processing + d.documents.pending} em andamento · ${d.documents.error} com erro · ${d.documents.inactive} desativados`} />
          <Stat label="Trechos indexados" value={d.chunks.toLocaleString('pt-BR')} hint={`${formatBytes(d.storageBytes)} armazenados · processamento médio ${formatMs(d.avgProcessingMs)}`} />
          <Stat label="Consultas (24 h)" value={d.queries.last24h} hint={`${d.queries.total} no total · sem evidência ${formatPct(d.queries.noEvidenceRate)}`} />
          <Stat label="Latência" value={formatMs(d.queries.avgLatencyMs)} hint={`média · p95 ${formatMs(d.queries.p95LatencyMs)}`} />
          <Stat label="Avaliação dos usuários" value={`${d.feedback.positive} / ${d.feedback.negative}`} hint="positivas / negativas" />
          <Stat label="Tokens (24 h)" value={(d.usage.tokensIn24h + d.usage.tokensOut24h).toLocaleString('pt-BR')} hint={`${d.usage.tokensIn24h.toLocaleString('pt-BR')} entrada · ${d.usage.tokensOut24h.toLocaleString('pt-BR')} saída · US$ ${d.usage.estimatedCostUsd24h.toFixed(4)}`} />
          <Card className="col-span-2">
            <CardHeader>
              <CardDescription>Última avaliação de qualidade</CardDescription>
              {d.latestEvaluation ? (
                <Link href="/admin/avaliacoes" className="font-medium hover:underline">
                  {d.latestEvaluation.experimentName}
                </Link>
              ) : (
                <p className="text-sm">Nenhuma avaliação concluída.</p>
              )}
            </CardHeader>
            {d.latestEvaluation && (
              <CardContent className="flex flex-wrap gap-1.5">
                {Object.entries(d.latestEvaluation.scores).map(([k, v]) => (
                  <Badge key={k} variant={v >= 5 ? 'success' : v >= 4 ? 'default' : 'warning'}>
                    {k}: {v}/5
                  </Badge>
                ))}
              </CardContent>
            )}
          </Card>
        </div>
      ) : (
        dash.isLoading && <Skeleton className="h-40" />
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Consultas por hora (7 dias)</CardTitle>
          </CardHeader>
          <CardContent>{series.data && <Bars points={series.data.queries} value={(p) => p.queries} format={(v) => String(Math.round(v))} label="Consultas por hora" />}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Latência p95 por hora</CardTitle>
          </CardHeader>
          <CardContent>{series.data && <Bars points={series.data.queries} value={(p) => p.p95_ms} format={formatMs} label="Latência p95 por hora" />}</CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Consultas recentes</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Quando</th>
                  <th className="py-1 font-medium">Resultado</th>
                  <th className="py-1 font-medium">Busca</th>
                  <th className="py-1 font-medium">Rerank</th>
                  <th className="py-1 font-medium">Geração</th>
                  <th className="py-1 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {recent.data?.items.map((r) => (
                  <tr key={r.id} className="border-t" title={r.correlationId ?? undefined}>
                    <td className="py-1 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                    <td className="py-1">
                      {r.error ? <Badge variant="destructive">{r.error === 'cancelled' ? 'cancelada' : 'erro'}</Badge> : r.noEvidence ? <Badge variant="warning">sem evidência</Badge> : <Badge variant="secondary">{r.answerType ?? '—'}</Badge>}
                    </td>
                    <td className="py-1 tabular-nums">{formatMs(r.timings.retrieval)}</td>
                    <td className="py-1 tabular-nums">{formatMs(r.timings.rerank)}</td>
                    <td className="py-1 tabular-nums">{formatMs(r.timings.generation)}</td>
                    <td className="py-1 tabular-nums">{formatMs(r.timings.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {recent.data?.items.length === 0 && <p className="py-4 text-center text-muted-foreground">Nenhuma consulta registrada.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Documentos recentes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {d?.recentDocuments.map((doc) => (
              <div key={doc.id} className="flex items-center gap-3 text-sm">
                <Link href={`/documentos/${doc.id}`} className="min-w-0 flex-1 truncate hover:underline">
                  {doc.title}
                </Link>
                <ProcessingStatus version={doc.currentVersion} compact />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
