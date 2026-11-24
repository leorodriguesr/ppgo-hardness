'use client';

import type { MessageDto, SourceDto } from '@rag/shared';
import { AlertTriangle, Check, Copy, Loader2, RefreshCw, Scale, SearchX, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Badge, Label, NativeSelect, Textarea } from '../ui/primitives';
import { MarkdownAnswer } from './markdown-answer';
import { fileUrl } from './source-panel';

export type ViewMessage = MessageDto & { stage?: string; errorText?: string };

const STAGE_LABELS: Record<string, string> = {
  rewriting: 'Interpretando a pergunta…',
  retrieving: 'Buscando nos documentos…',
  reranking: 'Selecionando os trechos mais relevantes…',
  generating: 'Redigindo a resposta…',
  verifying: 'Verificando as citações…',
};

const NEGATIVE_REASONS = [
  ['incorreta', 'Informação incorreta'],
  ['incompleta', 'Resposta incompleta'],
  ['sem_fonte', 'Afirmação sem fonte'],
  ['fonte_errada', 'Fonte não corresponde'],
  ['irrelevante', 'Não respondeu à pergunta'],
  ['outro', 'Outro motivo'],
] as const;

function Feedback({ message, onChange }: { message: ViewMessage; onChange: (v: 1 | -1) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>('incorreta');
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const send = async (rating: 1 | -1, extra: { reason?: string; comment?: string } = {}) => {
    setPending(true);
    try {
      await api(`/messages/${message.id}/feedback`, { method: 'POST', json: { rating, ...extra } });
      onChange(rating);
      setOpen(false);
      toast.success('Obrigado pela avaliação.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="Resposta útil" aria-pressed={message.feedback === 1} onClick={() => send(1, { reason: 'util' })} disabled={pending}>
        <ThumbsUp className={cn(message.feedback === 1 && 'fill-current text-success')} />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Resposta com problema" aria-pressed={message.feedback === -1} onClick={() => setOpen(true)} disabled={pending}>
        <ThumbsDown className={cn(message.feedback === -1 && 'fill-current text-destructive')} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="O que houve com esta resposta?" description="Sua avaliação ajuda a melhorar a qualidade das respostas.">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="fb-reason">Motivo</Label>
              <NativeSelect id="fb-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                {NEGATIVE_REASONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-comment">Comentário (opcional)</Label>
              <Textarea id="fb-comment" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => send(-1, { reason, comment: comment.trim() || undefined })} disabled={pending}>
              Enviar avaliação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function MessageItem({
  message,
  isLast,
  busy,
  onCite,
  onRegenerate,
  onFeedback,
}: {
  message: ViewMessage;
  isLast: boolean;
  busy: boolean;
  onCite: (source: SourceDto, page: number | null) => void;
  onRegenerate: () => void;
  onFeedback: (v: 1 | -1) => void;
}) {
  const [copied, setCopied] = useState(false);
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm whitespace-pre-wrap text-primary-foreground">{message.content}</div>
      </div>
    );
  }

  const streaming = message.status === 'streaming';
  const cite = (n: number, page: number | null) => {
    const source = message.sources.find((s) => s.sourceNumber === n);
    if (source) onCite(source, page);
    else toast.warning(`A Fonte ${n} não está entre as fontes desta resposta.`);
  };
  const openOriginal = (n: number) => {
    const source = message.sources.find((s) => s.sourceNumber === n);
    if (!source) {
      toast.warning(`A Fonte ${n} não está entre as fontes desta resposta.`);
      return;
    }
    window.open(fileUrl(source.documentId, source.versionId, true, null), '_blank', 'noopener,noreferrer');
  };
  const copy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const g = message.grounding;
  const invalidCitations = message.citations.filter((c) => !c.valid).length;

  return (
    <div className="group flex flex-col gap-1.5" data-testid="assistant-message" data-status={message.status} data-answer-type={message.answerType ?? ''}>
      {message.answerType === 'insufficient_evidence' && (
        <Badge variant="warning" className="w-fit">
          <SearchX className="size-3" /> Sem evidência suficiente nos documentos
        </Badge>
      )}
      {message.answerType === 'conflict' && (
        <Badge variant="warning" className="w-fit">
          <Scale className="size-3" /> Fontes divergentes
        </Badge>
      )}
      {streaming && !message.content && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="size-4 animate-spin" /> {STAGE_LABELS[message.stage ?? ''] ?? 'Processando…'}
        </p>
      )}
      {message.content && <MarkdownAnswer content={message.content} onCite={cite} onOpenOriginal={openOriginal} />}
      {streaming && message.content && <span className="inline-block h-4 w-1.5 animate-pulse bg-foreground/60" aria-hidden />}
      {message.status === 'cancelled' && <p className="text-xs text-muted-foreground">Resposta interrompida.</p>}
      {message.status === 'error' && (
        <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert">
          <AlertTriangle className="size-4" /> {message.errorText ?? 'Não foi possível concluir a resposta.'}
        </p>
      )}
      {!streaming && message.status === 'completed' && g && (g.uncitedClaims > 0 || invalidCitations > 0) && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="size-3.5 text-warning" />
          {invalidCitations > 0 ? `${invalidCitations} citação(ões) não correspondem às fontes. ` : ''}
          {g.uncitedClaims > 0 ? `${g.uncitedClaims} afirmação(ões) sem citação — confira nas fontes.` : ''}
        </p>
      )}
      {!streaming && message.sources.length > 0 && message.answerType !== 'insufficient_evidence' && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground select-none">Fontes consultadas ({message.sources.length})</summary>
          <ol className="mt-1.5 space-y-1">
            {message.sources.map((s) => (
              <li key={s.chunkId}>
                <button type="button" className="text-left hover:underline" onClick={() => onCite(s, s.pageStart)}>
                  <span className="font-medium">Fonte {s.sourceNumber}:</span> {s.documentNumber ?? s.documentTitle}
                  {s.pageStart ? `, p. ${s.pageStart}${s.pageEnd && s.pageEnd !== s.pageStart ? `–${s.pageEnd}` : ''}` : ''}
                  {s.validityStatus !== 'vigente' && <span className="ml-1 text-warning">({s.validityStatus})</span>}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
      {!streaming && message.status !== 'error' && (
        <div className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
          <Button variant="ghost" size="icon-sm" onClick={copy} aria-label="Copiar resposta" disabled={!message.content}>
            {copied ? <Check /> : <Copy />}
          </Button>
          {message.status === 'completed' && <Feedback message={message} onChange={onFeedback} />}
          {isLast && (
            <Button variant="ghost" size="sm" onClick={onRegenerate} disabled={busy}>
              <RefreshCw /> Regenerar
            </Button>
          )}
        </div>
      )}
      {!streaming && message.status === 'error' && isLast && (
        <Button variant="outline" size="sm" className="w-fit" onClick={onRegenerate} disabled={busy}>
          <RefreshCw /> Tentar novamente
        </Button>
      )}
    </div>
  );
}
