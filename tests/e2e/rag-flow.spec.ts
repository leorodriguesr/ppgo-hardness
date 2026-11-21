import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * Fluxo obrigatório de ponta a ponta (cenários 1–13), executado em série sobre um documento
 * sintético exclusivo desta execução. Ao final, o documento e as conversas criadas são excluídos.
 */

const ANSWER_TIMEOUT = 240_000;
const nonce = randomBytes(3).toString('hex').toUpperCase();
const docNumber = `Portaria nº ${parseInt(nonce, 16) % 9000 + 1000}/2026-E2E${nonce}`;
const docTitle = `Inspeção de extintores nas unidades prisionais ${nonce}`;
const docBody = `# ${docNumber}

DOCUMENTO SINTÉTICO PARA TESTES AUTOMATIZADOS — conteúdo fictício (${nonce}).

Dispõe sobre a inspeção periódica dos extintores de incêndio nas unidades prisionais.

Art. 1º A inspeção dos extintores de incêndio das unidades prisionais será realizada a cada 37 (trinta e sete) dias pelo setor de manutenção predial.

Art. 2º O relatório de cada inspeção de extintores será assinado pelo Chefe de Manutenção e arquivado por 9 (nove) anos.
`;
const QUESTION = 'A cada quantos dias deve ser realizada a inspeção dos extintores de incêndio nas unidades prisionais?';
const FOLLOW_UP = 'E por quanto tempo o relatório dessa inspeção deve ser arquivado?';

const state: { documentId?: string; conversations: string[] } = { conversations: [] };

async function ask(page: Page, question: string) {
  const answers = page.locator('[data-testid="assistant-message"]');
  const before = await answers.count();
  await page.getByLabel('Pergunta', { exact: true }).fill(question);
  await page.getByLabel('Pergunta', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Parar geração' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Parar geração' })).toBeHidden({ timeout: ANSWER_TIMEOUT });
  await expect(answers).toHaveCount(before + 1);
  const answer = answers.last();
  await expect(answer).toHaveAttribute('data-status', 'completed');
  const id = /\/chat\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (id && !state.conversations.includes(id)) state.conversations.push(id);
  return answer;
}

/** Chamada à API pelo proxy do frontend, com os mesmos cabeçalhos exigidos do navegador. */
async function apiCall(page: Page, method: 'DELETE' | 'GET', path: string) {
  const origin = new URL(page.url()).origin;
  return page.request.fetch(`${origin}/api/rag${path}`, { method, headers: { 'x-requested-with': 'rag-web', origin, 'sec-fetch-site': 'same-origin' } });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request, baseURL }) => {
  const me = await request.get(`${baseURL}/api/rag/me`, { headers: { 'sec-fetch-site': 'same-origin' } });
  expect(me.ok(), 'A API precisa estar em execução (npm run dev:api) para o E2E.').toBe(true);
  const health = await request.get(`${baseURL}/api/rag/system/health`, { headers: { 'sec-fetch-site': 'same-origin' } });
  const body = (await health.json()) as { checks?: Record<string, { ok: boolean }> };
  for (const dep of ['database', 'redis', 'worker', 'llm']) expect(body.checks?.[dep]?.ok, `Dependência indisponível: ${dep}`).toBe(true);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/chat');
  for (const id of state.conversations) await apiCall(page, 'DELETE', `/conversations/${id}`);
  if (state.documentId) await apiCall(page, 'DELETE', `/documents/${state.documentId}`);
  await page.close();
});

test('fluxo completo: upload → indexação → conversa com citação → desativação', async ({ page }) => {
  await test.step('1. abrir o sistema', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByRole('heading', { name: 'Consulte os documentos institucionais' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Biblioteca' })).toBeVisible();
  });

  await test.step('2. enviar documento', async () => {
    await page.getByRole('link', { name: 'Biblioteca' }).click();
    await page.getByRole('link', { name: 'Enviar documentos' }).click();
    await page.getByTestId('file-input').setInputFiles({ name: `extintores-${nonce}.md`, mimeType: 'text/markdown', buffer: Buffer.from(docBody, 'utf8') });
    const item = page.getByTestId('upload-item');
    await expect(item).toHaveCount(1);
    await item.getByPlaceholder('Título').fill(docTitle);
    await item.getByPlaceholder('Número do ato (opcional)').fill(docNumber);
    await page.getByLabel('Órgão emissor').fill('Diretoria-Geral de Polícia Penal');
    await page.getByRole('button', { name: /^Enviar 1 arquivo/ }).click();
  });

  await test.step('3. acompanhar processamento', async () => {
    const item = page.getByTestId('upload-item');
    await expect(item.getByRole('link', { name: 'detalhes' })).toBeVisible({ timeout: 60_000 });
    const href = await item.getByRole('link', { name: 'detalhes' }).getAttribute('href');
    state.documentId = /\/documentos\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
    expect(state.documentId).toBeTruthy();
    await expect(item.getByText('Concluído')).toBeVisible({ timeout: 180_000 });
  });

  await test.step('4. confirmar indexação', async () => {
    await expect(page.getByTestId('upload-item').getByText(/\d+ trechos indexados/)).toBeVisible();
    await page.getByTestId('upload-item').getByRole('link', { name: 'detalhes' }).click();
    await expect(page.getByRole('heading', { name: docTitle })).toBeVisible();
    await page.getByRole('tab', { name: 'Trechos' }).click();
    await expect(page.getByText(/\d+ trechos na versão atual/)).toBeVisible();
    await expect(page.getByText('37 (trinta e sete) dias').first()).toBeVisible();
  });

  let conversationUrl = '';
  await test.step('5. criar conversa', async () => {
    await page.getByRole('link', { name: 'Consultar' }).click();
    await expect(page.getByRole('heading', { name: 'Consulte os documentos institucionais' })).toBeVisible();
  });

  await test.step('6–7. perguntar sobre o documento e receber resposta', async () => {
    const answer = await ask(page, QUESTION);
    await expect(answer.locator('.prose-answer')).toContainText('37');
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    conversationUrl = page.url();
  });

  let originalHref: string | null = null;
  await test.step('8. visualizar citação', async () => {
    const answer = page.locator('[data-testid="assistant-message"]').last();
    await answer.getByRole('button', { name: /^Abrir Fonte \d+/ }).first().click();
    const panel = page.getByRole('complementary', { name: 'Fonte citada' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(docNumber);
    await expect(panel).toContainText('37 (trinta e sete)');
    originalHref = await panel.getByRole('link', { name: 'Abrir original' }).getAttribute('href');
  });

  await test.step('9. abrir documento original', async () => {
    expect(originalHref).toBeTruthy();
    const res = await page.request.get(new URL(originalHref!, page.url()).toString(), { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(await res.text()).toContain('a cada 37 (trinta e sete) dias');
    await page.getByRole('button', { name: 'Fechar painel da fonte' }).click();
  });

  await test.step('10. continuar conversa', async () => {
    const answer = await ask(page, FOLLOW_UP);
    await expect(answer.locator('.prose-answer')).toContainText(/\b9\b|nove/);
    expect(page.url()).toBe(conversationUrl);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(2);
  });

  await test.step('11. registrar feedback', async () => {
    const answer = page.locator('[data-testid="assistant-message"]').last();
    await answer.getByRole('button', { name: 'Resposta útil' }).click();
    await expect(answer.getByRole('button', { name: 'Resposta útil' })).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.locator('[data-testid="assistant-message"]').last().getByRole('button', { name: 'Resposta útil' })).toHaveAttribute('aria-pressed', 'true');
  });

  await test.step('12. desativar documento', async () => {
    await page.goto(`/documentos/${state.documentId}`);
    await page.getByRole('button', { name: 'Desativar' }).click();
    await expect(page.getByText('Desativado', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reativar' })).toBeVisible();
  });

  await test.step('13. documento desativado não é mais recuperado', async () => {
    await page.goto('/chat');
    const answer = await ask(page, QUESTION);
    await expect(answer.locator('.prose-answer')).not.toContainText('37');
    // Inclui a lista "Fontes consultadas": o documento não pode aparecer nem como fonte recuperada.
    await expect(answer).not.toContainText(docNumber);
  });
});
