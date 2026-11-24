import { AppError } from '@rag/shared';

const ALLOWED_HOSTS = new Set(['legisla.casacivil.go.gov.br', 'www.policiapenal.go.gov.br', 'policiapenal.go.gov.br']);

export interface ActFileRef {
  source: 'legisla' | 'site';
  externalId: number;
  fileKind: 'legisla' | 'pdf' | null;
  fileUrl: string | null;
}

export function legislaPdfUrl(id: number): string {
  return `https://legisla.casacivil.go.gov.br/api/v1/pesquisa/atos_infralegais/${id}/pdf`;
}

export function actFileUrl(act: ActFileRef): string | null {
  if (act.fileKind === 'pdf') return act.fileUrl;
  if (act.fileKind === 'legisla' || (act.fileKind == null && act.source === 'legisla')) return legislaPdfUrl(act.externalId);
  return null;
}

function allowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('VALIDATION_ERROR', 'O endereço do arquivo é inválido.');
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new AppError('VALIDATION_ERROR', 'O arquivo precisa estar no site da Polícia Penal ou no Legisla.');
  }
  return parsed;
}

async function request(url: string, method: 'GET' | 'HEAD'): Promise<Response> {
  allowed(url);
  try {
    return await fetch(url, {
      method,
      headers: { accept: method === 'HEAD' ? '*/*' : 'application/pdf', 'user-agent': 'ppgo-hardness' },
      signal: AbortSignal.timeout(method === 'HEAD' ? 20_000 : 60_000),
      redirect: 'follow',
    });
  } catch {
    throw new AppError('PROVIDER_ERROR', 'Não foi possível consultar o arquivo na fonte.');
  }
}

/** Pergunta se o arquivo mudou, sem baixar o PDF. */
export async function probeFileEtag(url: string): Promise<string | null> {
  const response = await request(url, 'HEAD');
  if (!response.ok) return null;
  return response.headers.get('etag');
}

export async function downloadActPdf(act: ActFileRef, maxBytes: number): Promise<{ data: Buffer; etag: string | null }> {
  const url = actFileUrl(act);
  if (!url) throw new AppError('PROVIDER_ERROR', 'Este ato não tem arquivo para baixar. Envie o PDF manualmente.');
  const response = await request(url, 'GET');
  if (response.status === 404) throw new AppError('PROVIDER_ERROR', 'A fonte não tem o PDF deste ato. Envie o arquivo manualmente.');
  if (!response.ok) throw new AppError('PROVIDER_ERROR', `A fonte não entregou o PDF deste ato (HTTP ${response.status}).`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', 'O PDF excede o tamanho máximo permitido.');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length === 0) throw new AppError('PROVIDER_ERROR', 'A fonte devolveu um PDF vazio.');
  if (data.length > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', 'O PDF excede o tamanho máximo permitido.');
  if (!data.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'A fonte não entregou o PDF deste ato. Envie o arquivo manualmente.');
  }
  return { data, etag: response.headers.get('etag') };
}
