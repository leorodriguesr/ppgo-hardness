import type { FusedCandidate } from './fusion';

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Seção pedida pela pergunta. Cada procedimento do POP tem a sua.
 * "materiais" não contém o trecho "material" (o plural troca o l por i).
 */
function sectionIntent(query: string): RegExp | null {
  const q = fold(query);
  if (/\bfundamenta/.test(q)) return /^fundamenta/;
  if (/\bsequencia\b/.test(q)) return /^sequencia/;
  if (/\bresultados?\s+esperad/.test(q)) return /^resultado/;
  if (/\bacoes\s+corretiv/.test(q)) return /^acoes corretiv/;
  if (/\bpossibilidades?\s+de\s+erros?\b/.test(q)) return /^possibilidade/;
  if (/\bmateria/.test(q)) return /^materia/;
  if (/\batividades?\s+critic/.test(q)) return /^atividades critic/;
  return null;
}

/** Linha numerada do procedimento, como "4.3.4 Revista Pessoal Minuciosa". */
function procedureName(path: string[]): string | null {
  return path.find((p) => /^\d/.test(p)) ?? null;
}

/** Palavras que aparecem em quase todo procedimento e não identificam um deles. */
const GENERIC = new Set([
  'revista', 'revistas', 'material', 'materiais', 'necessario', 'necessaria', 'procedimento', 'operacional',
  'padrao', 'sistema', 'controle', 'acesso', 'pessoa', 'pessoas', 'preso', 'presos', 'visita', 'visitas',
  'visitante', 'visitantes', 'processo', 'versao',
]);

function distinctive(text: string): string[] {
  return fold(text).split(/[^a-z0-9]+/).filter((t) => t.length >= 5 && !GENERIC.has(t));
}

/** A pergunta cita este procedimento, e não só "material" ou "POP". */
function namesProcedure(query: string, procedure: string): boolean {
  const q = distinctive(query);
  const p = distinctive(procedure);
  const stem = (t: string) => (t.length >= 6 ? t.slice(0, 6) : t);
  return p.some((pt) => q.some((qt) => qt === pt || stem(qt) === stem(pt)));
}

/** Uma seção de cada procedimento na frente, para o corte final não ficar só com o primeiro. */
function oneSectionPerProcedure(ranked: FusedCandidate[], intent: RegExp): FusedCandidate[] {
  const seen = new Set<string>();
  const heads: FusedCandidate[] = [];
  const rest: FusedCandidate[] = [];
  for (const c of ranked) {
    const procedure = procedureName(c.headingPath);
    if (procedure && intent.test(fold(c.sectionTitle ?? '')) && !seen.has(procedure)) {
      seen.add(procedure);
      heads.push(c);
    } else {
      rest.push(c);
    }
  }
  return heads.length > 1 ? [...heads, ...rest] : ranked;
}

/**
 * Quando a pergunta pede uma seção de um procedimento nomeado, fica só com ela.
 * Sem o procedimento ("material do POP", "sequência das ações"), traz uma seção
 * de cada procedimento, para a resposta não apresentar a de um só como se fosse a do documento.
 */
export function focusProcedureSection(query: string, ranked: FusedCandidate[]): FusedCandidate[] {
  const intent = sectionIntent(query);
  if (!intent || ranked.length === 0) return ranked;
  const named = new Set<string>();
  for (const c of ranked) {
    if (!intent.test(fold(c.sectionTitle ?? ''))) continue;
    const procedure = procedureName(c.headingPath);
    if (procedure && namesProcedure(query, procedure)) named.add(procedure);
  }
  if (named.size !== 1) return oneSectionPerProcedure(ranked, intent);
  const procedure = [...named][0]!;
  const same = ranked.filter((c) => c.headingPath.includes(procedure) && intent.test(fold(c.sectionTitle ?? '')));
  return same.length > 0 ? same : ranked;
}
