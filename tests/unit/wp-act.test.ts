import { decideSiteUpdate, parseWpPost, preferDescription, type StoredSiteAct } from '@rag/shared';
import { describe, expect, it } from 'vitest';

const indexed: StoredSiteAct = {
  source: 'legisla',
  externalId: 13905,
  fileKind: 'legisla',
  contentHash: 'abc',
  validityStatus: 'vigente',
  revokedBy: null,
  status: 'ingerido',
  documentId: 'doc-1',
};

describe('publicação do site', () => {
  it('lê o link do Legisla, a ementa e não trata a revogação feita pelo próprio ato', () => {
    const act = parseWpPost({
      id: 173074,
      link: 'https://www.policiapenal.go.gov.br/sem-categoria/portaria-no-45-de-16-de-fevereiro.html',
      modified: '2024-02-23T23:01:03',
      title: 'Portaria nº 45, de 16 de fevereiro de 2024',
      categories: ['Portarias', 'Sem categoria'],
      html: `<p>Institui diretrizes para o agendamento de serviço extraordinário e revoga a Portaria n.º 336, de 18 de outubro de 2023.</p>
        <p>O DIRETOR-GERAL DE POLÍCIA PENAL, no uso das atribuições, RESOLVE:</p>
        <a href="https://legisla.casacivil.go.gov.br/pesquisa_ato_infralegal/dgpp/13905/portaria-45">Legisla</a>
        <a href="https://www.policiapenal.go.gov.br/wp-content/uploads/2025/03/Portaria-no-45.pdf">PDF</a>`,
    });
    expect(act).toMatchObject({
      documentType: 'portaria',
      documentNumber: '45/2024',
      publicationDate: '2024-02-16',
      legislaId: 13905,
      revokedBy: null,
      category: 'Portarias',
    });
    expect(act.description).toContain('Institui diretrizes');
    expect(act.pdfUrl).toContain('Portaria-no-45.pdf');
  });

  it('ignora o link da portaria citada e fica com o Legisla do próprio ato', () => {
    const act = parseWpPost({
      id: 186241,
      link: 'https://www.policiapenal.go.gov.br/atos-normativos/portarias/portaria-dgpp-no-255-de-24-de-julho-de-2026.html',
      modified: '2026-07-24T17:41:43',
      title: 'Portaria DGPP nº 255, de 24 de julho de 2026',
      categories: ['Portarias'],
      html: `<p>Altera a Portaria nº 45.</p>
        <a href="https://legisla.casacivil.go.gov.br/pesquisa_ato_infralegal/dgpp/13905/portaria-45">45</a>
        <a href="https://legisla.casacivil.go.gov.br/pesquisa_ato_infralegal/dgpp/24733/portaria-255">255</a>`,
    });
    expect(act.legislaId).toBe(24733);
    expect(act.documentNumber).toBe('255/2026');
  });

  it('reconhece o aviso de revogação e prefere o PDF do ato ao extrato', () => {
    const act = parseWpPost({
      id: 170310,
      link: 'https://www.policiapenal.go.gov.br/atos-normativos/portarias/portaria-no-459.html',
      modified: '2024-12-09T15:48:00',
      title: 'Portaria nº 459, de 09 de dezembro de 2024',
      categories: ['Portarias'],
      html: `<p>PORTARIA Nº 459, DE 09 DE DEZEMBRO DE 2024 ( REVOGADO PELA PORTARIA Nº 104, DE 25 DE FEVEREIRO DE 2025 ) Designa gestor para o contrato.</p>
        <a href="https://www.policiapenal.go.gov.br/wp-content/uploads/2024/12/Extrato-da-Portaria-no-459-2024-DGPP.pdf">extrato</a>
        <a href="https://www.policiapenal.go.gov.br/wp-content/uploads/2024/12/Portaria-no-459.pdf">ato</a>`,
    });
    expect(act.revokedBy).toBe('PORTARIA Nº 104, DE 25 DE FEVEREIRO DE 2025');
    expect(act.pdfUrl).toContain('Portaria-no-459.pdf');
    expect(act.description).toContain('Designa gestor');
    expect(act.description).not.toMatch(/revogado pela/i);
  });
});

describe('ementa vinda do resumo da página', () => {
  it('não troca a ementa do PDF por um resumo que só informa o ano', () => {
    const confirmed = 'Altera a Portaria n.º 45, de 16 de fevereiro de 2024, que institui diretrizes para o agendamento de serviço extraordinário.';
    const summary = 'Altera a Portaria nº44, de 2024, que institui diretrizes para o agendamento de serviços extra remunerados.';
    expect(preferDescription(confirmed, summary)).toBe(confirmed);
    expect(preferDescription(null, summary)).toBe(summary);
    expect(preferDescription(confirmed, 'Altera a Portaria nº 46, de 02 de março de 2024.')).toBe('Altera a Portaria nº 46, de 02 de março de 2024.');
  });
});

describe('atualização de ato já cadastrado', () => {
  it('não indexa um ato novo e não rebaixa arquivo do Legisla para o PDF do site', () => {
    const fresh = parseWpPost({
      id: 1,
      link: 'https://www.policiapenal.go.gov.br/ato.html',
      modified: '2026-01-01T00:00:00',
      title: 'Portaria nº 3, de 02 de janeiro de 2026',
      categories: ['Portarias'],
      html: '<p>Dispõe sobre a escala de serviço dos policiais penais em exercício.</p><a href="https://www.policiapenal.go.gov.br/wp-content/uploads/2026/01/portaria-3.pdf">pdf</a>',
    });
    expect(decideSiteUpdate(null, fresh, 'hash').refresh).toBe(false);
    expect(decideSiteUpdate({ ...indexed, fileKind: 'legisla', contentHash: 'antes' }, { ...fresh, legislaId: null }, 'depois').fileKind).toBe('legisla');
  });

  it('reindexa só o PDF do site quando o ato já indexado muda, e a revogação dispensa o download', () => {
    const act = parseWpPost({
      id: 2,
      link: 'https://www.policiapenal.go.gov.br/ato.html',
      modified: '2026-02-01T00:00:00',
      title: 'Portaria nº 10, de 01 de fevereiro de 2026',
      categories: ['Portarias'],
      html: '<p>( REVOGADO PELA PORTARIA Nº 12, DE 02 DE FEVEREIRO DE 2026 ) Designa os fiscais do contrato firmado pela diretoria.</p><a href="https://www.policiapenal.go.gov.br/wp-content/uploads/2026/02/portaria-10.pdf">pdf</a>',
    });
    const changed = decideSiteUpdate({ ...indexed, source: 'site', fileKind: 'pdf', externalId: 2 }, { ...act, revokedBy: null }, 'novo');
    expect(changed.refresh).toBe(true);
    const revoked = decideSiteUpdate(indexed, act, 'novo');
    expect(revoked).toMatchObject({ validityStatus: 'revogado', refresh: false, revokeDocument: true });
  });
});
