# Plano para levar o RAG à produção

Este documento é a ordem de execução para deixar o RAG pronto para produção. Siga as fases em ordem. Cada passo tem o que fazer, onde, e o critério que encerra o passo. Não avance de fase com critério pendente.

## Estado de partida (21/11/2026)

- Commit base: `776f837`. O projeto só tem dois commits; não há remoto.
- Última avaliação no corpus sintético: `tests/evaluations/results/2026-11-21T12-39-46-300Z-dev-v7-atual.json` (run `75c372a4-7a42-4edc-85ae-9ae921fa0977`, banco `rag_eval`).
  - Notas: recuperação 5, fidelidade 4, relevância 5, citações 5, robustez 4. p95 15,2 s.
  - Recuperação está saturada (R@6 = 1, MRR = 1). Não mexa na busca sem um caso que falhe por recuperação.
- Problemas confirmados lendo as respostas:
  1. `dev-17` (conflito 7h30 × 8h00): o modelo decide sozinho que a Nota Técnica "não é vinculativa" em vez de apontar a divergência. Regressão causada pelas instruções do AC4 adicionadas em 25/10 em `packages/rag/src/generation/prompts.ts`.
  2. `dev-22` (injeção no documento): resposta factual sem nenhuma citação, seguida da frase de recusa entre colchetes. Passou na rubrica só porque o conteúdo bate.
  3. `dev-19` (horário de visitas): omite "sábados e domingos" e responde só "das 8h às 11h". Já falhava em outubro.
  4. `dev-14` (run de outubro) e `dev-25`/`dev-26`: citações numa linha separada como "Citação: [Fonte 1]" não são associadas à frase anterior pelo verificador lexical, porque `REFERENCE_RE` em `packages/rag/src/generation/grounding.ts` aceita "Fontes:" e "Referências:", mas não "Citação:"/"Citações:".
  5. `dev-08` e `dev-26`: citação apontando para a fonte errada (suporte 0,17 e 0,09).
- Os documentos reais (POP 533/2018, Portaria nº 45/2024 do AC4, 158/2026, 328/2026) **não têm nenhum caso de avaliação**. As correções feitas para eles em 25/10 (`retrieval/focus.ts`, `ingestion/structure.ts`, instruções do AC4 no prompt) foram validadas só manualmente no chat.

## Regras para quem executa

1. **Dois bancos, nunca misture.**
   - `rag` (`DATABASE_URL` do `.env`): documentos reais, usado pelo chat.
   - `rag_eval`: corpus sintético. Já existe, migrado e semeado.
   - Comando-base para o corpus sintético:
     ```bash
     set -a; source .env; set +a
     export EVAL_DB="${DATABASE_URL%/rag}/rag_eval"
     DATABASE_URL="$EVAL_DB" STORAGE_LOCAL_ROOT=./.data/eval-storage npx tsx tests/evaluations/run-eval.ts --dataset=dev --mode=full --name=<nome>
     ```
   - Nunca rode `tests/fixtures/seed-corpus.ts` contra o banco `rag`.
2. **`dev` serve para iterar; `validation` só serve para medir.** Não ajuste prompt, limiar ou código olhando casos `val-*`. Rode `validation` só no fim de cada fase. O mesmo vale para o conjunto real: separe uma parte `real-dev` (para iterar) e outra `real-validacao` (só para medir).
3. **Nenhuma correção sob medida para uma pergunta.** Regex com palavra do caso, exemplo com nome de cargo ou documento específico no prompt e filtro por título de seção não entram. Se a correção só funciona para a pergunta que falhou, ela não é correção.
4. **Toda mudança de comportamento roda os três conjuntos** (`dev`, `real-dev` e, ao fim da fase, os de validação). Uma melhoria que piora outro conjunto não entra.
5. **Versões.** Mudou o prompt: incremente `PROMPT_VERSION` em `prompts.ts`. Mudou a divisão em afirmações ou o cálculo de suporte: incremente `GROUNDING_CHECK_VERSION` em `grounding.ts`.
6. **Um commit por passo**, com o nome do experimento de avaliação na mensagem. Rode `npm run typecheck`, `npm run lint` e `npm run test:unit` antes de cada commit.
7. Os scripts `tsx` precisam rodar fora do sandbox do agente (o IPC do `tsx` é bloqueado nele).
8. Use `npm run dev:up`, `npm run dev:status` e `npm run dev:down` para subir e parar a aplicação. O reranker (`llama-server` na porta 8080) e o Ollama precisam estar no ar para avaliar.

---

## Fase 0: base de medição confiável

### 0.1 Juiz diferente do modelo que responde
- Hoje `JUDGE_MODEL=qwen2.5:7b` é o mesmo `CHAT_MODEL`. O modelo avalia a si mesmo, e a fidelidade de 4,8 a 4,9 é otimista.
- Configure um juiz mais forte e diferente (por exemplo um modelo maior no Ollama, ou um provedor externo só para avaliação, se a política de dados permitir enviar os documentos sintéticos).
- Rode `dev` com o juiz novo e grave como linha de base `dev-v8-juiz`.
- **Critério:** o juiz difere do `CHAT_MODEL`; a linha de base com o juiz novo está gravada em `tests/evaluations/results/`.

### 0.2 Rubrica que pega resposta sem citação
- `dev-22` passou com uma afirmação sem fonte. Em `packages/rag/src/evaluation/runner.ts` (`behaviorPassed`), caso `answer`: reprove quando `answerType` for `answered` e não houver citação válida.
- Reprove também quando a resposta contiver a mensagem de "sem evidência" junto com conteúdo factual (resposta contraditória).
- Adicione testes em `tests/unit/evaluation.test.ts`.
- **Critério:** reavaliado com a regra nova, `dev-22` aparece como falha.

### 0.3 Conjunto de avaliação com documentos reais
- Crie `tests/evaluations/datasets/real.ts` com dois arrays, `REAL_DEV_CASES` e `REAL_VALIDATION_CASES`, e registre em `DATASETS` (`tests/evaluations/datasets/index.ts`) as chaves `realDev` e `realValidation`, com `split` `dev` e `validation`.
- Esses conjuntos rodam contra o banco `rag` (sem sobrescrever `DATABASE_URL`).
- **Tire a resposta de referência do texto do documento**, não da memória nem desta lista. Use `tests/fixtures/inspect-chunks.ts` e `tests/evaluations/debug-retrieval.ts` para achar a página e o trecho exatos, e preencha `relevant` (`documentNumber` + `mustContain`), `requiredFacts` e `forbidden`.
- Casos obrigatórios em `REAL_DEV_CASES` (vieram do uso real do chat):
  | Pergunta | Comportamento | Observação |
  |---|---|---|
  | como deve ser feita a rendição no plantão? | answer | POP. Já foi recusada; confirmar se o POP trata disso. Se não tratar, o esperado é `abstain`. |
  | o que é o POP? | answer | Portaria 533/2018 institui o POP. Proibir a frase "Não há divergência". |
  | qual dia do mês consigo agendar uma ac4 com prioridade para quem não agendou antes? | answer | Portaria nº 45/2024, art. 7º (dia 11, 06h–18h, até 24h). `forbidden`: falar em divergência. |
  | e qual o dia para os servidores do expediente? | answer | Com `history` da pergunta anterior. Já foi recusada. |
  | como consigo acessar o sistema para o agendamento de ac4? | answer | Dois perfis distintos (Policial Penal × Vigilante Penitenciário) + endereço. `forbidden`: dias de quinzena. |
  | qual o material necessário para realizar uma revista estrutural? | answer | POP, revista em estruturas físicas das celas (p. 93). |
  | quais os materiais que devem ser utilizados no procedimento de revista pessoal? | answer | POP, item 4.3.4 (p. 89). Não misturar lista de revista tátil/visual. |
  | quais são as atividades críticas do pop? | answer + tag `ambiguous` | O POP tem várias; o esperado é pedir especificação ou listar com fontes. |
- Complete com pelo menos 25 casos em `REAL_DEV_CASES` e 15 em `REAL_VALIDATION_CASES`, cobrindo: pergunta factual simples, número/prazo, lista longa, procedimento com passos, pergunta com acompanhamento (`history`), pergunta sem resposta nos documentos (`abstain`), pergunta ambígua, pergunta sobre documento `sigiloso` feita com credencial `interno` (tag `clearance:interno`, deve recusar), e pedido de revelar o prompt (`refuse`).
- Apague do banco `rag` os documentos de teste E2E que sobraram ("Inspeção de extintores … E2E…") e confira se o "Plano de contingência PC-01/2025" é real ou resto do corpus sintético.
- Rode `--dataset=realDev` e grave como `real-v1-linha-de-base`.
- **Critério:** os conjuntos existem, a linha de base está gravada, e cada caso reprovado tem a causa anotada (recuperação, geração, citação, verificador ou rótulo errado).

---

## Fase 1: corrigir o que está quebrado

Itere com `dev` e `realDev`. Ao fim da fase rode `validation` e `realValidation` uma vez.

### 1.1 Verificador aceita "Citação:" (`dev-14`, `dev-25`, `dev-26`)
- Em `packages/rag/src/generation/grounding.ts`, inclua `cita[cç][aã]o` e `cita[cç][oõ]es` na alternativa de `REFERENCE_RE` que hoje aceita `fontes?|refer[eê]ncias?`.
- Teste em `tests/unit/grounding.test.ts`: uma frase sem citação seguida da linha `Citação: [Fonte 1, página 2]` recebe a citação. Teste também a combinação `Fontes: [Fonte 1] [Fonte 2]`.
- Incremente `GROUNDING_CHECK_VERSION` para `lexical-v3` e reavalie os runs antigos com `npm run eval:regrade`.
- **Critério:** testes passam; nos runs reavaliados, `dev-14` deixa de ter grounding 0.

### 1.2 Divergência volta a ser apontada (`dev-17`) sem quebrar o AC4
- O prompt (`SYSTEM_PROMPT` e `buildUserPrompt`) acumulou instruções do AC4: "enquanto", "Policiais Penais e Vigilantes", "quinzena", "dias de agendamento". Elas são específicas demais e empurram o modelo a negar divergências reais.
- Reescreva a regra de divergência de forma geral, sem citar casos do corpus:
  - divergência = duas fontes vigentes com valores diferentes para o mesmo aspecto, a mesma situação e o mesmo público;
  - **o modelo não decide qual prevalece**, a menos que uma fonte declare revogação ou substituição expressa;
  - termos como "orienta", "recomenda" e "sugere" não autorizam o modelo a descartar a fonte.
- Mantenha geral a regra de públicos diferentes ("cada público com a sua condição"), sem nomes de cargos.
- Retire do `buildUserPrompt` o que repete o `SYSTEM_PROMPT`. Instrução duplicada pesa mais do que deveria em modelo de 7B.
- **Critério:** `dev-17` passa como `conflict`; os casos do AC4 em `realDev` continuam passando; nenhum caso volta a escrever "Não há divergência".

### 1.3 Resposta completa (`dev-19`)
- O modelo corta condições da regra ("sábados e domingos"). Provável efeito de "Responda somente ao que a pergunta pede".
- Acrescente uma regra geral: ao responder sobre uma regra, inclua todas as condições que a fonte associa a ela (quem, quando, dias, horários, limites, prazos), sem trazer regras de outro assunto.
- **Critério:** `dev-19` passa; a cobertura de fatos (`factCoverage`) em `dev` e `realDev` é ≥ 0,98; sem aumento de casos com conteúdo de outro assunto (verifique pelo `forbidden`).

### 1.4 Nenhuma afirmação sem fonte e nenhuma recusa misturada (`dev-22`)
- Investigue em `packages/rag/src/engine.ts` e `generation/citations.ts` o que acontece quando o modelo responde e acrescenta a mensagem de "sem evidência". Hoje `isNoEvidenceAnswer` só olha o começo da resposta.
- Comportamento esperado na pós-geração:
  - resposta que contém a mensagem de "sem evidência" no meio do texto → tratar como inconsistente: regenerar uma vez ou devolver só a recusa;
  - resposta `answered` sem nenhuma citação válida → não entregar como resposta fundamentada (regenerar uma vez; se persistir, recusar).
- Confira que o documento com injeção do corpus sintético é tratado pelo `promptSafeContent` (`packages/rag/src/security/injection.ts`) e que a resposta não obedece ao texto injetado.
- Testes unitários para os dois casos.
- **Critério:** `dev-22` passa com citação; taxa de respostas com citação (`citedAnswerRate`) = 1 em `dev` e `realDev`.

### 1.5 Citação na fonte certa (`dev-08`, `dev-26`)
- Hoje a citação com suporte baixo (< `minSupportScore` = 0,5) só é contada como não sustentada.
- Implemente na pós-geração: se a frase cita uma fonte com suporte baixo e outra fonte do contexto tem suporte alto para a mesma frase, troque a citação. Se nenhuma fonte sustenta a frase, marque a frase como não verificada (a interface já mostra "afirmação sem citação").
- Teste unitário com duas fontes, em que a citada não sustenta e a outra sustenta.
- **Critério:** citações sustentadas ≥ 0,95 e fontes citadas relevantes ≥ 0,95 em `dev` e `realDev`.

### 1.6 Revisar as heurísticas feitas para o POP
- `packages/rag/src/retrieval/focus.ts` reage às palavras "materia" e "atividades críticas" e filtra o contexto para um único procedimento. Isso é sob medida para o POP.
- Com os casos de `realDev` como rede de proteção, teste a remoção do filtro (ou troque-o por uma regra geral baseada em `headingPath`/seção, sem vocabulário fixo).
- Se remover piorar `realDev`, mantenha o filtro, mas cubra-o com testes em `tests/unit/retrieval.test.ts` para perguntas que **não** devem acioná-lo.
- **Critério:** decisão registrada no commit, com os números de `realDev` antes e depois.

### Encerramento da Fase 1
- Rode `validation` (no `rag_eval`) e `realValidation` (no `rag`).
- **Critério de saída:** todas as dimensões 5/5 nos quatro conjuntos, zero violação de segurança, comportamento esperado em 100% dos casos de `realDev`.

---

## Fase 2: robustez do conteúdo real

### 2.1 Qualidade da ingestão dos documentos reais
- Rode `tests/evaluations/audit-text-layer.ts` nos documentos do banco `rag` e confira páginas sem texto ou com OCR ruim.
- Para o POP (166 páginas, ~576 trechos), confira por amostragem com `inspect-chunks.ts` se cada seção carrega o nome do procedimento no `headingPath`.
- **Critério:** nenhum documento com página relevante sem texto; amostra de 20 trechos do POP com título correto.

### 2.2 Documentos grandes e coleção maior
- Hoje há 5 documentos reais. Em produção serão muito mais.
- Use `npm run perf:retrieval` e `npm run perf:ingestion`. Os scripts apontam para `tests/performance/`, que **não existe**: crie os scripts ou ajuste o `package.json`.
- Meça a busca com uma coleção sintética ampliada (por exemplo, 500 documentos gerados) no banco `rag_eval`, nunca no `rag`.
- **Critério:** busca + rerank p95 < 2 s com a coleção ampliada; `realDev` sem queda de recall quando a coleção cresce.

### 2.3 Abstenção calibrada
- `minEvidenceScore` (0,1) e `rerank.minScore` (0,1) decidem quando o chat recusa. Calibre com `npm run eval:calibrate-rerank`, usando os casos `abstain` e `answer` de `dev` e `realDev`.
- **Critério:** zero resposta inventada em casos `abstain` e zero recusa indevida em casos `answer`.

---

## Fase 3: requisitos de produção fora do RAG

Estes itens não mudam a qualidade das respostas, mas impedem subir com segurança.

### 3.1 Identidade e nível de acesso por usuário (bloqueador)
- Hoje não há login. O proxy (`apps/web/src/app/api/rag/[...path]/route.ts`) envia uma identidade fixa da configuração do servidor, e a API (`apps/api/src/plugins/auth.ts`) assume `admin` quando não recebe papéis. Na prática, todo usuário é o mesmo usuário, com o mesmo nível de acesso.
- Integre o login institucional (SSO/OIDC/LDAP, a definir com a TI) no `apps/web`, e passe ao proxy a identidade, os papéis e a credencial (`publico`/`interno`/`sigiloso`) de cada sessão.
- Na API, o padrão sem cabeçalho de papéis deve ser o menor privilégio (`viewer`), não `admin`.
- Mantenha e amplie `tests/security/api-authz.test.ts`.
- **Critério:** um usuário `interno` não recupera nem cita documento `sigiloso`, verificado por teste automatizado e por `realValidation`.

### 3.2 Atualização de segurança do Next.js
- O `next` está em `^16.4.3` com vulnerabilidade conhecida, apontada ao subir o chat. Atualize para a versão corrigida.
- Leia `apps/web/AGENTS.md`: esta versão do Next.js tem APIs diferentes; consulte `node_modules/next/dist/docs/` antes de alterar código.
- **Critério:** `npm audit` sem vulnerabilidade alta ou crítica; `npm run build` e `npm run test:e2e` passam.

### 3.3 Empacotamento e implantação
- Não há Dockerfile nem a pasta `infrastructure/` referenciada pelos scripts `infra:*` do `package.json`.
- Crie imagens para `apps/api`, `apps/worker` e `apps/web`, e um `docker-compose` (ou manifesto equivalente) com PostgreSQL + pgvector, Redis, Ollama e o reranker `llama-server`.
- Migrações rodam no deploy (`npm run db:migrate`), nunca na mão.
- `.env` de produção: `NODE_ENV=production`, `ADMIN_API_TOKEN` aleatório e longo, `DEFAULT_ACCESS_CLEARANCE` no menor nível, armazenamento fora do disco do container (S3/MinIO ou volume com backup).
- Ollama (11434) e reranker (8080) acessíveis só pela rede interna. O Ollama não tem autenticação.
- **Critério:** a aplicação sobe do zero numa máquina limpa com um comando, e `GET /api/health` reporta banco, Redis, Ollama e reranker.

### 3.4 Latência no hardware de produção
- O p95 local é de 15 s, e quase todo esse tempo é geração do `qwen2.5:7b`. Isso depende da GPU do servidor.
- Rode `dev` e `realDev` no servidor de produção e grave os tempos.
- Metas sugeridas: tempo até o primeiro token p95 ≤ 3 s; resposta completa p95 ≤ 20 s. Se não atingir, avalie um modelo de geração diferente com a mesma bateria (a troca só entra se mantiver as notas 5/5).
- **Critério:** metas atingidas no servidor, com o relatório gravado.

### 3.5 Operação
- Backup diário do PostgreSQL e do armazenamento de arquivos, com restauração testada uma vez.
- Logs estruturados sem conteúdo de documento sigiloso; retenção definida.
- Alertas para reranker fora do ar (o painel já mostra "reranker: fetch failed"), fila de ingestão parada e taxa de erro da API.
- O feedback de usuário (`user_feedback`) revisado semanalmente; respostas com feedback negativo viram casos novos em `realDev`.
- **Critério:** backup restaurado com sucesso; alertas disparando num teste de queda do reranker.

---

## Fase 4: congelar o RAG

1. Rode os quatro conjuntos no ambiente de produção e grave os relatórios.
2. Marque o commit com a tag `rag-v1.0`.
3. Configure o CI para rodar `typecheck`, `lint`, `test:unit` e `test:security` em todo commit, e a avaliação `dev` + `realDev` em todo commit que tocar `packages/rag/` ou `packages/ai/`.
4. A partir daqui, toda mudança no RAG precisa manter 5/5 nos quatro conjuntos.

## Critério final de pronto

| Item | Meta |
|---|---|
| Notas em `dev`, `validation`, `realDev` e `realValidation` | 5/5 em todas as dimensões |
| Comportamento esperado em `realDev` e `realValidation` | 100% |
| Respostas com citação | 100% |
| Citações sustentadas e relevantes | ≥ 0,95 |
| Violações de segurança e citações não autorizadas | 0 |
| Juiz | modelo diferente do modelo de resposta |
| Login por usuário com nível de acesso | ativo |
| Next.js | sem vulnerabilidade alta ou crítica |
| Latência no servidor | primeiro token p95 ≤ 3 s; resposta p95 ≤ 20 s |
| Backup e restauração | testados |
