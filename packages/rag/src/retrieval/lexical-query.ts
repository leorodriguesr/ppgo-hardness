/**
 * Extração de identificadores para busca exata: números de atos (123/2025), artigos,
 * siglas (DGAP, POP, EPI) e números relevantes. Gera uma tsquery literal (lexemas entre aspas)
 * compatível com a configuração `simple_unaccent`.
 */
export interface ExtractedIdentifiers {
  actNumbers: string[];
  articles: string[];
  acronyms: string[];
  numbers: string[];
}

const unaccent = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function extractIdentifiers(query: string): ExtractedIdentifiers {
  const actNumbers = [...query.matchAll(/\b(\d{1,6})\s*\/\s*(\d{2,4})\b/g)].map((m) => `${m[1]}/${m[2]}`);
  const articles = [...query.matchAll(/\b(?:art(?:igo)?s?\.?)\s*(\d{1,4})\s*[º°o]?/gi)].map((m) => m[1]!);
  const acronyms = [...query.matchAll(/\b([A-ZÁÉÍÓÚÂÊÔÃÕÇ]{2,}(?:-[A-Z]{2,})?)\b/g)]
    .map((m) => m[1]!)
    .filter((a) => !['NAO', 'NÃO', 'QUE', 'COM', 'PARA', 'UMA', 'DOS', 'DAS'].includes(a));
  const withoutActs = query.replace(/\b\d{1,6}\s*\/\s*\d{2,4}\b/g, ' ');
  const numbers = [...withoutActs.matchAll(/\b(?:n[º°o.]?\s*)?(\d{2,6})\b/gi)].map((m) => m[1]!);
  const uniq = (a: string[]) => [...new Set(a)];
  return { actNumbers: uniq(actNumbers), articles: uniq(articles), acronyms: uniq(acronyms), numbers: uniq(numbers) };
}

const quote = (lexeme: string) => `'${unaccent(lexeme).toLowerCase().replace(/'/g, "''").replace(/\\/g, '')}'`;

/** Monta a tsquery (texto) de identificadores, ou null se não houver nenhum. */
export function identifierTsQuery(ids: ExtractedIdentifiers): string | null {
  const terms: string[] = [];
  for (const a of ids.actNumbers) terms.push(quote(a));
  for (const n of ids.articles) terms.push(`( 'art' <-> ( ${quote(n)} | ${quote(`${n}º`)} | ${quote(`${n}o`)} ) )`);
  for (const a of ids.acronyms) terms.push(quote(a));
  for (const n of ids.numbers) terms.push(quote(n));
  return terms.length ? terms.join(' | ') : null;
}
