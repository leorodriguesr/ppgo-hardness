import { ACCESS_LEVEL_LABELS, PROCESSING_STATUS_LABELS, VALIDITY_STATUS_LABELS, type AccessLevel, type DocumentVersionDto, type ValidityStatus } from '@rag/shared';
import { AlertCircle, CheckCircle2, Loader2, Lock } from 'lucide-react';
import { Badge, Progress } from '../ui/primitives';

export const isProcessing = (v: Pick<DocumentVersionDto, 'status'> | null | undefined) => !!v && v.status !== 'completed' && v.status !== 'error';

export function ValidityBadge({ status }: { status: ValidityStatus }) {
  return <Badge variant={status === 'vigente' ? 'success' : 'warning'}>{VALIDITY_STATUS_LABELS[status]}</Badge>;
}

export function AccessBadge({ level }: { level: AccessLevel }) {
  return (
    <Badge variant={level === 'restrito' || level === 'sigiloso' ? 'destructive' : 'outline'}>
      {(level === 'restrito' || level === 'sigiloso') && <Lock className="size-3" />}
      {ACCESS_LEVEL_LABELS[level]}
    </Badge>
  );
}

/** Estado e progresso reais do processamento (valores vindos do pipeline, nunca simulados). */
export function ProcessingStatus({ version, compact }: { version: DocumentVersionDto | null; compact?: boolean }) {
  if (!version) return <Badge variant="secondary">Sem versão</Badge>;
  if (version.status === 'completed') {
    return (
      <Badge variant="success">
        <CheckCircle2 className="size-3" /> {PROCESSING_STATUS_LABELS.completed}
      </Badge>
    );
  }
  if (version.status === 'error') {
    return (
      <Badge variant="destructive" title={version.errorMessage ?? undefined}>
        <AlertCircle className="size-3" /> {PROCESSING_STATUS_LABELS.error}
      </Badge>
    );
  }
  return (
    <div className={compact ? 'w-36' : 'w-full max-w-xs'} aria-live="polite">
      <div className="mb-1 flex items-center gap-1.5 text-xs">
        <Loader2 className="size-3 animate-spin" />
        <span className="truncate">{PROCESSING_STATUS_LABELS[version.status]}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">{version.progress}%</span>
      </div>
      <Progress value={version.progress} aria-label={`Progresso: ${version.progress}%`} />
      {!compact && version.stageDetail && <p className="mt-1 text-xs text-muted-foreground">{version.stageDetail}</p>}
    </div>
  );
}
