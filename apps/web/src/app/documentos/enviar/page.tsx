'use client';

import type { DocumentDto, UploadResultDto } from '@rag/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FileUp, Loader2, Trash2, Upload, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ProcessingStatus } from '@/components/documents/badges';
import { MetadataFields, toMetadataPayload, type MetadataFormValues } from '@/components/documents/metadata-fields';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Progress } from '@/components/ui/primitives';
import { api, errorMessage, uploadWithProgress } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { cn, formatBytes } from '@/lib/utils';

const EXT = ['pdf', 'docx', 'txt', 'md'] as const;
const FALLBACK_MAX = 50 * 1024 * 1024;

type ItemState =
  | { phase: 'ready' }
  | { phase: 'uploading'; ratio: number }
  | { phase: 'accepted'; documentId: string }
  | { phase: 'duplicate'; documentId?: string; reason?: string }
  | { phase: 'failed'; error: string };

interface Item {
  key: string;
  file: File;
  title: string;
  documentNumber: string;
  clientError: string | null;
  state: ItemState;
}

const titleFromName = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

/** Acompanha o processamento real de um documento recém-enviado. */
function LiveStatus({ documentId }: { documentId: string }) {
  const q = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api<DocumentDto & { versions: DocumentDto['currentVersion'][] }>(`/documents/${documentId}`),
    refetchInterval: (query) => {
      const v = query.state.data?.versions?.[0];
      return v && (v.status === 'completed' || v.status === 'error') ? false : 1500;
    },
  });
  const v = q.data?.versions?.[0] ?? null;
  return (
    <div className="flex items-center gap-3">
      <ProcessingStatus version={v} compact />
      {v?.status === 'error' && <span className="text-xs text-destructive">{v.errorMessage}</span>}
      {v?.status === 'completed' && <span className="text-xs text-muted-foreground">{v.chunkCount} trechos indexados</span>}
      <Link href={`/documentos/${documentId}`} className="text-xs text-primary hover:underline">
        detalhes
      </Link>
    </div>
  );
}

export default function UploadPage() {
  const qc = useQueryClient();
  const { can } = useMe();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: { upload: { maxBytes: number; allowedFormats: string[] } } }>('/settings'),
    enabled: can('analyst'),
  });
  const maxBytes = settings.data?.settings.upload.maxBytes ?? FALLBACK_MAX;
  const allowed = settings.data?.settings.upload.allowedFormats ?? [...EXT];
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { register, formState, getValues } = useForm<MetadataFormValues>({
    defaultValues: { documentType: 'portaria', categoryId: '', issuingBody: '', publicationDate: '', effectiveDate: '', validityStatus: 'vigente', accessLevel: 'interno', description: '' },
  });

  const validate = (f: File): string | null => {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!allowed.includes(ext)) return `Formato .${ext} não aceito (aceitos: ${allowed.join(', ').toUpperCase()}).`;
    if (f.size === 0) return 'Arquivo vazio.';
    if (f.size > maxBytes) return `Excede o limite de ${formatBytes(maxBytes)}.`;
    return null;
  };

  const addFiles = (files: FileList | File[]) => {
    const list = [...files];
    setItems((prev) => {
      const seen = new Set(prev.map((i) => `${i.file.name}:${i.file.size}`));
      const added = list
        .filter((f) => !seen.has(`${f.name}:${f.size}`))
        .map((f) => ({ key: crypto.randomUUID(), file: f, title: titleFromName(f.name), documentNumber: '', clientError: validate(f), state: { phase: 'ready' } as ItemState }));
      return [...prev, ...added];
    });
  };

  const update = (key: string, patch: Partial<Item>) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const sendAll = async () => {
    const queue = items.filter((i) => !i.clientError && (i.state.phase === 'ready' || i.state.phase === 'failed'));
    if (!queue.length) return;
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const shared = toMetadataPayload(getValues());
    // Dois envios simultâneos: aproveita a banda sem sobrecarregar a API
    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item || controller.signal.aborted) return;
        update(item.key, { state: { phase: 'uploading', ratio: 0 } });
        const form = new FormData();
        form.append('metadata', JSON.stringify({ ...shared, title: item.title.trim() || titleFromName(item.file.name), documentNumber: item.documentNumber.trim() || null }));
        form.append('file', item.file);
        try {
          const res = await uploadWithProgress<UploadResultDto>('/documents', form, (ratio) => update(item.key, { state: { phase: 'uploading', ratio } }), controller.signal);
          update(item.key, {
            state: res.status === 'accepted' && res.documentId ? { phase: 'accepted', documentId: res.documentId } : { phase: 'duplicate', documentId: res.duplicateOfDocumentId, reason: res.reason },
          });
        } catch (err) {
          update(item.key, { state: { phase: 'failed', error: errorMessage(err) } });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    abortRef.current = null;
    setRunning(false);
    void qc.invalidateQueries({ queryKey: ['documents'] });
  };

  const pending = items.filter((i) => !i.clientError && (i.state.phase === 'ready' || i.state.phase === 'failed')).length;

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div>
        <Link href="/documentos" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Biblioteca
        </Link>
        <h1 className="mt-1 text-xl font-semibold">Enviar documentos</h1>
        <p className="text-sm text-muted-foreground">PDF, DOCX, TXT ou MD até {formatBytes(maxBytes)} cada. O conteúdo é validado pela assinatura do arquivo; macros e scripts nunca são executados.</p>
      </div>

      {!can('admin') && <Alert variant="warning">Somente administradores podem enviar documentos.</Alert>}

      <div
        role="button"
        tabIndex={0}
        aria-label="Selecionar arquivos ou arrastar e soltar"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors hover:bg-muted/40', dragging && 'border-primary bg-primary/5')}
      >
        <FileUp className="size-8 text-muted-foreground" />
        <p className="font-medium">Arraste arquivos aqui ou clique para selecionar</p>
        <p className="text-xs text-muted-foreground">É possível enviar vários arquivos de uma vez.</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={allowed.map((e) => `.${e}`).join(',')}
          className="hidden"
          data-testid="file-input"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Arquivos ({items.length})</CardTitle>
            <CardDescription>Revise o título e o número de cada documento antes de enviar.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {items.map((i) => (
              <div key={i.key} className="rounded-md border p-2.5" data-testid="upload-item">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={i.file.name}>
                      {i.file.name}
                    </p>
                    <p className="text-xs text-muted-foreground">{formatBytes(i.file.size)}</p>
                  </div>
                  {i.state.phase === 'ready' && !running && (
                    <Button variant="ghost" size="icon-sm" aria-label={`Remover ${i.file.name}`} onClick={() => setItems((p) => p.filter((x) => x.key !== i.key))}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
                {i.clientError && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="size-3.5" /> {i.clientError}
                  </p>
                )}
                {!i.clientError && (i.state.phase === 'ready' || i.state.phase === 'failed') && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Input value={i.title} onChange={(e) => update(i.key, { title: e.target.value })} placeholder="Título" aria-label={`Título de ${i.file.name}`} maxLength={500} />
                    <Input value={i.documentNumber} onChange={(e) => update(i.key, { documentNumber: e.target.value })} placeholder="Número do ato (opcional)" aria-label={`Número de ${i.file.name}`} maxLength={120} />
                  </div>
                )}
                {i.state.phase === 'uploading' && (
                  <div className="mt-2 flex items-center gap-2 text-xs">
                    <Loader2 className="size-3.5 animate-spin" /> Enviando
                    <Progress value={Math.round(i.state.ratio * 100)} className="flex-1" />
                    <span className="w-9 text-right tabular-nums">{Math.round(i.state.ratio * 100)}%</span>
                  </div>
                )}
                {i.state.phase === 'accepted' && (
                  <div className="mt-2 flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-success" />
                    <LiveStatus documentId={i.state.documentId} />
                  </div>
                )}
                {i.state.phase === 'duplicate' && (
                  <p className="mt-2 text-xs text-foreground">
                    Arquivo duplicado: {i.state.reason}{' '}
                    {i.state.documentId && (
                      <Link className="text-primary hover:underline" href={`/documentos/${i.state.documentId}`}>
                        ver documento existente
                      </Link>
                    )}
                  </p>
                )}
                {i.state.phase === 'failed' && (
                  <p className="mt-2 flex items-center gap-1 text-xs text-destructive" role="alert">
                    <XCircle className="size-3.5" /> {i.state.error}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Metadados comuns</CardTitle>
            <CardDescription>Aplicados a todos os arquivos deste envio. Podem ser editados depois, individualmente.</CardDescription>
          </CardHeader>
          <CardContent>
            <MetadataFields register={register} errors={formState.errors} />
          </CardContent>
        </Card>
      )}

      {items.length > 0 && (
        <div className="flex justify-end gap-2 pb-4">
          {running && (
            <Button variant="outline" onClick={() => abortRef.current?.abort()}>
              Cancelar envios
            </Button>
          )}
          <Button onClick={sendAll} disabled={running || pending === 0 || !can('admin')}>
            {running ? <Loader2 className="animate-spin" /> : <Upload />} Enviar {pending > 0 ? `${pending} arquivo(s)` : ''}
          </Button>
        </div>
      )}
    </div>
  );
}
