/**
 * Heurísticas para identificar texto com formato de instrução dirigida ao modelo.
 * A detecção não bloqueia conteúdo de documentos (que pode citar tais frases legitimamente);
 * ela sinaliza o trecho para que o prompt o trate explicitamente como dado não confiável.
 * A defesa principal é estrutural: delimitação das fontes e regras do sistema.
 */
const PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts?|rules)/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\s+/i,
  /\b(?:ignore|desconsidere|esque[cç]a|despreze)\s+(?:todas\s+)?(?:as\s+|os\s+)?(?:instru[cç][oõ]es|regras|orienta[cç][oõ]es|comandos)\s+(?:anteriores|acima|pr[eé]vias|do\s+sistema)/i,
  /\b(?:a\s+partir\s+de\s+agora|de\s+agora\s+em\s+diante)\s+(?:voc[eê]|tu)\s+(?:[eé]|ser[aá]|deve)/i,
  /\bvoc[eê]\s+(?:agora\s+)?(?:[eé]|deve\s+agir\s+como)\s+(?:um|uma)\s+(?:novo|nova|outro|outra)?\s*(?:assistente|ia|modelo|sistema)/i,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /\b(?:system|developer)\s*prompt\b/i,
  /\b(?:prompt|instru[cç][oõ]es)\s+(?:do|de)\s+sistema\b/i,
  /\b(?:revele|mostre|imprima|exiba|repita)\s+(?:(?:o|a|as|os|seu|sua|seus|suas)\s+){0,2}(?:prompt|instru[cç][oõ]es|regras)\b/i,
  /<\|?(?:im_start|im_end|system|endoftext)\|?>/i,
  /^\s*#{2,}\s*(?:system|instruction|instru[cç][aã]o)\b/im,
  /\[\s*(?:INST|SYS)\s*\]/,
  /\bresponda\s+(?:sempre|apenas|somente)\s+(?:com|que)\b/i,
  /\b(?:nova|novas)\s+instru[cç](?:[aã]o|[oõ]es)\s*:/i,
  /\bjailbreak\b|\bDAN\s+mode\b/i,
];

export function detectPromptInjection(text: string): { suspicious: boolean; matches: string[] } {
  const matches: string[] = [];
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) matches.push(m[0].slice(0, 80));
  }
  return { suspicious: matches.length > 0, matches };
}

export const INJECTION_PLACEHOLDER = '[trecho omitido pelo sistema: possível instrução dirigida ao assistente]';

/**
 * Remove, do texto enviado a modelos, as frases com formato de instrução ao assistente.
 * O conteúdo original permanece armazenado e visível ao usuário (com alerta); apenas a
 * cópia usada em prompts é neutralizada. Modelos pequenos (reranker) são especialmente
 * suscetíveis a esse tipo de texto mesmo com delimitação.
 */
export function neutralizeInjection(text: string): { text: string; removed: number } {
  if (!detectPromptInjection(text).suspicious) return { text, removed: 0 };
  let removed = 0;
  const out = text
    .split('\n')
    .map((line) => {
      if (!detectPromptInjection(line).suspicious) return line;
      // Frase a frase, para preservar o conteúdo legítimo da mesma linha
      return line
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => {
          if (!detectPromptInjection(sentence).suspicious) return sentence;
          removed++;
          return INJECTION_PLACEHOLDER;
        })
        .join(' ');
    })
    .join('\n');
  return { text: out, removed };
}

/** Texto seguro para prompts: neutraliza instruções embutidas e delimitadores. */
export function promptSafeContent(text: string): string {
  return escapeSourceContent(neutralizeInjection(text).text);
}

/** Neutraliza delimitadores usados no prompt para que o conteúdo não "feche" a tag da fonte. */
export function escapeSourceContent(text: string): string {
  return text
    .replace(/<\/?\s*(fonte|fontes|sistema|system|instrucoes|instruções|pergunta|historico|histórico)\b[^>]*>/gi, (m) =>
      m.replace(/</g, '‹').replace(/>/g, '›'),
    )
    .replace(/<\|/g, '‹|')
    .replace(/\|>/g, '|›');
}
