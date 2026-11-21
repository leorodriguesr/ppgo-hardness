import type { ChatStreamEvent } from '@rag/shared';
import { API_BASE, ApiError } from './api';

/** POST com resposta text/event-stream, entregando eventos tipados conforme chegam. */
export async function streamChat(body: unknown, onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-requested-with': 'rag-web' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `Erro ${res.status} ao iniciar a resposta.`;
    let code = 'HTTP_ERROR';
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string } };
      message = j.error?.message ?? message;
      code = j.error?.code ?? code;
    } catch {
      // sem corpo JSON
    }
    throw new ApiError(res.status, code, message);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue; // comentários de keep-alive
      onEvent(JSON.parse(data) as ChatStreamEvent);
    }
  }
}
