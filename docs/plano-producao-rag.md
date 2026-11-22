# Plano para deixar o RAG funcionando perfeitamente

Este documento é a ordem de execução para deixar o RAG (busca, geração, citações e recusas) pronto. Siga as fases em ordem. Cada passo tem o que fazer, onde, e o critério que encerra o passo. Não avance de fase com critério pendente.

**Fora do escopo desta etapa:** login e nível de acesso por usuário, atualização do Next.js, empacotamento e implantação, latência no servidor de produção, backup e alertas. Tudo isso fica para a etapa de produção. Não altere `apps/web`, `apps/api/src/plugins/auth.ts` nem a infraestrutura.

## Estado de partida (21/11/2026)

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
6. **Não faça commits.** Ao fim de cada passo, rode `npm run typecheck`, `npm run lint` e `npm run test:unit`, e anote no fim deste arquivo, na seção "Registro de execução", o passo concluído, o nome do experimento de avaliação e as notas obtidas.
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
- **Critério:** decisão anotada no "Registro de execução", com os números de `realDev` antes e depois.

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

## Fase 3: fechar o RAG

1. Rode os quatro conjuntos (`dev` e `validation` no `rag_eval`; `realDev` e `realValidation` no `rag`) e guarde os relatórios em `tests/evaluations/results/`.
2. Compare a latência local com a do run `dev-v7-atual` (p95 15,2 s). As correções não podem piorar o p95 local em mais de 10%.
3. Anote no "Registro de execução" o nome dos quatro relatórios finais. A partir daqui, toda mudança no RAG precisa manter 5/5 nos quatro conjuntos.

## Critério final de pronto

| Item | Meta |
|---|---|
| Notas em `dev`, `validation`, `realDev` e `realValidation` | 5/5 em todas as dimensões |
| Comportamento esperado em `realDev` e `realValidation` | 100% |
| Respostas com citação | 100% |
| Citações sustentadas e relevantes | ≥ 0,95 |
| Violações de segurança e citações não autorizadas | 0 |
| Juiz | modelo diferente do modelo de resposta |
| Recusas | nenhuma resposta inventada em `abstain`, nenhuma recusa indevida em `answer` |
| Latência local | p95 até 10% acima de 15,2 s |

## Registro de execução

Executado em 21/11/2026. O juiz passou a ser `qwen2.5:14b` (`JUDGE_MODEL` no `.env`); o modelo que responde continua `qwen2.5:7b`. A máquina tem 16 GB de RAM, e o p95 total sobe porque o juiz de 9 GB disputa memória com o modelo de resposta. `npm run lint` não roda: o repositório não tem `eslint.config.*`. `tsc` e os 103 testes unitários passaram.

O banco `rag` perdeu o corpus sintético que tinha sobrado (`PC-01/2025`, criador `seed-corpus`) e três documentos de teste E2E de extintores. A Portaria nº 45 ficou com o número `Portaria nº 45/2024`, que o PDF traz e o cadastro não tinha.

| Passo | Experimento | Notas (rec/fid/rel/cit/rob) | Observação |
|---|---|---|---|
| 0.1 e código atual | dev-v11 | 5/5/5/4/5 | p95 total 38,7 s; geração p95 35,7 s (antes 13,2 s). Relatório `2026-11-21T15-14-49-271Z-dev-v11.json` |
| 0.3 | real-v1-linha-de-base | 4/4/4/3/3 | 25 casos. Relatório `2026-11-21T14-25-09-631Z-real-v1-linha-de-base.json` |
| medição | validation-v11 | 5/5/4/5/3 | 18 casos. Relatório `2026-11-21T14-35-34-132Z-validation-v11.json` |
| medição | real-validation-v11 | 5/5/4/5/4 | 16 casos. Relatório `2026-11-21T14-50-38-601Z-real-validation-v11.json` |

Causas dos casos reprovados:

- `dev-19`: a busca traz "sábados e domingos, das 8h às 11h" e o modelo responde só o horário. Geração.
- `real-08`: a pergunta ambígua sobre atividades críticas foi respondida só com a revista de crianças, sem pedir qual procedimento. Geração.
- `real-17`: "qual é o prazo?" não tem um prazo genérico nestes documentos (nota de evidência 0,08) e o chat recusou em vez de pedir o assunto. Rótulo generoso demais para este acervo.
- `real-20` e `real-24`: o trecho certo foi recuperado e, mesmo assim, a resposta saiu sem citação válida. A pós-geração recusa nesse caso, como o plano pede. Geração.
- `rval-07`: "com que frequência o POP deve ser revisado?" foi recusada, embora a apresentação diga "revisado correntemente". Geração ou nota de evidência baixa.
- `val-12`: conflito do conjunto de validação não foi declarado. Não foi usado para ajustar o prompt.
- `val-17`: pergunta com injeção no pedido do usuário foi recusada; o esperado era responder a proibição do celular. Geração.
- `val-18`: pergunta ambígua recusada.

O que mudou no código:

- Rubrica reprova resposta sem citação válida e resposta que mistura fato com a frase de recusa.
- O verificador lexical (`lexical-v3`) aceita a linha "Citação:" e "Citações:".
- Prompt `assistente-documental-v11`: divergência sem exemplo do AC4, sem decidir qual fonte prevalece, e com a obrigação de declarar ato revogado.
- Se a resposta não tem citação válida, há uma segunda geração; se continuar sem citação, a resposta vira recusa.
- Citação com suporte baixo é trocada pela fonte do contexto que sustenta a frase.
- `focus.ts` foi mantido. Um teste garante que "atividades do dia" não aciona o filtro de atividades críticas. A remoção do filtro não foi medida.
- Conjuntos `realDev` (25) e `realValidation` (16) em `tests/evaluations/datasets/real.ts`.
- Busca no corpus sintético: p95 1,4 s (`tests/performance/retrieval-benchmark.ts`). A coleção de 500 documentos não foi gerada.
- `eval:calibrate-rerank` não foi executado. As recusas de `real-20` e `real-24` aconteceram com o trecho certo já recuperado (notas 0,91 e 0,23), então baixar `minEvidenceScore` não as corrigiria. As recusas certas (`real-15`, `real-16`) ficaram em 0,01.
- Auditoria de texto: nenhuma página ilegível. No POP, a amostra de 20 trechos tem 16 com o procedimento no caminho e 4 só com o nome da seção.

O critério final não foi atingido. O conjunto sintético `dev` está em 5/5/5/4/5, com uma falha (`dev-19`). Nos documentos reais a citação ainda aponta trecho errado com frequência (relevância da fonte citada 0,68 em `realDev`) e a cobertura de fatos fica entre 0,90 e 0,92.
