import type { ChatProvider } from '@rag/ai';
import { RagEngine, type EngineResult } from '@rag/rag';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, multipart, type TestApi } from '../helpers/api';

/**
 * Autorização real da API: token, papéis, credencial por documento e isolamento na recuperação.
 * Requer Postgres, Redis e o provedor de embeddings configurados no .env.
 */
let t: TestApi;
let restrictedDocId = '';
const marker = `Protocolo Sigma-${randomUUID().slice(0, 8)}`;
const restrictedMd = `# Plano reservado de contingência

Art. 1º O ${marker} define a rota alternativa de evacuação do bloco C em caso de motim.

Art. 2º A senha de acionamento do ${marker} é conhecida apenas pela direção.
`;

beforeAll(async () => {
  t = await createTestApi();
  const body = multipart(
    { metadata: JSON.stringify({ title: `Plano reservado ${marker}`, accessLevel: 'restrito', validityStatus: 'vigente' }) },
    { name: `plano-${marker}.md`, content: restrictedMd, type: 'text/markdown' },
  );
  const res = await t.app.inject({ method: 'POST', url: '/api/documents', payload: body.payload, headers: { ...body.headers, ...t.auth({ 'x-rag-clearance': 'restrito' }) } });
  expect(res.statusCode, res.body).toBe(201);
  restrictedDocId = res.json().documentId;
  await t.drainIngestion();
});

afterAll(async () => {
  if (restrictedDocId) {
    await t.app.inject({ method: 'DELETE', url: `/api/documents/${restrictedDocId}?hard=true`, headers: t.auth({ 'x-rag-clearance': 'restrito' }) });
  }
  await t?.close();
});

describe('autenticação', () => {
  it('rejeita requisições sem token, com token inválido ou com identidade sem token', async () => {
    for (const headers of [{}, { authorization: 'Bearer token-invalido-com-tamanho-suficiente' }, { 'x-rag-roles': 'admin' }]) {
      const res = await t.app.inject({ method: 'GET', url: '/api/documents', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejeita cabeçalho de identidade inválido (não cai para admin)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: t.auth({ 'x-rag-roles': 'superuser' }) });
    expect(res.statusCode).toBe(400);
  });

  it('health público não expõe detalhes internos', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toMatch(/postgres|redis:\/\/|password|latency/i);
  });
});

describe('papéis', () => {
  it.each([
    ['viewer', 'GET', '/api/metrics/dashboard'],
    ['viewer', 'GET', '/api/audit'],
    ['analyst', 'GET', '/api/audit'],
    ['viewer', 'GET', '/api/evaluations/runs'],
    ['analyst', 'PUT', '/api/settings'],
    ['analyst', 'POST', '/api/embedding-models'],
    ['viewer', 'POST', '/api/categories'],
  ])('%s não acessa %s %s (403 antes de validar o corpo)', async (role, method, url) => {
    const res = await t.app.inject({ method: method as 'GET', url, headers: t.auth({ 'x-rag-roles': role, 'content-type': 'application/json' }), payload: method === 'GET' ? undefined : '{}' });
    expect(res.statusCode).toBe(403);
  });

  it('viewer não envia documentos', async () => {
    const body = multipart({}, { name: 'x.txt', content: 'conteúdo qualquer' });
    const res = await t.app.inject({ method: 'POST', url: '/api/documents', payload: body.payload, headers: { ...body.headers, ...t.auth({ 'x-rag-roles': 'viewer' }) } });
    expect(res.statusCode).toBe(403);
  });
});

describe('credencial por documento', () => {
  it('documento restrito é invisível (404) para credencial interno em todas as rotas', async () => {
    const h = t.auth({ 'x-rag-clearance': 'interno' });
    for (const suffix of ['', '/chunks', '/pages', '/events', '/file']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/documents/${restrictedDocId}${suffix}`, headers: h });
      expect(res.statusCode, suffix).toBe(404);
    }
    const list = await t.app.inject({ method: 'GET', url: '/api/documents?pageSize=100', headers: h });
    expect(list.json().items.map((d: { id: string }) => d.id)).not.toContain(restrictedDocId);
  });

  it('admin com credencial interno não altera nem remove documento restrito', async () => {
    const h = t.auth({ 'x-rag-clearance': 'interno', 'content-type': 'application/json' });
    expect((await t.app.inject({ method: 'PATCH', url: `/api/documents/${restrictedDocId}`, headers: h, payload: { accessLevel: 'publico' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/documents/${restrictedDocId}`, headers: t.auth({ 'x-rag-clearance': 'interno' }) })).statusCode).toBe(404);
  });

  // Regressão: o PATCH parcial reaplicava valores padrão e rebaixava o documento para "interno"
  it('atualização parcial preserva nível de acesso e vigência', async () => {
    const h = t.auth({ 'x-rag-clearance': 'restrito', 'content-type': 'application/json' });
    const res = await t.app.inject({ method: 'PATCH', url: `/api/documents/${restrictedDocId}`, headers: h, payload: { description: 'descrição atualizada' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().document).toMatchObject({ accessLevel: 'restrito', validityStatus: 'vigente', description: 'descrição atualizada' });
    const asInternal = await t.app.inject({ method: 'GET', url: `/api/documents/${restrictedDocId}`, headers: t.auth({ 'x-rag-clearance': 'interno' }) });
    expect(asInternal.statusCode).toBe(404);
  });

  it('não permite criar nem reclassificar documento acima da própria credencial', async () => {
    const body = multipart({ metadata: JSON.stringify({ title: 'x', accessLevel: 'restrito' }) }, { name: 'y.txt', content: `texto ${randomUUID()}` });
    const res = await t.app.inject({ method: 'POST', url: '/api/documents', payload: body.payload, headers: { ...body.headers, ...t.auth({ 'x-rag-clearance': 'interno' }) } });
    expect(res.statusCode).toBe(403);
  });

  it('duplicata não revela o identificador de documento acima da credencial', async () => {
    const body = multipart({}, { name: 'copia.md', content: restrictedMd });
    const res = await t.app.inject({ method: 'POST', url: '/api/documents', payload: body.payload, headers: { ...body.headers, ...t.auth({ 'x-rag-clearance': 'interno' }) } });
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain(restrictedDocId);
  });

  it('arquivo original é servido com cabeçalhos que impedem execução de conteúdo ativo', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/documents/${restrictedDocId}/file`, headers: t.auth({ 'x-rag-clearance': 'restrito' }) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-security-policy'])).toContain('sandbox');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment/);
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('isolamento na recuperação', () => {
  const ask = async (clearance: 'interno' | 'restrito'): Promise<EngineResult> => {
    const engine = new RagEngine({
      db: t.runtime.db,
      chat: t.runtime.chat,
      embeddingProviderFor: t.runtime.embeddingProviderFor,
      rerankerFor: t.runtime.rerankerFor,
      logger: t.runtime.logger,
      getSettings: async () => {
        const s = await t.runtime.settings.get();
        return { ...s, rerank: { ...s.rerank, enabled: false }, rewrite: { ...s.rewrite, enabled: false } };
      },
    });
    const gen = engine.answer({
      question: `Qual a rota de evacuação definida pelo ${marker}?`,
      history: [],
      principal: { id: 'teste', displayName: 'teste', roles: ['viewer'], clearance, authenticated: false },
      retrievalOnly: true,
    });
    for (;;) {
      const n = await gen.next();
      if (n.done) return n.value;
    }
  };

  it('credencial interno nunca recebe trechos do documento restrito', async () => {
    const r = await ask('interno');
    expect(r.sources.map((s) => s.documentId)).not.toContain(restrictedDocId);
    expect(JSON.stringify(r.sources)).not.toContain(marker);
  });

  it('credencial restrito recupera o documento (controle positivo)', async () => {
    const r = await ask('restrito');
    expect(r.sources.map((s) => s.documentId)).toContain(restrictedDocId);
  });

  it('cache de respostas não serve a credencial interno o que foi gerado com contexto restrito', async () => {
    const store = new Map<string, string>();
    let generations = 0;
    const chat: ChatProvider = {
      name: 'fake',
      chat: async () => {
        throw new Error('não usado');
      },
      async *stream() {
        generations++;
        const content = `Resposta reservada sobre o ${marker} [Fonte 1].`;
        yield { type: 'delta', text: content };
        yield { type: 'done', result: { content, usage: { tokensIn: 1, tokensOut: 1, estimated: false }, model: 'fake', finishReason: 'stop', latencyMs: 1 } };
      },
    };
    const engine = new RagEngine({
      db: t.runtime.db,
      chat,
      embeddingProviderFor: t.runtime.embeddingProviderFor,
      rerankerFor: t.runtime.rerankerFor,
      logger: t.runtime.logger,
      answerCache: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
      getSettings: async () => {
        const s = await t.runtime.settings.get();
        return { ...s, rerank: { ...s.rerank, enabled: false }, rewrite: { ...s.rewrite, enabled: false } };
      },
    });
    const run = async (clearance: 'interno' | 'restrito', question: string, answerCacheMode?: 'refresh'): Promise<EngineResult> => {
      const gen = engine.answer({
        question,
        history: [],
        answerCacheMode,
        principal: { id: 'teste', displayName: 'teste', roles: ['viewer'], clearance, authenticated: false },
      });
      for (;;) {
        const n = await gen.next();
        if (n.done) return n.value;
      }
    };
    const q = `Qual a rota de evacuação definida pelo ${marker}?`;
    await run('restrito', q);
    expect(generations).toBe(1);
    const hit = await run('restrito', q);
    expect(hit.timings.answerCacheHit).toBe(1);
    expect(generations).toBe(1);
    const regenerated = await run('restrito', q, 'refresh');
    expect(regenerated.timings.answerCacheHit).toBe(0);
    expect(generations).toBe(2);
    const other = await run('interno', q);
    expect(other.timings.answerCacheHit ?? 0).toBe(0);
    expect(other.sources.map((s) => s.documentId)).not.toContain(restrictedDocId);
  });

  it('painel de fonte nega trecho restrito para credencial interno', async () => {
    const chunks = await t.app.inject({ method: 'GET', url: `/api/documents/${restrictedDocId}/chunks`, headers: t.auth({ 'x-rag-clearance': 'restrito' }) });
    const chunkId = chunks.json().items[0].id as string;
    expect((await t.app.inject({ method: 'GET', url: `/api/sources/${chunkId}`, headers: t.auth({ 'x-rag-clearance': 'interno' }) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/api/sources/${chunkId}`, headers: t.auth({ 'x-rag-clearance': 'restrito' }) })).statusCode).toBe(200);
  });
});

describe('conversas', () => {
  it('usuário não acessa, renomeia nem remove conversa de outro usuário', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/conversations', headers: t.auth({ 'x-rag-user-id': 'dono', 'content-type': 'application/json' }), payload: { title: 'Minha conversa' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const other = t.auth({ 'x-rag-user-id': 'intruso', 'content-type': 'application/json' });
    expect((await t.app.inject({ method: 'GET', url: `/api/conversations/${id}/messages`, headers: other })).statusCode).toBe(404);
    await t.app.inject({ method: 'PATCH', url: `/api/conversations/${id}`, headers: other, payload: { title: 'invadida' } });
    await t.app.inject({ method: 'DELETE', url: `/api/conversations/${id}`, headers: other });
    const mine = await t.app.inject({ method: 'GET', url: `/api/conversations/${id}/messages`, headers: t.auth({ 'x-rag-user-id': 'dono' }) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().conversation.title).toBe('Minha conversa');
    await t.app.inject({ method: 'DELETE', url: `/api/conversations/${id}`, headers: t.auth({ 'x-rag-user-id': 'dono' }) });
  });

  it('chat rejeita pergunta acima do limite e conversa alheia', async () => {
    const long = await t.app.inject({ method: 'POST', url: '/api/chat', headers: t.auth({ 'content-type': 'application/json' }), payload: { content: 'a'.repeat(20_000) } });
    expect(long.statusCode).toBe(400);
    const foreign = await t.app.inject({ method: 'POST', url: '/api/chat', headers: t.auth({ 'x-rag-user-id': 'intruso', 'content-type': 'application/json' }), payload: { content: 'oi', conversationId: randomUUID() } });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('erros', () => {
  it('erros seguem o formato padrão com correlationId e sem stack trace', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/documents/nao-uuid', headers: t.auth({ 'x-correlation-id': 'teste-correlacao-123' }) });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR', correlationId: 'teste-correlacao-123' });
    expect(res.body).not.toMatch(/at \w+ \(|node_modules/);
    expect(res.headers['x-correlation-id']).toBe('teste-correlacao-123');
  });
});
