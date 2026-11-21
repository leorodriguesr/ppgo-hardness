import { chatJson, countTokens, truncateToTokens, type ChatMessage, type ChatProvider } from '@rag/ai';
import { z } from 'zod';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface RewriteResult {
  query: string;
  rewritten: boolean;
  reason: 'no_history' | 'disabled' | 'standalone' | 'rewritten' | 'rejected_new_facts' | 'error';
}

const unaccent = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Termos "factuais" que uma reescrita não pode inventar: números, siglas e palavras capitalizadas. */
export function factualTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[./]\d+)*/g)) tokens.add(m[0]);
  for (const m of text.matchAll(/\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{2,}\b/g)) tokens.add(unaccent(m[0]));
  // Palavras capitalizadas no meio da frase (nomes próprios)
  for (const m of text.matchAll(/(?<=[\p{L}\d,;:]\s+)(\p{Lu}\p{Ll}{2,})/gu)) tokens.add(unaccent(m[1]!));
  return [...tokens];
}

/**
 * Verifica se a reescrita introduz fatos ausentes da pergunta e do histórico.
 * Retorna os termos introduzidos (lista vazia = reescrita aceita).
 */
export function introducedFacts(rewritten: string, sourceTexts: string[]): string[] {
  const haystack = unaccent(sourceTexts.join('\n'));
  return factualTokens(rewritten).filter((t) => !haystack.includes(unaccent(t)));
}

const DEPENDENT_RE =
  /\b(isso|isto|disso|nisso|esse|essa|esses|essas|desse|dessa|nesse|nessa|ele|ela|eles|elas|dele|dela|aquele|aquela|daquele|mesmo|mesma|anterior|acima|tamb[eé]m|e\s+(?:quanto|se|no\s+caso)|e\s+para|e\s+o|e\s+a|qual\s+o\s+prazo|quem\s+pode|neste\s+caso|nesse\s+caso)\b/i;

const TOPIC_STOP = new Set([
  'qual', 'quais', 'para', 'quem', 'como', 'com', 'uma', 'uns', 'que', 'dos', 'das', 'nao', 'antes', 'consigo', 'dia', 'mes',
  'prioridade', 'agendou', 'sobre', 'pelo', 'pela', 'pelos', 'pelas', 'isso', 'este', 'esta', 'esse', 'essa', 'quando', 'onde',
  'pode', 'podem', 'deve', 'devem', 'ser', 'sao', 'tem', 'mais', 'menos', 'entre', 'depois', 'muito', 'tambem', 'apenas',
  'somente', 'ainda', 'cada', 'todo', 'toda', 'voce', 'num', 'numa', 'por', 'nos', 'nas', 'aos', 'sem', 'sua', 'seu',
]);

/** Termos do assunto anterior que uma continuação com "e" precisa carregar para a busca. */
export function conversationTopicTerms(text: string): string[] {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    const n = unaccent(w);
    if (TOPIC_STOP.has(n)) continue;
    if (n.length < 5 && !/\d/.test(n)) continue;
    if (!out.some((x) => unaccent(x) === n)) out.push(w);
  }
  return out.slice(0, 6);
}

/**
 * Continuação curta ("e qual o dia...") não cita o assunto. Anexa os termos que faltam
 * da pergunta anterior, para a busca não perder o documento.
 */
export function withConversationTopic(question: string, candidate: string, history: HistoryTurn[]): string {
  if (!/^e\s+/i.test(question.trim())) return candidate;
  const prev = [...history].reverse().find((h) => h.role === 'user');
  if (!prev) return candidate;
  const hay = unaccent(candidate);
  const missing = conversationTopicTerms(prev.content).filter((t) => !hay.includes(unaccent(t)));
  if (missing.length === 0) return candidate;
  return `${candidate.replace(/[?\s.]+$/u, '')} ${missing.join(' ')}`.trim();
}
export function needsContext(question: string): boolean {
  const trimmed = question.trim();
  const words = trimmed.split(/\s+/).length;
  // "E qual o dia..." é acompanhamento mesmo quando a frase já passa de 6 palavras.
  return words <= 6 || /^e\s+/i.test(trimmed) || DEPENDENT_RE.test(trimmed);
}

/** Seleciona o histórico recente que cabe no orçamento de tokens (mais recentes têm prioridade). */
export function selectHistory(history: HistoryTurn[], maxMessages: number, tokenBudget: number): HistoryTurn[] {
  const recent = history.slice(-maxMessages);
  const out: HistoryTurn[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i]!;
    // Respostas longas do assistente são truncadas: interessa o tema, não o conteúdo integral
    const content = turn.role === 'assistant' ? truncateToTokens(turn.content, 200) : truncateToTokens(turn.content, 300);
    const t = countTokens(content);
    if (used + t > tokenBudget) break;
    out.unshift({ role: turn.role, content });
    used += t;
  }
  return out;
}

const schema = z.object({
  consulta: z.string().min(1).max(600),
});

const SYSTEM = `Você reformula perguntas de acompanhamento em consultas de busca autônomas sobre documentos institucionais.
Regras:
- Use o histórico apenas para resolver referências (ex.: "isso", "ele", "nesse caso") e continuações iniciadas por "E" (ex.: "e qual o dia...", "e para os servidores...").
- Uma continuação com "E" não é autônoma: inclua o assunto da pergunta anterior (documento, procedimento ou sistema citado).
- NÃO acrescente números, nomes, datas, siglas, documentos ou fatos que não estejam na pergunta ou no histórico.
- NÃO responda à pergunta; apenas reescreva-a.
- Se a pergunta já for autônoma e não depender do histórico, devolva-a sem alterações.
- Escreva em português, em uma única frase.
Responda somente com JSON: {"consulta": "..."}`;

export async function rewriteQuery(opts: {
  provider: ChatProvider;
  model: string;
  question: string;
  history: HistoryTurn[];
  enabled: boolean;
  signal?: AbortSignal;
}): Promise<RewriteResult> {
  const { question, history } = opts;
  if (!opts.enabled) return { query: question, rewritten: false, reason: 'disabled' };
  if (history.length === 0) return { query: question, rewritten: false, reason: 'no_history' };
  if (!needsContext(question)) return { query: question, rewritten: false, reason: 'standalone' };

  const finish = (query: string, rewritten: boolean, reason: RewriteResult['reason']): RewriteResult => {
    const queryWithTopic = withConversationTopic(question, query, history);
    if (queryWithTopic !== query) return { query: queryWithTopic, rewritten: true, reason: 'rewritten' };
    return { query, rewritten, reason };
  };

  const transcript = history.map((h) => `${h.role === 'user' ? 'Usuário' : 'Assistente'}: ${h.content}`).join('\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `<historico>\n${transcript}\n</historico>\n\n<pergunta>${question}</pergunta>` },
  ];
  try {
    const { data } = await chatJson(
      opts.provider,
      { model: opts.model, messages, temperature: 0, maxTokens: 200, operation: 'rewrite', signal: opts.signal },
      schema,
      'rewrite',
    );
    const candidate = data.consulta.trim();
    if (!candidate || candidate.length > Math.max(400, question.length * 6)) {
      return finish(question, false, 'error');
    }
    const added = introducedFacts(candidate, [question, ...history.map((h) => h.content)]);
    if (added.length > 0) return finish(question, false, 'rejected_new_facts');
    if (unaccent(candidate) === unaccent(question)) return finish(question, false, 'standalone');
    return finish(candidate, true, 'rewritten');
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return finish(question, false, 'error');
  }
}
