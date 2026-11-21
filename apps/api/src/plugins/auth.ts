import { ACCESS_LEVELS, AppError, ROLES, type AccessLevel, type Principal, type Role } from '@rag/shared';
import { safeEqual } from '@rag/shared/server';
import type { FastifyReply, FastifyRequest } from 'fastify';

const ROLE_RANK: Record<Role, number> = { viewer: 0, analyst: 1, admin: 2 };
const USER_ID_RE = /^[A-Za-z0-9._@-]{1,120}$/;

/**
 * Autenticação de serviço (pré-login institucional):
 * - toda requisição à API precisa do token compartilhado com o proxy server-side do frontend;
 * - a identidade (usuário, papéis, credencial) só é aceita de cabeçalhos quando o token é válido;
 * - sem cabeçalhos, usa-se o principal local padrão, com a credencial configurada no servidor.
 * O frontend nunca é considerado mecanismo de autorização: as verificações ocorrem aqui.
 */
export function createAuthenticator(opts: { token: string; defaultClearance: AccessLevel }) {
  return async function authenticate(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!provided || !safeEqual(provided, opts.token)) {
      throw new AppError('UNAUTHORIZED', 'Acesso não autorizado.');
    }
    req.principal = principalFromHeaders(req, opts.defaultClearance);
  };
}

/**
 * Cabeçalho ausente usa o padrão local; cabeçalho presente com valor inválido é rejeitado
 * (nunca cai silenciosamente para um padrão mais privilegiado).
 */
export function principalFromHeaders(req: FastifyRequest, defaultClearance: AccessLevel): Principal {
  const h = (name: string) => {
    const v = req.headers[name];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') throw invalidIdentity(name);
    return v.trim();
  };
  const id = h('x-rag-user-id');
  if (id !== undefined && !USER_ID_RE.test(id)) throw invalidIdentity('x-rag-user-id');

  const rawRoles = h('x-rag-roles');
  let roles: Role[] = ['admin'];
  if (rawRoles !== undefined) {
    const parts = rawRoles.split(',').map((r) => r.trim());
    if (!parts.length || parts.some((r) => !(ROLES as readonly string[]).includes(r))) throw invalidIdentity('x-rag-roles');
    roles = [...new Set(parts as Role[])];
  }

  const clearance = h('x-rag-clearance');
  if (clearance !== undefined && !(ACCESS_LEVELS as readonly string[]).includes(clearance)) throw invalidIdentity('x-rag-clearance');

  const name = h('x-rag-user-name');
  let displayName = 'Usuário local';
  if (name !== undefined) {
    try {
      displayName = decodeURIComponent(name).replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 120) || displayName;
    } catch {
      throw invalidIdentity('x-rag-user-name');
    }
  }
  return {
    id: id ?? 'usuario-local',
    displayName,
    roles,
    clearance: (clearance as AccessLevel | undefined) ?? defaultClearance,
    authenticated: false,
  };
}

function invalidIdentity(header: string) {
  return new AppError('VALIDATION_ERROR', `Cabeçalho de identidade inválido: ${header}.`);
}

export function hasRole(principal: Principal, role: Role): boolean {
  return principal.roles.some((r) => ROLE_RANK[r] >= ROLE_RANK[role]);
}

/** Usar como hook `onRequest` da rota: autoriza antes de ler/validar o corpo (inclusive uploads). */
export function requireRole(role: Role) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!hasRole(req.principal, role)) throw new AppError('FORBIDDEN', 'Você não tem permissão para esta operação.');
  };
}
