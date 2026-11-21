import type { ApiErrorBody } from '@rag/shared';

export const API_BASE = '/api/rag';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    // resposta sem JSON
  }
  const e = body?.error;
  return new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Erro ${res.status} ao contatar o serviço.`, e?.correlationId, e?.details);
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const h = new Headers(headers);
  if (rest.method && rest.method !== 'GET') h.set('x-requested-with', 'rag-web');
  if (json !== undefined) h.set('content-type', 'application/json');
  const res = await fetch(`${API_BASE}${path}`, { ...rest, headers: h, body: json !== undefined ? JSON.stringify(json) : rest.body });
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.correlationId ? `${err.message} (código: ${err.correlationId.slice(0, 8)})` : err.message;
  if (err instanceof Error) return err.message;
  return 'Erro inesperado.';
}

/**
 * Upload com progresso real de envio (XMLHttpRequest expõe bytes enviados; fetch não).
 * O progresso de processamento é acompanhado depois, pelo estado do documento.
 */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (ratio: number) => void, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${path}`);
    xhr.setRequestHeader('x-requested-with', 'rag-web');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = xhr.response as (T & Partial<ApiErrorBody>) | null;
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as T);
      // 409 (duplicado) traz corpo de resultado, não de erro
      if (xhr.status === 409 && body && !('error' in body)) return resolve(body as T);
      const e = body?.error;
      reject(new ApiError(xhr.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Falha no envio (HTTP ${xhr.status}).`, e?.correlationId, e?.details));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Falha de rede durante o envio.'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Envio cancelado.'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}
