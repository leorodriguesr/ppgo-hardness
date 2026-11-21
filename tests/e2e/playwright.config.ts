import { defineConfig } from '@playwright/test';

/**
 * E2E contra a pilha real (API, worker, PostgreSQL, Redis e Ollama já em execução).
 * O servidor web é iniciado automaticamente se ainda não estiver no ar.
 * Usa o Google Chrome instalado (channel "chrome") para não baixar navegadores.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Respostas com LLM local levam de 20 s a 90 s cada; o fluxo completo faz três perguntas.
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: '../../.data/e2e-report', open: 'never' }]],
  outputDir: '../../.data/e2e-results',
  use: {
    baseURL,
    channel: process.env.E2E_BROWSER_CHANNEL ?? 'chrome',
    viewport: { width: 1366, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
  },
  webServer: {
    command: 'npm run dev -w @rag/web',
    cwd: '../..',
    url: `${baseURL}/chat`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
