import { HttpReranker } from '@rag/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const docs = [
  { id: 'a', text: 'trecho a' },
  { id: 'b', text: 'trecho b' },
];

function stubResponse(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('HttpReranker', () => {
  it('formato TEI/llama.cpp com logits: aplica sigmoide mesmo se todos os valores caírem em [0, 1]', async () => {
    stubResponse([
      { index: 1, score: 0.5 },
      { index: 0, score: 0 },
    ]);
    const r = await new HttpReranker('http://127.0.0.1:8080/rerank', 'm', undefined, 1000, 'logit').rerank('q', docs);
    expect(r.find((x) => x.id === 'a')!.score).toBeCloseTo(0.5, 5);
    expect(r.find((x) => x.id === 'b')!.score).toBeCloseTo(1 / (1 + Math.exp(-0.5)), 5);
  });

  it('formato Cohere/Jina com probabilidades é usado como veio', async () => {
    stubResponse({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] });
    const r = await new HttpReranker('http://x/rerank', 'm', undefined, 1000, 'probability').rerank('q', docs);
    expect(r.map((x) => x.score)).toEqual([0.9, 0.1]);
  });

  it('formato Voyage ({data: [...]}) é aceito', async () => {
    stubResponse({ data: [{ index: 1, relevance_score: 0.2 }, { index: 0, relevance_score: 0.8 }] });
    const r = await new HttpReranker('http://x/rerank', 'm').rerank('q', docs);
    expect(r.map((x) => x.score)).toEqual([0.8, 0.2]);
  });

  it('auto: detecta logits pela faixa de valores', async () => {
    stubResponse([
      { index: 0, score: 3.5 },
      { index: 1, score: -10.9 },
    ]);
    const r = await new HttpReranker('http://x/rerank', 'm').rerank('q', docs);
    expect(r[0]!.score).toBeCloseTo(0.9707, 3);
    expect(r[1]!.score).toBeLessThan(0.001);
  });

  it('envia a pergunta e os textos nos campos aceitos por TEI, llama.cpp e Cohere', async () => {
    const f = stubResponse([{ index: 0, score: 1 }, { index: 1, score: 0 }]);
    await new HttpReranker('http://x/rerank', 'bge', 'k').rerank('pergunta', docs);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ query: 'pergunta', texts: ['trecho a', 'trecho b'], documents: ['trecho a', 'trecho b'], model: 'bge' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('Voyage recebe só query e documents', async () => {
    const f = stubResponse({ data: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.2 }] });
    await new HttpReranker('https://api.voyageai.com/v1/rerank', 'rerank-3', 'k').rerank('q', docs);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ model: 'rerank-3', query: 'q', documents: ['trecho a', 'trecho b'] });
  });
});
