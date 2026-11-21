import { serverConfig } from '@/lib/server/config';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,200}$/;
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'x-correlation-id'];
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'content-length',
  'cache-control',
  'content-security-policy',
  'x-content-type-options',
  'x-correlation-id',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
];

function reject(status: number, message: string) {
  return Response.json({ error: { code: status === 403 ? 'FORBIDDEN' : 'VALIDATION_ERROR', message } }, { status });
}

/**
 * Proxy server-side para a API. Injeta o token de serviço e a identidade configurada no servidor.
 * Como o proxy confere privilégios a quem o chama, exige origem própria (CSRF/DNS rebinding).
 */
async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!serverConfig.token) return reject(500, 'ADMIN_API_TOKEN não configurado no servidor web.');

  const host = req.headers.get('host') ?? '';
  if (!serverConfig.allowedHosts.includes(host)) return reject(403, 'Host não permitido.');

  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return reject(403, 'Requisição de outra origem bloqueada.');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== host) return reject(403, 'Origem não permitida.');
    if (req.headers.get('x-requested-with') !== 'rag-web') return reject(403, 'Cabeçalho de requisição ausente.');
  }

  const { path } = await ctx.params;
  if (!path.length || !path.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')) return reject(400, 'Caminho inválido.');
  const target = new URL(`/api/${path.join('/')}`, serverConfig.apiUrl);
  target.search = req.nextUrl.search;

  const headers = new Headers({ authorization: `Bearer ${serverConfig.token}` });
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const { userId, userName, roles, clearance } = serverConfig.identity;
  if (userId) headers.set('x-rag-user-id', userId);
  if (userName) headers.set('x-rag-user-name', encodeURIComponent(userName));
  if (roles) headers.set('x-rag-roles', roles);
  if (clearance) headers.set('x-rag-clearance', clearance);

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== null;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error -- necessário para enviar corpo em streaming (uploads) no fetch do Node
      duplex: hasBody ? 'half' : undefined,
      signal: req.signal,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error('[proxy] API indisponível', err instanceof Error ? err.message : err);
    return Response.json(
      { error: { code: 'SERVICE_UNAVAILABLE', message: 'Não foi possível contatar o serviço. Verifique se a API está em execução.' } },
      { status: 503 },
    );
  }

  const out = new Headers();
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (upstream.headers.get('content-type')?.startsWith('text/event-stream')) {
    out.set('cache-control', 'no-cache, no-transform');
    out.set('x-accel-buffering', 'no');
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST, proxy as PUT };
