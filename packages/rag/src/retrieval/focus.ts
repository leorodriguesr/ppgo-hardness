import type { FusedCandidate } from './fusion';

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Seção pedida pela pergunta: a lista de material ou as atividades críticas, não o passo a passo. */
function sectionIntent(query: string): RegExp | null {
  const q = fold(query);
  // "materiais" não contém o trecho "material" (o plural troca o l por i).
  if (/\bmateria/.test(q)) return /^materia/i;
  if (/\batividades?\s+critic/.test(q)) return /^atividades critic/i;
  return null;
}

/** Linha numerada do procedimento, como "4.3.4 Revista Pessoal Minuciosa". */
function procedureName(path: string[]): string | null {
  return path.find((p) => /^\d/.test(p)) ?? null;
}

/**
 * Quando a pergunta pede o material ou as atividades críticas, fica só com a seção
 * do procedimento mais bem avaliado. Listas de procedimentos vizinhos (revista tátil,
 * revista visual) deixam de entrar no contexto e de serem misturadas na resposta.
 */
export function focusProcedureSection(query: string, ranked: FusedCandidate[]): FusedCandidate[] {
  const intent = sectionIntent(query);
  if (!intent || ranked.length === 0) return ranked;
  const best = ranked.find((c) => intent.test(fold(c.sectionTitle ?? '')));
  const procedure = best ? procedureName(best.headingPath) : null;
  if (!best || !procedure) return ranked;
  const same = ranked.filter((c) => c.headingPath.includes(procedure) && intent.test(fold(c.sectionTitle ?? '')));
  return same.length > 0 ? same : ranked;
}
