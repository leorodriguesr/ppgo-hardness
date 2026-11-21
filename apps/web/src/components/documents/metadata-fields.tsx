'use client';

import { ACCESS_LEVEL_LABELS, allowedAccessLevels, DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES, VALIDITY_STATUS_LABELS, VALIDITY_STATUSES } from '@rag/shared';
import { useQuery } from '@tanstack/react-query';
import type { FieldErrors, FieldValues, Path, UseFormRegister } from 'react-hook-form';
import { api } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { Input, Label, NativeSelect, Textarea } from '../ui/primitives';

export interface MetadataFormValues {
  title?: string;
  documentType: string;
  categoryId: string;
  issuingBody: string;
  documentNumber?: string;
  publicationDate: string;
  effectiveDate: string;
  validityStatus: string;
  accessLevel: string;
  description: string;
}

/** Converte valores do formulário (strings) no payload da API (null para vazio). */
export function toMetadataPayload(v: Partial<MetadataFormValues>) {
  const blank = (s: string | undefined) => (s && s.trim() ? s.trim() : null);
  return {
    ...(v.title !== undefined && { title: v.title.trim() }),
    documentType: v.documentType,
    categoryId: blank(v.categoryId),
    issuingBody: blank(v.issuingBody),
    ...(v.documentNumber !== undefined && { documentNumber: blank(v.documentNumber) }),
    publicationDate: blank(v.publicationDate),
    effectiveDate: blank(v.effectiveDate),
    validityStatus: v.validityStatus,
    accessLevel: v.accessLevel,
    description: blank(v.description),
  };
}

function Field({ id, label, error, children, className }: { id: string; label: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label htmlFor={id} className="mb-1.5 block">
        {label}
      </Label>
      {children}
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function MetadataFields<T extends FieldValues>({
  register,
  errors,
  withTitle,
  withNumber,
}: {
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  withTitle?: boolean;
  withNumber?: boolean;
}) {
  const { principal } = useMe();
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ items: { id: string; name: string }[] }>('/categories') });
  const levels = principal ? allowedAccessLevels(principal.clearance) : (['publico', 'interno'] as const);
  const r = (name: string) => register(name as Path<T>);
  const err = (name: string) => (errors as Record<string, { message?: string } | undefined>)[name]?.message;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {withTitle && (
        <Field id="title" label="Título *" error={err('title')} className="sm:col-span-2">
          <Input id="title" maxLength={500} aria-invalid={!!err('title')} {...r('title')} />
        </Field>
      )}
      <Field id="documentType" label="Tipo">
        <NativeSelect id="documentType" {...r('documentType')}>
          {DOCUMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {DOCUMENT_TYPE_LABELS[t]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {withNumber && (
        <Field id="documentNumber" label="Número do ato" error={err('documentNumber')}>
          <Input id="documentNumber" placeholder="Ex.: Portaria nº 101/2025-DGPP" maxLength={120} {...r('documentNumber')} />
        </Field>
      )}
      <Field id="categoryId" label="Categoria">
        <NativeSelect id="categoryId" {...r('categoryId')}>
          <option value="">Sem categoria</option>
          {categories.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="issuingBody" label="Órgão emissor">
        <Input id="issuingBody" maxLength={300} {...r('issuingBody')} />
      </Field>
      <Field id="publicationDate" label="Data de publicação" error={err('publicationDate')}>
        <Input id="publicationDate" type="date" {...r('publicationDate')} />
      </Field>
      <Field id="effectiveDate" label="Início da vigência" error={err('effectiveDate')}>
        <Input id="effectiveDate" type="date" {...r('effectiveDate')} />
      </Field>
      <Field id="validityStatus" label="Situação">
        <NativeSelect id="validityStatus" {...r('validityStatus')}>
          {VALIDITY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {VALIDITY_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="accessLevel" label="Nível de acesso">
        <NativeSelect id="accessLevel" {...r('accessLevel')}>
          {levels.map((l) => (
            <option key={l} value={l}>
              {ACCESS_LEVEL_LABELS[l]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="description" label="Descrição" className="sm:col-span-2">
        <Textarea id="description" maxLength={4000} rows={2} {...r('description')} />
      </Field>
    </div>
  );
}
