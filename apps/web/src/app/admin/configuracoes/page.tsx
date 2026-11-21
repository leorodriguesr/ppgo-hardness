'use client';

import { CHUNKING_STRATEGIES, FILE_FORMATS, RETRIEVAL_MODES, ragSettingsSchema, type RagSettings } from '@rag/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, NativeSelect, Skeleton } from '@/components/ui/primitives';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';

interface SettingsResponse {
  settings: RagSettings;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  defaults: RagSettings;
  embedding: { provider: string; model: string; dimensions: number };
}

type FieldDef = { key: string; label: string; help?: string } & (
  | { type: 'number'; min?: number; max?: number; step?: number }
  | { type: 'boolean' }
  | { type: 'select'; options: readonly string[] }
  | { type: 'text' }
  | { type: 'formats' }
);

const SECTIONS: { id: keyof RagSettings; title: string; description: string; fields: FieldDef[] }[] = [
  {
    id: 'retrieval',
    title: 'Recuperação',
    description: 'Busca híbrida (vetorial + lexical + referências) combinada por Reciprocal Rank Fusion.',
    fields: [
      { key: 'mode', label: 'Modo', type: 'select', options: RETRIEVAL_MODES },
      { key: 'vectorCandidates', label: 'Candidatos vetoriais', type: 'number', min: 1, max: 500 },
      { key: 'lexicalCandidates', label: 'Candidatos lexicais', type: 'number', min: 1, max: 500 },
      { key: 'rrfK', label: 'Constante k do RRF', type: 'number', min: 1, max: 1000 },
      { key: 'vectorWeight', label: 'Peso vetorial', type: 'number', min: 0, max: 10, step: 0.1 },
      { key: 'lexicalWeight', label: 'Peso lexical', type: 'number', min: 0, max: 10, step: 0.1 },
      { key: 'referenceWeight', label: 'Peso de referências (nº do ato/artigo)', type: 'number', min: 0, max: 10, step: 0.1 },
      { key: 'minVectorSimilarity', label: 'Similaridade mínima', type: 'number', min: -1, max: 1, step: 0.01 },
      { key: 'finalTopK', label: 'Trechos no contexto (top-K)', type: 'number', min: 1, max: 50 },
      { key: 'maxContextTokens', label: 'Orçamento de tokens do contexto', type: 'number', min: 256, max: 64000 },
      { key: 'maxChunksPerDocument', label: 'Máx. trechos por documento', type: 'number', min: 1, max: 50 },
      { key: 'expandNeighbors', label: 'Incluir trechos vizinhos', type: 'boolean' },
    ],
  },
  {
    id: 'rerank',
    title: 'Reranking',
    description: 'Reordena os candidatos com um modelo; se falhar, mantém a ordem da fusão.',
    fields: [
      { key: 'enabled', label: 'Ativado', type: 'boolean' },
      { key: 'model', label: 'Modelo', type: 'text' },
      { key: 'candidates', label: 'Candidatos reavaliados', type: 'number', min: 2, max: 100 },
      { key: 'minScore', label: 'Escore mínimo (0–1)', type: 'number', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: 'generation',
    title: 'Geração',
    description: 'Modelo que redige a resposta a partir dos trechos recuperados.',
    fields: [
      { key: 'chatModel', label: 'Modelo', type: 'text' },
      { key: 'temperature', label: 'Temperatura', type: 'number', min: 0, max: 1.5, step: 0.05 },
      { key: 'maxOutputTokens', label: 'Máx. tokens de saída', type: 'number', min: 64, max: 8192 },
    ],
  },
  {
    id: 'grounding',
    title: 'Fundamentação',
    description: 'Limiares de evidência e verificação das citações.',
    fields: [
      { key: 'enabled', label: 'Verificar fundamentação', type: 'boolean' },
      { key: 'useLlmVerifier', label: 'Usar modelo como verificador', type: 'boolean' },
      { key: 'minSupportScore', label: 'Suporte mínimo por afirmação', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'minEvidenceScore', label: 'Evidência mínima para responder', type: 'number', min: 0, max: 1, step: 0.01, help: 'Abaixo disso, o assistente informa que não encontrou base documental.' },
    ],
  },
  {
    id: 'rewrite',
    title: 'Reescrita de perguntas',
    description: 'Resolve referências a mensagens anteriores ("e nesse caso?") sem introduzir fatos novos.',
    fields: [
      { key: 'enabled', label: 'Ativada', type: 'boolean' },
      { key: 'model', label: 'Modelo', type: 'text' },
      { key: 'historyMessages', label: 'Mensagens de histórico', type: 'number', min: 0, max: 50 },
      { key: 'historyTokenBudget', label: 'Orçamento de tokens do histórico', type: 'number', min: 0, max: 16000 },
    ],
  },
  {
    id: 'chunking',
    title: 'Chunking',
    description: 'Aplica-se a documentos processados ou reprocessados após a alteração.',
    fields: [
      { key: 'strategy', label: 'Estratégia', type: 'select', options: CHUNKING_STRATEGIES },
      { key: 'maxTokens', label: 'Tamanho máximo (tokens)', type: 'number', min: 64, max: 4000 },
      { key: 'minTokens', label: 'Tamanho mínimo (tokens)', type: 'number', min: 1, max: 1000 },
      { key: 'overlapTokens', label: 'Sobreposição (tokens)', type: 'number', min: 0, max: 1000 },
    ],
  },
  {
    id: 'processing',
    title: 'Processamento e OCR',
    description: 'Detecção de páginas digitalizadas e qualidade mínima do OCR.',
    fields: [
      { key: 'ocrEnabled', label: 'OCR ativado', type: 'boolean' },
      { key: 'ocrMinCharsPerPage', label: 'Caracteres mínimos por página', type: 'number', min: 0, max: 5000 },
      { key: 'ocrMinConfidence', label: 'Confiança mínima do OCR (0–100)', type: 'number', min: 0, max: 100 },
    ],
  },
  {
    id: 'upload',
    title: 'Upload',
    description: 'Limites aplicados na validação de arquivos enviados.',
    fields: [
      { key: 'maxBytes', label: 'Tamanho máximo (bytes)', type: 'number', min: 1024, max: 500 * 1024 * 1024 },
      { key: 'allowedFormats', label: 'Formatos aceitos', type: 'formats' },
    ],
  },
];

export default function SettingsPage() {
  const qc = useQueryClient();
  const { can } = useMe();
  const readOnly = !can('admin');
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResponse>('/settings') });
  const [draft, setDraft] = useState<RagSettings | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    if (q.data) setDraft(structuredClone(q.data.settings));
  }, [q.data]);

  const save = useMutation({
    mutationFn: (s: RagSettings) => api<{ version: number }>('/settings', { method: 'PUT', json: { settings: s, expectedVersion: q.data!.version } }),
    onSuccess: () => {
      toast.success('Configurações salvas. Novas consultas já utilizam os valores atualizados.');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) toast.error('As configurações foram alteradas por outra pessoa. Recarregue antes de salvar.');
      else toast.error(errorMessage(e));
    },
  });

  if (q.isLoading || !draft) return <div className="p-6">{q.isError ? <Alert variant="destructive">{errorMessage(q.error)}</Alert> : <Skeleton className="h-96" />}</div>;

  const set = (section: keyof RagSettings, key: string, value: unknown) =>
    setDraft((d) => (d ? ({ ...d, [section]: { ...(d[section] as Record<string, unknown>), [key]: value } } as RagSettings) : d));
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data!.settings);

  const submit = () => {
    const parsed = ragSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      return;
    }
    setErrors([]);
    save.mutate(parsed.data);
  };

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Configurações do RAG</h1>
          <p className="text-sm text-muted-foreground">
            Versão {q.data!.version}
            {q.data!.updatedBy ? ` · alterada por ${q.data!.updatedBy}` : ''} · embeddings: {q.data!.embedding.provider}/{q.data!.embedding.model} ({q.data!.embedding.dimensions} dim.)
          </p>
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDraft(structuredClone(q.data!.defaults))}>
              <RotateCcw /> Valores padrão
            </Button>
            <Button onClick={submit} disabled={!dirty || save.isPending}>
              <Save /> Salvar
            </Button>
          </div>
        )}
      </div>
      {readOnly && <Alert>Visualização somente leitura: apenas administradores podem alterar configurações.</Alert>}
      <Alert variant="warning">A troca do modelo de embeddings não é feita aqui: exige migração completa dos vetores para nunca misturar modelos diferentes.</Alert>
      {errors.length > 0 && (
        <Alert variant="destructive">
          <ul className="list-disc pl-4">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      {SECTIONS.map((s) => (
        <Card key={s.id}>
          <CardHeader>
            <CardTitle>{s.title}</CardTitle>
            <CardDescription>{s.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {s.fields.map((f) => {
                const id = `${s.id}-${f.key}`;
                const value = (draft[s.id] as Record<string, unknown>)[f.key];
                return (
                  <div key={f.key} className={f.type === 'formats' ? 'sm:col-span-2' : undefined}>
                    {f.type === 'boolean' ? (
                      <label htmlFor={id} className="flex h-full items-center gap-2 pt-5 text-sm">
                        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => set(s.id, f.key, e.target.checked)} className="size-4 accent-primary" />
                        {f.label}
                      </label>
                    ) : (
                      <>
                        <Label htmlFor={id} className="mb-1.5 block">
                          {f.label}
                        </Label>
                        {f.type === 'number' && (
                          <Input id={id} type="number" min={f.min} max={f.max} step={f.step ?? 1} value={String(value)} onChange={(e) => set(s.id, f.key, e.target.value === '' ? '' : Number(e.target.value))} />
                        )}
                        {f.type === 'text' && <Input id={id} value={String(value)} onChange={(e) => set(s.id, f.key, e.target.value)} />}
                        {f.type === 'select' && (
                          <NativeSelect id={id} value={String(value)} onChange={(e) => set(s.id, f.key, e.target.value)}>
                            {f.options.map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                          </NativeSelect>
                        )}
                        {f.type === 'formats' && (
                          <div className="flex gap-3">
                            {FILE_FORMATS.map((fmt) => {
                              const list = value as string[];
                              return (
                                <label key={fmt} className="flex items-center gap-1.5 text-sm">
                                  <input type="checkbox" className="size-4 accent-primary" checked={list.includes(fmt)} onChange={(e) => set(s.id, f.key, e.target.checked ? [...list, fmt] : list.filter((x) => x !== fmt))} />
                                  {fmt.toUpperCase()}
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                    {f.help && <p className="mt-1 text-xs text-muted-foreground">{f.help}</p>}
                  </div>
                );
              })}
            </fieldset>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
