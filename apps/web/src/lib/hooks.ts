'use client';

import type { Principal, Role } from '@rag/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

const RANK: Record<Role, number> = { viewer: 0, analyst: 1, admin: 2 };

/** Identidade efetiva (definida no servidor). Usada só para adaptar a interface; a API autoriza. */
export function useMe() {
  const q = useQuery({ queryKey: ['me'], queryFn: () => api<{ principal: Principal }>('/me'), staleTime: 5 * 60_000 });
  const principal = q.data?.principal;
  const can = (role: Role) => !!principal?.roles.some((r) => RANK[r] >= RANK[role]);
  return { ...q, principal, can };
}
