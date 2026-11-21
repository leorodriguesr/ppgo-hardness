import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { hasRole, principalFromHeaders } from '../../apps/api/src/plugins/auth';

const req = (headers: Record<string, string | string[]>) => ({ headers }) as unknown as FastifyRequest;

describe('principalFromHeaders', () => {
  it('sem cabeçalhos usa o principal local com a credencial padrão do servidor', () => {
    expect(principalFromHeaders(req({}), 'interno')).toMatchObject({ id: 'usuario-local', roles: ['admin'], clearance: 'interno' });
  });

  it('aceita identidade válida', () => {
    const p = principalFromHeaders(
      req({ 'x-rag-user-id': 'joao.silva', 'x-rag-roles': 'viewer,analyst', 'x-rag-clearance': 'restrito', 'x-rag-user-name': encodeURIComponent('João Silva') }),
      'interno',
    );
    expect(p).toMatchObject({ id: 'joao.silva', roles: ['viewer', 'analyst'], clearance: 'restrito', displayName: 'João Silva' });
  });

  // Regressão: papel inválido caía no padrão "admin"
  it.each([
    [{ 'x-rag-roles': 'superuser' }],
    [{ 'x-rag-roles': 'viewer,root' }],
    [{ 'x-rag-roles': '' }],
    [{ 'x-rag-clearance': 'ultrassecreto' }],
    [{ 'x-rag-user-id': '../admin' }],
    [{ 'x-rag-user-name': '%E0%A4%A' }],
    [{ 'x-rag-roles': ['viewer', 'admin'] }],
  ])('rejeita cabeçalho inválido em vez de cair no padrão: %j', (headers) => {
    expect(() => principalFromHeaders(req(headers), 'interno')).toThrow(/Cabeçalho de identidade inválido/);
  });

  it('remove caracteres de controle do nome exibido', () => {
    expect(principalFromHeaders(req({ 'x-rag-user-name': 'Ana%0AAdmin' }), 'interno').displayName).toBe('AnaAdmin');
  });
});

describe('hasRole', () => {
  const p = (roles: ('viewer' | 'analyst' | 'admin')[]) => ({ id: 'x', displayName: 'x', roles, clearance: 'interno' as const, authenticated: false });
  it('respeita a hierarquia viewer < analyst < admin', () => {
    expect(hasRole(p(['admin']), 'analyst')).toBe(true);
    expect(hasRole(p(['analyst']), 'admin')).toBe(false);
    expect(hasRole(p(['viewer']), 'viewer')).toBe(true);
  });
});
