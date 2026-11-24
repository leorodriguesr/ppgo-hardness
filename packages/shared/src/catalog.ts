import { z } from 'zod';
import type { AccessLevel, DocumentType, ValidityStatus } from './domain';

export const CATALOG_STATUSES = ['pendente', 'baixando', 'ingerido', 'erro'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export const CATALOG_STATUS_LABELS: Record<CatalogStatus, string> = {
  pendente: 'Não indexado',
  baixando: 'Baixando',
  ingerido: 'Indexado',
  erro: 'Falhou',
};

const legislaAtoSchema = z
  .object({
    id: z.number().int().positive(),
    ano: z.number().int(),
    numero: z.number().int(),
    data: z.string(),
    data_inicio_vigencia: z.string().nullable().optional(),
    ementa: z.string().optional().default(''),
    tipo_ato_infralegal: z.string().trim().min(1),
    situacao_ato_infralegal: z.string().trim().min(1),
    orgao_relacionado_nome: z.string().trim().min(1),
    orgao_relacionado_sigla: z.string().trim().min(1),
  })
  .passthrough();

export const legislaCatalogFileSchema = z.object({
  total_resultados: z.number().int().optional(),
  resultados: z.array(legislaAtoSchema).min(1),
});

export interface CatalogActDraft {
  source: 'legisla';
  externalId: number;
  title: string;
  documentType: DocumentType;
  documentNumber: string;
  issuingBody: string;
  publicationDate: string | null;
  effectiveDate: string | null;
  validityStatus: ValidityStatus;
  accessLevel: AccessLevel;
  description: string | null;
}

function isRealDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Aceita dd/mm/aaaa (arquivo do Legisla) ou aaaa-mm-dd. Data impossível vira nula. */
export function catalogIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  const brazilian = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = brazilian ? `${brazilian[3]}-${brazilian[2]}-${brazilian[1]}` : text;
  return isRealDate(iso) ? iso : null;
}

function documentTypeOf(tipo: string): DocumentType {
  const name = tipo.trim().toLocaleLowerCase('pt-BR');
  if (name === 'portaria' || name === 'portaria normativa') return 'portaria';
  return 'outro';
}

function validityOf(situacao: string): ValidityStatus {
  const name = situacao.trim().toLocaleLowerCase('pt-BR');
  if (name === 'revogada' || name === 'revogado') return 'revogado';
  if (name === 'caducada' || name === 'caducado') return 'expirado';
  return 'vigente';
}

function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

/** Converte um ato do JSON do Legisla no cadastro que a biblioteca já entende. */
export function catalogActFromLegisla(item: z.infer<typeof legislaAtoSchema>): CatalogActDraft {
  const tipo = item.tipo_ato_infralegal.trim();
  const sigla = item.orgao_relacionado_sigla.trim();
  const ementa = cleanText(item.ementa, 4000);
  return {
    source: 'legisla',
    externalId: item.id,
    title: cleanText(`${tipo} ${sigla} nº ${item.numero}/${item.ano}`, 500),
    documentType: documentTypeOf(tipo),
    documentNumber: `${item.numero}/${item.ano}`,
    issuingBody: cleanText(item.orgao_relacionado_nome, 300),
    publicationDate: catalogIsoDate(item.data),
    effectiveDate: catalogIsoDate(item.data_inicio_vigencia),
    validityStatus: validityOf(item.situacao_ato_infralegal),
    accessLevel: 'publico',
    description: ementa.length > 0 ? ementa : null,
  };
}
