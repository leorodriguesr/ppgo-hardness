'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Play } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input, Label, NativeSelect, Skeleton, Textarea } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { cn, formatDateTime, formatMs } from '@/lib/utils';

interface Run {
  id: string;
  datasetName: string;
  split: string;
  experimentName: string;
  config: { mode?: string; overrides?: Record<string, unknown>; promptVersion?: string; groundingCheckVersion?: string; judgeModel?: string };
  status: string;
  metrics: Record<string, number | null>;
  scores: Record<string, number>;
  notes: string | null;
  startedAt: string;
  finishedAt: string | null;
}
interface CaseResult {
  id: string;
  externalId: string;
  category: string;
  question: string;
  expectedBehavior: string;
  referenceAnswer: string | null;
  answer: string | null;
  answerType: string | null;
  metrics: Record<string, unknown>;
  judge: { fidelidade?: number; relevancia?: number; justificativa?: string; afirmacoes_sem_suporte?: string[] } | null;
  humanReview: { faithfulness: number; relevance: number; citations: number; comment?: string; reviewer?: string } | null;
  latencyMs: number | null;
  error: string | null;
}

const DIMENSIONS = ['recuperacao', 'fidelidade', 'relevancia', 'citacoes', 'robustez'] as const;
const DIM_LABELS: Record<string, string> = { recuperacao: 'Recuperação', fidelidade: 'Fidelidade', relevancia: 'Relevância', citacoes: 'Citações', robustez: 'Robustez' };
const METRICS: [string, string, 'pct' | 'num' | 'ms' | 'int'][] = [
  ['recallAt1', 'Recall@1', 'pct'],
  ['recallAtK', 'Recall@K', 'pct'],
  ['mrr', 'MRR', 'num'],
  ['ndcgAtK', 'nDCG@K', 'num'],
  ['precisionAtK', 'Precision@K', 'pct'],
  ['groundingScore', 'Fundamentação', 'pct'],
  ['factCoverage', 'Cobertura de fatos', 'pct'],
  ['citationSupport', 'Citações sustentadas', 'pct'],
  ['behaviorPassRate', 'Comportamento correto', 'pct'],
  ['judgeFaithfulness', 'Juiz: fidelidade', 'num'],
  ['severeHallucinations', 'Alucinações graves', 'int'],
  ['securityViolations', 'Violações de segurança', 'int'],
  ['latencyP50Ms', 'Latência p50', 'ms'],
  ['latencyP95Ms', 'Latência p95', 'ms'],
];

const fmt = (v: number | null | undefined, kind: 'pct' | 'num' | 'ms' | 'int') =>
  v === null || v === undefined ? '—' : kind === 'pct' ? `${(v * 100).toFixed(1)}%` : kind === 'ms' ? formatMs(v) : kind === 'int' ? String(v) : v.toFixed(3);

const fmtDelta = (d: number, kind: 'pct' | 'num' | 'ms' | 'int') => {
  const sign = d > 0 ? '+' : '−';
  const abs = Math.abs(d);
  return kind === 'pct' ? `${sign}${(abs * 100).toFixed(1)} p.p.` : `${sign}${fmt(abs, kind)}`;
};

function ScoreBadge({ v }: { v: number | undefined }) {
  if (v === undefined) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={v >= 5 ? 'success' : v >= 4 ? 'default' : v >= 3 ? 'warning' : 'destructive'}>{v}/5</Badge>;
}

function NewRunDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const datasets = useQuery({ queryKey: ['eval-datasets'], queryFn: () => api<{ items: { id: string; name: string; split: string; cases: number }[] }>('/evaluations/datasets'), enabled: open });
  const [datasetId, setDatasetId] = useState('');
  const [name, setName] = useState('');
  const [overrides, setOverrides] = useState('{\n  "mode": "full"\n}');
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: (body: unknown) => api<{ runId: string }>('/evaluations/runs', { method: 'POST', json: body }),
    onSuccess: () => {
      toast.success('Avaliação enfileirada. O worker executará os casos em segundo plano.');
      onOpenChange(false);
      void qc.invalidateQueries({ queryKey: ['eval-runs'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Nova avaliação" description="Executa o conjunto de casos com as configurações atuais, sobrescrevendo apenas o que for informado.">
        <div className="space-y-3">
          <div>
            <Label htmlFor="ds" className="mb-1.5 block">
              Conjunto de casos
            </Label>
            <NativeSelect id="ds" value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
              <option value="">Selecione…</option>
              {datasets.data?.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.split}, {d.cases} casos)
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="exp" className="mb-1.5 block">
              Nome do experimento
            </Label>
            <Input id="exp" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: topk-8-sem-rerank" maxLength={200} />
          </div>
          <div>
            <Label htmlFor="ov" className="mb-1.5 block">
              Sobrescritas (JSON)
            </Label>
            <Textarea id="ov" rows={6} className="font-mono text-xs" value={overrides} onChange={(e) => setOverrides(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">Ex.: {'{"rerank": {"enabled": false}, "retrieval": {"finalTopK": 8}}'}. Use &quot;mode&quot;: &quot;retrieval&quot; para medir só a recuperação.</p>
          </div>
          {error && <Alert variant="destructive">{error}</Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!datasetId || !name.trim() || start.isPending}
            onClick={() => {
              let parsed: Record<string, unknown>;
              try {
                parsed = overrides.trim() ? (JSON.parse(overrides) as Record<string, unknown>) : {};
              } catch {
                setError('JSON de sobrescritas inválido.');
                return;
              }
              setError(null);
              start.mutate({ datasetId, experimentName: name.trim(), overrides: parsed });
            }}
          >
            <Play /> Iniciar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HumanReview({ result, onSaved }: { result: CaseResult; onSaved: () => void }) {
  const [v, setV] = useState({ faithfulness: result.humanReview?.faithfulness ?? 3, relevance: result.humanReview?.relevance ?? 3, citations: result.humanReview?.citations ?? 3, comment: result.humanReview?.comment ?? '' });
  const save = useMutation({
    mutationFn: () => api(`/evaluations/results/${result.id}/review`, { method: 'PUT', json: { ...v, comment: v.comment.trim() || undefined } }),
    onSuccess: () => {
      toast.success('Avaliação humana registrada.');
      onSaved();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md bg-muted/50 p-2 text-xs">
      {(['faithfulness', 'relevance', 'citations'] as const).map((k) => (
        <label key={k} className="flex flex-col gap-1">
          {k === 'faithfulness' ? 'Fidelidade' : k === 'relevance' ? 'Relevância' : 'Citações'}
          <NativeSelect className="h-8 w-16" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </NativeSelect>
        </label>
      ))}
      <Input className="h-8 min-w-48 flex-1" placeholder="Comentário" value={v.comment} onChange={(e) => setV({ ...v, comment: e.target.value })} maxLength={2000} />
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        Salvar revisão
      </Button>
    </div>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const { can } = useMe();
  const q = useQuery({ queryKey: ['eval-run', runId], queryFn: () => api<{ run: Run; results: CaseResult[] }>(`/evaluations/runs/${runId}`) });
  const [onlyFailures, setOnlyFailures] = useState(true);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) return <Alert variant="destructive">{errorMessage(q.error)}</Alert>;
  const results = q.data!.results.filter((r) => !onlyFailures || r.error || r.metrics.behaviorPass === false || (r.metrics.recallAtK as number | undefined) === 0 || (r.judge?.fidelidade ?? 5) <= 3);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>Casos — {q.data!.run.experimentName}</CardTitle>
          <CardDescription>{q.data!.results.length} casos avaliados</CardDescription>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={onlyFailures} onChange={(e) => setOnlyFailures(e.target.checked)} /> Somente falhas
        </label>
      </CardHeader>
      <CardContent className="space-y-2">
        {results.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">Nenhum caso com falha.</p>}
        {results.map((r) => (
          <details key={r.id} className="rounded-md border p-2 text-sm">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <Badge variant="outline">{r.externalId}</Badge>
              <Badge variant="secondary">{r.category}</Badge>
              <span className="min-w-0 flex-1 truncate">{r.question}</span>
              {r.error ? <Badge variant="destructive">erro</Badge> : r.metrics.behaviorPass === false ? <Badge variant="warning">comportamento</Badge> : null}
              {r.humanReview && <Badge variant="default">revisado</Badge>}
            </summary>
            <div className="mt-2 grid gap-2 text-xs md:grid-cols-2">
              <div>
                <p className="font-medium">Esperado ({r.expectedBehavior})</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{r.referenceAnswer ?? '—'}</p>
              </div>
              <div>
                <p className="font-medium">Resposta ({r.answerType ?? '—'}) · {formatMs(r.latencyMs)}</p>
                <p className="whitespace-pre-wrap">{r.error ?? r.answer ?? '—'}</p>
              </div>
              <div className="md:col-span-2">
                <p className="font-medium">Métricas</p>
                <p className="font-mono text-[11px] break-all text-muted-foreground">
                  {['recallAtK', 'mrr', 'factCoverage', 'groundingScore', 'citations', 'validCitations', 'supportedCitations']
                    .filter((k) => r.metrics[k] !== undefined)
                    .map((k) => `${k}=${typeof r.metrics[k] === 'number' ? Number(r.metrics[k]).toFixed(2) : String(r.metrics[k])}`)
                    .join('  ')}
                </p>
                {r.judge && (
                  <p className="mt-1">
                    Juiz: fidelidade {r.judge.fidelidade}/5, relevância {r.judge.relevancia}/5 — <span className="text-muted-foreground">{r.judge.justificativa}</span>
                  </p>
                )}
              </div>
            </div>
            {can('analyst') && <HumanReview result={r} onSaved={() => void q.refetch()} />}
          </details>
        ))}
      </CardContent>
    </Card>
  );
}

export default function EvaluationsPage() {
  const { can } = useMe();
  const runs = useQuery({ queryKey: ['eval-runs'], queryFn: () => api<{ items: Run[] }>('/evaluations/runs'), refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'running') ? 10_000 : false) });
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const items = runs.data?.items ?? [];
  const compared = items.filter((r) => selected.includes(r.id));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-4)));

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Avaliações de qualidade</h1>
          <p className="text-sm text-muted-foreground">Notas de 1 a 5 derivadas de limiares explícitos sobre métricas medidas. Selecione até 4 execuções para comparar.</p>
        </div>
        {can('admin') && (
          <Button onClick={() => setNewOpen(true)}>
            <FlaskConical /> Nova avaliação
          </Button>
        )}
      </div>
      {runs.isError && <Alert variant="destructive">{errorMessage(runs.error)}</Alert>}
      {runs.isLoading && <Skeleton className="h-48" />}
      {!runs.isLoading && items.length === 0 && <EmptyState icon={<FlaskConical />} title="Nenhuma avaliação executada." />}

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="px-3 py-2 font-medium">Experimento</th>
                <th className="px-3 py-2 font-medium">Conjunto</th>
                {DIMENSIONS.map((d) => (
                  <th key={d} className="px-2 py-2 font-medium">
                    {DIM_LABELS[d]}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">p95</th>
                <th className="px-3 py-2 font-medium">Data</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className={cn('border-t hover:bg-muted/40', detail === r.id && 'bg-accent/50')}>
                  <td className="px-2 py-2">
                    <input type="checkbox" className="size-4 accent-primary" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} aria-label={`Comparar ${r.experimentName}`} />
                  </td>
                  <td className="px-3 py-2">
                    <button className="text-left font-medium hover:underline" onClick={() => setDetail(r.id === detail ? null : r.id)}>
                      {r.experimentName}
                    </button>
                    <p className="text-xs text-muted-foreground">
                      {r.config.mode ?? 'full'}
                      {r.config.promptVersion ? ` · ${r.config.promptVersion}` : ''}
                      {r.config.mode !== 'retrieval' ? ` · grounding ${r.config.groundingCheckVersion ?? 'lexical-v1'}` : ''}
                      {r.config.overrides && Object.keys(r.config.overrides).length ? ` · ${JSON.stringify(r.config.overrides)}` : ''}
                    </p>
                    {r.status !== 'completed' && <Badge variant={r.status === 'failed' ? 'destructive' : 'secondary'}>{r.status}</Badge>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.datasetName}
                    <br />
                    <span className="text-muted-foreground">{r.split}</span>
                  </td>
                  {DIMENSIONS.map((d) => (
                    <td key={d} className="px-2 py-2">
                      <ScoreBadge v={r.scores?.[d]} />
                    </td>
                  ))}
                  <td className="px-3 py-2 text-xs tabular-nums">{formatMs(r.metrics?.latencyP95Ms)}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(r.finishedAt ?? r.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {compared.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Comparação de métricas</CardTitle>
            <CardDescription>A primeira coluna é a referência; as demais mostram a diferença em relação a ela.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Métrica</th>
                  {compared.map((r) => (
                    <th key={r.id} className="py-1 pr-3 font-medium">
                      {r.experimentName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {METRICS.map(([k, label, kind]) => {
                  const base = compared[0]!.metrics?.[k];
                  return (
                    <tr key={k} className="border-t">
                      <td className="py-1 pr-3">{label}</td>
                      {compared.map((r, i) => {
                        const v = r.metrics?.[k];
                        const delta = i > 0 && typeof v === 'number' && typeof base === 'number' ? v - base : null;
                        return (
                          <td key={r.id} className="py-1 pr-3 tabular-nums">
                            {fmt(v, kind)}
                            {delta !== null && delta !== 0 && (
                              <span className="ml-1 text-muted-foreground">({fmtDelta(delta, kind)})</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {detail && <RunDetail runId={detail} />}
      <NewRunDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
