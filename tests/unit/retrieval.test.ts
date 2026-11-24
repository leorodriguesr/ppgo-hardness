import { dedupeCandidates, ementaListQuery, focusProcedureSection, formatEmentaAnswer, introducedFacts, needsContext, personNameCount, queryAsksForPeople, reciprocalRankFusion, withConversationTopic, type Candidate, type EmentaHit } from '@rag/rag';
import type { FusedCandidate } from '@rag/rag';
import { describe, expect, it } from 'vitest';

function fused(section: string, procedure: string, score: number): FusedCandidate {
  return { sectionTitle: section, headingPath: ['POP', procedure, section], rerankScore: score, content: section } as FusedCandidate;
}

describe('focusProcedureSection', () => {
  it('fica com o material do procedimento nomeado na pergunta', () => {
    const pessoal = fused('MATERIAL NECESSÁRIO', '4.3.4 Revista Pessoal Minuciosa', 0.98);
    const visual = fused('MATERIAL NECESSÁRIO', '4.3.1 Revista Visual', 0.94);
    const passos = fused('SEQUÊNCIA DAS AÇÕES', '4.3.4 Revista Pessoal Minuciosa', 0.86);
    expect(focusProcedureSection('quais os materiais da revista pessoal?', [pessoal, visual, passos])).toEqual([pessoal]);
  });

  it('não escolhe um procedimento quando a pergunta fala só do documento', () => {
    const criancas = fused('MATERIAL NECESSÁRIO', '4.2.1 Crianças e Adolescentes', 0.99);
    const celas = fused('MATERIAL NECESSÁRIO', '4.5 Revista em Estruturas Físicas das Celas', 0.9);
    expect(focusProcedureSection('qual o material necessário no POP?', [criancas, celas])).toEqual([criancas, celas]);
  });

  it('pede a sequência das ações só do procedimento nomeado', () => {
    const pessoal = fused('SEQUÊNCIA DAS AÇÕES', '4.3.4 Revista Pessoal Minuciosa', 0.9);
    const celas = fused('SEQUÊNCIA DAS AÇÕES', '4.5 Revista em Estruturas Físicas das Celas', 0.95);
    expect(focusProcedureSection('qual a sequência das ações da revista pessoal?', [celas, pessoal])).toEqual([pessoal]);
  });

  it('traz uma seção de cada procedimento quando a pergunta não nomeia nenhum', () => {
    const pessoal = fused('AÇÕES CORRETIVAS', '4.3.4 Revista Pessoal Minuciosa', 0.99);
    const outra = fused('AÇÕES CORRETIVAS', '4.3.4 Revista Pessoal Minuciosa', 0.98);
    const celas = fused('AÇÕES CORRETIVAS', '4.5 Revista em Estruturas Físicas das Celas', 0.5);
    expect(focusProcedureSection('quais as ações corretivas no POP?', [pessoal, outra, celas]).map((c) => c.headingPath[1])).toEqual([
      '4.3.4 Revista Pessoal Minuciosa',
      '4.5 Revista em Estruturas Físicas das Celas',
      '4.3.4 Revista Pessoal Minuciosa',
    ]);
  });

  it('não restringe uma pergunta que não pede uma seção', () => {
    const passos = fused('SEQUÊNCIA DAS AÇÕES', '4.3.4 Revista Pessoal Minuciosa', 0.9);
    expect(focusProcedureSection('como é feita a revista pessoal?', [passos])).toEqual([passos]);
  });

  it('não restringe pergunta sobre atividades que não são as críticas', () => {
    const criticas = fused('ATIVIDADES CRÍTICAS', '4.3.4 Revista Pessoal Minuciosa', 0.9);
    expect(focusProcedureSection('quais são as atividades do dia na unidade?', [criticas])).toEqual([criticas]);
  });
});


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

describe('relação de pessoas', () => {
  it('reconhece pergunta por pessoas e ignora pergunta por prazo', () => {
    expect(queryAsksForPeople('quais as pessoas que inspecionaram a Casa de Prisão Provisória?')).toBe(true);
    expect(queryAsksForPeople('quais os servidores possuem gratificação de risco de vida?')).toBe(true);
    expect(queryAsksForPeople('qual o prazo de defesa?')).toBe(false);
    expect(queryAsksForPeople('quais os materiais da revista pessoal?')).toBe(false);
  });

  it('conta nomes no trecho e não dispara continuação quando a relação já veio', () => {
    expect(personNameCount('Institui comissão para inspecionar a unidade.')).toBe(0);
    expect(
      personNameCount('Institui comissão para inspecionar a Unidade de Polícia Penal Regional Casa de Prisão Provisória da 1ª CRPP.'),
    ).toBe(0);
    expect(
      personNameCount('Designou Dr. Aurécio de Oliveira Lobo, Dra. Alessandra Ferreira Borges, Dra. Sueli Almeida Neves Sousa e Dr. Tiago Batista de Oliveira.'),
    ).toBeGreaterThanOrEqual(3);
  });
});

describe('lista por ementa', () => {
  it('pede as portarias de um assunto e ignora pergunta sobre pessoas ou um ato numerado', () => {
    expect(ementaListQuery('quais as portarias que concedem risco de vida?')).toEqual({ topic: 'risco vida', documentType: 'portaria' });
    expect(ementaListQuery('quais as pessoas que inspecionaram a Casa de Prisão Provisória?')).toBeNull();
    expect(ementaListQuery('quais os servidores que possuem gratificação por risco de vida?')).toBeNull();
    expect(ementaListQuery('o que diz a portaria 328/2026?')).toBeNull();
    expect(ementaListQuery('quais as portarias?')).toBeNull();
    expect(ementaListQuery('quero todas as portarias que tratam desse assunto')).toBeNull();
    expect(
      ementaListQuery('quero todas as portarias que tratam desse assunto', 'quais os servidores que possuem gratificação por risco de vida?'),
    ).toEqual({ topic: 'gratificação risco vida', documentType: 'portaria' });
  });

  it('lista cada portaria pelo título, sem repetir o número', () => {
    const hit = {
      title: 'Portaria DGPP nº 45/2026',
      documentNumber: '45/2026',
      documentType: 'portaria',
      description: 'Concede Gratificação de Risco de Vida.',
      validityStatus: 'vigente',
      publicationDate: '2026-01-01',
      documentId: 'doc',
      accessLevel: 'publico',
      chunkId: 'chunk',
      versionId: 'ver',
      pageStart: 1,
      pageEnd: 1,
      versionNumber: 1,
      isCurrentVersion: true,
    } satisfies EmentaHit;
    const { text, sources } = formatEmentaAnswer([hit], false, 'portaria');
    expect(text).toContain('Entre as portarias já indexadas, a ementa reúne 1 portaria vigente');
    expect(text).toContain('- Portaria DGPP nº 45/2026: Concede Gratificação de Risco de Vida. [Fonte 1, página 1] [Fonte 1, documento]');
    expect(text).not.toContain('45/2026 —');
    expect(sources).toHaveLength(1);
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
