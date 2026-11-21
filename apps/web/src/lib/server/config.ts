import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Em desenvolvimento no monorepo, reaproveita o .env da raiz (apenas no servidor). */
function loadRootEnv() {
  if (process.env.ADMIN_API_TOKEN) return;
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}
loadRootEnv();

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const serverConfig = {
  apiUrl: process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`,
  token: process.env.ADMIN_API_TOKEN ?? '',
  /** Hosts aceitos no cabeçalho Host (proteção contra DNS rebinding). */
  allowedHosts: list(process.env.WEB_ALLOWED_HOSTS).length ? list(process.env.WEB_ALLOWED_HOSTS) : ['localhost:3000', '127.0.0.1:3000'],
  /**
   * Identidade enviada à API enquanto não houver login institucional. Definida apenas no servidor;
   * o navegador nunca escolhe papel ou credencial.
   */
  identity: {
    userId: process.env.WEB_USER_ID,
    userName: process.env.WEB_USER_NAME,
    roles: process.env.WEB_USER_ROLES,
    clearance: process.env.WEB_USER_CLEARANCE,
  },
};
