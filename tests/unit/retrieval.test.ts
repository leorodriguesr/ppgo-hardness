import { dedupeCandidates, focusProcedureSection, introducedFacts, needsContext, reciprocalRankFusion, withConversationTopic, type Candidate } from '@rag/rag';
import type { FusedCandidate } from '@rag/rag';
import { describe, expect, it } from 'vitest';

function cand(chunkId: string, extra: Partial<Candidate> = {}): Candidate {
  return {
    chunkId,
    documentId: extra.documentId ?? `doc-${chunkId}`,
    content: extra.content ?? `conteúdo ${chunkId}`,
    contentHash: extra.contentHash ?? `hash-${chunkId}`,
    isCurrentVersion: extra.isCurrentVersion ?? true,
    ...extra,
  } as Candidate;
}

describe('focusProcedureSection', () => {
  const chunk = (section: string, procedure: string, score: number): FusedCandidate =>
    ({ sectionTitle: section, headingPath: ['POP', procedure, section], rerankScore: score, content: section }) as FusedCandidate;

  it('fica com o material do procedimento mais bem avaliado', () => {
    const pessoal = chunk('MATERIAL NECESSÁRIO', '4.3.4 Revista Pessoal Minuciosa', 0.98);
    const visual = chunk('MATERIAL NECESSÁRIO', '4.3.1 Revista Visual', 0.94);
    const passos = chunk('SEQUÊNCIA DAS AÇÕES', '4.3.4 Revista Pessoal Minuciosa', 0.86);
    const out = focusProcedureSection('quais os materiais da revista pessoal?', [pessoal, visual, passos]);
    expect(out).toEqual([pessoal]);
  });

  it('não restringe uma pergunta que não pede uma seção', () => {
    const passos = chunk('SEQUÊNCIA DAS AÇÕES', '4.3.4 Revista Pessoal Minuciosa', 0.9);
    expect(focusProcedureSection('como é feita a revista pessoal?', [passos])).toEqual([passos]);
  });
});

describe('reciprocalRankFusion', () => {
  it('soma contribuições ponderadas e ordena pelo escore fundido', () => {
    const fused = reciprocalRankFusion(
      [
        { candidates: [cand('a'), cand('b')], weight: 1 },
        { candidates: [cand('b'), cand('c')], weight: 1 },
      ],
      60,
    );
    expect(fused.map((c) => c.chunkId)).toEqual(['b', 'a', 'c']);
    expect(fused[0]!.fusedScore).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it('ignora listas com peso zero e respeita pesos maiores', () => {
    const fused = reciprocalRankFusion(
      [
        { candidates: [cand('a')], weight: 1 },
        { candidates: [cand('b')], weight: 1.5 },
        { candidates: [cand('z')], weight: 0 },
      ],
      60,
    );
    expect(fused.map((c) => c.chunkId)).toEqual(['b', 'a']);
  });
});

describe('dedupeCandidates', () => {
  it('mantém a versão atual quando o conteúdo é idêntico', () => {
    const old = cand('old', { contentHash: 'h', isCurrentVersion: false });
    const cur = cand('cur', { contentHash: 'h', isCurrentVersion: true });
    expect(dedupeCandidates([old, cur]).map((c) => c.chunkId)).toEqual(['cur']);
  });

  it('remove quase-duplicatas do mesmo documento, mas não de documentos diferentes', () => {
    const text = 'A escolta de custodiados será realizada por no mínimo três policiais penais armados';
    const a = cand('a', { documentId: 'd1', content: text });
    const b = cand('b', { documentId: 'd1', content: `${text}.` });
    const c = cand('c', { documentId: 'd2', content: text });
    expect(dedupeCandidates([a, b, c]).map((x) => x.chunkId)).toEqual(['a', 'c']);
  });
});

describe('reescrita segura de consulta', () => {
  it('rejeita números e siglas que não estão na pergunta nem no histórico', () => {
    const facts = introducedFacts('Prazo de defesa na Portaria 101/2025 da DGPP', ['E qual o prazo de defesa?', 'Falamos sobre procedimento disciplinar.']);
    expect(facts).toEqual(expect.arrayContaining(['101/2025', 'dgpp']));
  });

  it('aceita reescrita que só resolve referências', () => {
    expect(introducedFacts('Qual o prazo de defesa no procedimento disciplinar?', ['E o prazo de defesa?', 'O procedimento disciplinar é instaurado em 5 dias.'])).toEqual([]);
  });

  it('identifica perguntas dependentes de contexto', () => {
    expect(needsContext('E nesse caso, quem autoriza?')).toBe(true);
    expect(needsContext('e qual o dia para os servidores do expediente?')).toBe(true);
    expect(needsContext('Qual o número mínimo de policiais penais em uma escolta hospitalar de custodiado?')).toBe(false);
  });

  it('leva o assunto da pergunta anterior para uma continuação com "e"', () => {
    const q = withConversationTopic(
      'e qual o dia para os servidores do expediente?',
      'e qual o dia do mês para os servidores do expediente?',
      [{ role: 'user', content: 'qual dia do mês consigo agendar uma ac4 com prioridade para quem não agendou antes?' }, { role: 'assistant', content: 'No dia 11.' }],
    );
    expect(q.toLowerCase()).toContain('ac4');
    expect(q.toLowerCase()).toContain('agendar');
    expect(q.toLowerCase()).not.toContain('prioridade');
  });
});
