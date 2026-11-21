'use client';

import type { MessageDto, SourceDto } from '@rag/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, BookOpenText, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { streamChat } from '@/lib/sse';
import { Button } from '../ui/button';
import { Alert, Skeleton } from '../ui/primitives';
import { MessageItem, type ViewMessage } from './message-item';
import { SourcePanel, type OpenSource } from './source-panel';

const MAX_CHARS = 4000;
const EXAMPLES = [
  'Qual o efetivo mínimo para escolta de transferência entre unidades?',
  'Em quanto tempo deve ser registrada uma movimentação interna?',
  'Quais são os níveis de uso da força?',
];

function placeholderAssistant(conversationId: string, parentMessageId: string | null): ViewMessage {
  return {
    id: `pending-${crypto.randomUUID()}`,
    conversationId,
    role: 'assistant',
    content: '',
    status: 'streaming',
    answerType: null,
    rewrittenQuery: null,
    parentMessageId,
    citations: [],
    sources: [],
    grounding: null,
    feedback: null,
    createdAt: new Date().toISOString(),
  };
}

export function ChatView({ conversationId: initialId }: { conversationId?: string }) {
  const qc = useQueryClient();
  const [conversationId, setConversationId] = useState(initialId);
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [openSource, setOpenSource] = useState<OpenSource | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const history = useQuery({
    queryKey: ['messages', initialId],
    queryFn: () => api<{ conversation: { id: string; title: string }; items: MessageDto[] }>(`/conversations/${initialId}/messages`),
    enabled: !!initialId,
  });
  useEffect(() => {
    if (history.data && !busy) setMessages(history.data.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.data]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const patch = useCallback((id: string, fn: (m: ViewMessage) => ViewMessage) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m))), []);

  const run = useCallback(
    async (content: string, opts: { regenerateFromMessageId?: string; replaceId?: string } = {}) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      stickRef.current = true;
      let assistantId = '';
      const temp = placeholderAssistant(conversationId ?? '', null);
      assistantId = temp.id;
      if (opts.replaceId) {
        setMessages((ms) => ms.map((m) => (m.id === opts.replaceId ? temp : m)));
      } else {
        const userMsg: ViewMessage = { ...temp, id: `pending-user-${temp.id}`, role: 'user', content, status: 'completed' };
        setMessages((ms) => [...ms, userMsg, temp]);
      }
      try {
        await streamChat(
          { conversationId, content, regenerateFromMessageId: opts.regenerateFromMessageId },
          (e) => {
            switch (e.type) {
              case 'meta': {
                const oldUserTempId = `pending-user-${temp.id}`;
                // O updater roda depois da reatribuição de assistantId abaixo; por isso o id antigo é fixado aqui.
                const oldAssistantId = assistantId;
                setMessages((ms) =>
                  ms.map((m) => (m.id === oldAssistantId ? { ...m, id: e.assistantMessageId, conversationId: e.conversationId } : m.id === oldUserTempId ? { ...m, id: e.userMessageId } : m)),
                );
                assistantId = e.assistantMessageId;
                if (!conversationId) {
                  setConversationId(e.conversationId);
                  // Atualiza a URL sem remontar a tela durante o streaming
                  window.history.replaceState(null, '', `/chat/${e.conversationId}`);
                  void qc.invalidateQueries({ queryKey: ['conversations'] });
                }
                break;
              }
              case 'status':
                patch(assistantId, (m) => ({ ...m, stage: e.stage }));
                break;
              case 'sources':
                patch(assistantId, (m) => ({ ...m, sources: e.sources }));
                break;
              case 'token':
                patch(assistantId, (m) => ({ ...m, content: m.content + e.text }));
                break;
              case 'done':
                patch(assistantId, () => e.message);
                break;
              case 'error':
                patch(assistantId, (m) => ({ ...m, status: 'error', errorText: e.message }));
                break;
            }
          },
          controller.signal,
        );
        // Stream encerrado sem "done" nem "error" (ex.: conexão interrompida)
        setMessages((ms) => ms.map((m) => (m.id === assistantId && m.status === 'streaming' ? { ...m, status: 'error', errorText: 'A conexão foi interrompida antes do fim da resposta.' } : m)));
      } catch (err) {
        if (controller.signal.aborted) {
          patch(assistantId, (m) => ({ ...m, status: 'cancelled' }));
        } else {
          patch(assistantId, (m) => ({ ...m, status: 'error', errorText: errorMessage(err) }));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        void qc.invalidateQueries({ queryKey: ['conversations'] });
      }
    },
    [conversationId, patch, qc],
  );

  const submit = (text = input) => {
    const content = text.trim();
    if (!content || busy || content.length > MAX_CHARS) return;
    setInput('');
    void run(content);
  };

  const regenerate = (assistant: ViewMessage) => {
    const idx = messages.findIndex((m) => m.id === assistant.id);
    const question = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
    if (!question) return;
    const persisted = !assistant.id.startsWith('pending-');
    void run(question.content, { regenerateFromMessageId: persisted ? assistant.id : question.id.startsWith('pending-') ? undefined : question.id, replaceId: assistant.id });
  };

  const onCite = (source: SourceDto, page: number | null) => setOpenSource({ source, page });
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
            {history.isLoading && (
              <div className="space-y-3">
                <Skeleton className="ml-auto h-10 w-1/2" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}
            {history.isError && <Alert variant="destructive">{errorMessage(history.error)}</Alert>}
            {!initialId && messages.length === 0 && (
              <div className="flex flex-col items-center gap-4 py-12 text-center">
                <BookOpenText className="size-10 text-muted-foreground" />
                <div>
                  <h1 className="text-lg font-semibold">Consulte os documentos institucionais</h1>
                  <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                    As respostas são baseadas exclusivamente nos documentos cadastrados, com citação da fonte e da página. Quando não houver base documental, o assistente informará.
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {EXAMPLES.map((ex) => (
                    <Button key={ex} variant="outline" size="sm" className="h-auto py-1.5 whitespace-normal" onClick={() => submit(ex)}>
                      {ex}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                isLast={m.id === lastAssistant?.id}
                busy={busy}
                onCite={onCite}
                onRegenerate={() => regenerate(m)}
                onFeedback={(v) => patch(m.id, (x) => ({ ...x, feedback: v }))}
              />
            ))}
          </div>
        </div>
        <div className="border-t bg-background p-3">
          <form
            className="mx-auto flex max-w-3xl items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="relative flex-1">
              <label htmlFor="question" className="sr-only">
                Pergunta
              </label>
              <textarea
                id="question"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={Math.min(6, Math.max(1, input.split('\n').length))}
                maxLength={MAX_CHARS}
                placeholder="Digite sua pergunta… (Enter envia, Shift+Enter quebra linha)"
                className="w-full resize-none rounded-xl border border-input bg-background px-3.5 py-2.5 pr-14 text-sm shadow-xs placeholder:text-muted-foreground"
              />
              {input.length > MAX_CHARS * 0.8 && (
                <span className="absolute right-3 bottom-2 text-[10px] text-muted-foreground">
                  {input.length}/{MAX_CHARS}
                </span>
              )}
            </div>
            {busy ? (
              <Button type="button" size="icon" variant="secondary" onClick={() => abortRef.current?.abort()} aria-label="Parar geração">
                <Square className="fill-current" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!input.trim()} aria-label="Enviar pergunta">
                <ArrowUp />
              </Button>
            )}
          </form>
          <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted-foreground">
            Confira sempre as fontes citadas. O assistente não substitui a leitura do documento oficial.
          </p>
        </div>
      </div>
      {openSource && (
        <div className="fixed inset-0 z-40 md:static md:z-auto">
          <SourcePanel open={openSource} onClose={() => setOpenSource(null)} />
        </div>
      )}
    </div>
  );
}
