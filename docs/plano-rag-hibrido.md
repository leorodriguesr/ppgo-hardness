# Plano do RAG por API

Substitui `docs/plano-producao-rag.md`, que fica como histórico.

Escopo: só o RAG. Login, implantação e backup ficam para outra etapa.

Princípio: **o código não deve crescer**. Cada etapa prefere, nesta ordem:

1. mudar configuração;
2. apagar código que só existia para compensar o modelo local pequeno;
3. escrever código novo, só quando a avaliação mostrar que configuração não resolve.

## Regras

- Uma etapa por vez. Só passe para a próxima com o "Portão" aprovado.
- Avaliação final de cada etapa em três rodadas (repetir o comando três vezes com nomes `-r1`, `-r2`, `-r3`). Vale a pior rodada.
- `dev` e `realDev` servem para ajustar. `validation` e `realValidation` só medem.
- Nada de correção para uma pergunta só (exemplo com nome de documento no prompt, regex com palavras do caso).
- Bancos: `rag` (real) e `rag_eval` (sintético). Nunca semeie o sintético no `rag`.
- Commit só quando o responsável pedir.
- O modo 100% local continua funcionando trocando só o `.env` (bloco comentado em `.env.example`). Nenhuma etapa pode quebrá-lo.

## Provedores escolhidos (verificados em 21/11/2026)

| Função | Provedor e modelo | Gratuito? | Observação |
|---|---|---|---|
| Resposta | OpenAI `gpt-6-luna`, raciocínio `none` | Não: US$ 0,10 / 0,50 por milhão de tokens | Cerca de US$ 0,0003 por pergunta. Escolhido na Etapa 1 contra o Gemini Flash-Lite |
| Reescrita da pergunta | OpenAI `gpt-6-luna` | Não | Mesma chave e endpoint da resposta |
| Embeddings | `bge-m3` local, 1024 dimensões | Sim | O `gemini-embedding-2` recuperou pior |
| Reranker | `bge-reranker-v2-m3` local (llama.cpp) | Sim | O Voyage `rerank-3` ordenou pior |
| Juiz das avaliações | `qwen2.5:7b` local (era Groq `openai/gpt-oss-120b`) | Sim | Outra família que Gemini e GPT, para o juiz não avaliar o próprio modelo |

Por que esses provedores:

- **Gemini.** É o único plano gratuito permanente com modelo forte, contexto grande e embeddings, tudo com uma chave só e pelo endpoint compatível com OpenAI que o código já usa.
- **Groq como juiz.** Ficou só com modelos `gpt-oss` e Qwen no plano gratuito, com limite de tokens baixo: serve para o juiz, não para o chat.
- **Mistral.** Não tem mais API gratuita.
- **Cerebras.** É só um teste de 30 dias.
- **OpenRouter.** O plano gratuito permite 50 requisições por dia.
- **Reranker.** O teste da Cohere proíbe uso em produção, e o crédito grátis da Jina (10 milhões de tokens) dá para cerca de 600 perguntas. A Voyage dá 200 milhões de tokens grátis.

Cuidados:

- **Treino com os dados.** No plano gratuito do Gemini, o Google pode usar as requisições para treinar modelos. Os documentos são públicos, mas as perguntas dos servidores também vão junto. Ativar o faturamento no mesmo projeto desliga esse uso.
- **Limites do Gemini.** O Google não publica os limites gratuitos por modelo; eles aparecem em aistudio.google.com/rate-limit e valem por projeto.
- **Limite do juiz.** O juiz na Groq tem limite de 8 mil tokens por minuto. Se o contexto passar disso (Etapa 2), a avaliação do juiz falha.

Pagos que valem a pena:

- **Faturamento do Gemini ativado:** cerca de US$ 0,02 por pergunta com o Hydrogen. Remove a incerteza de limite e o uso para treino. É o que eu recomendo para produção.
- **Juiz pago** (Groq Developer ou US$ 10 de crédito na OpenRouter): avaliações completas sem limite diário.
- **Cartão cadastrado na Voyage:** limites maiores; os 200 milhões grátis continuam valendo.

## Já feito (21/11/2026)

- `JUDGE_PROVIDER`, `JUDGE_BASE_URL` e `JUDGE_API_KEY`: o juiz pode usar outro provedor. Sem essas variáveis, nada muda.
- Embeddings por API enviam `dimensions` para qualquer modelo, não só `text-embedding-3`.
- O reranker por HTTP aceita a resposta da Voyage (`data`).
- `.env.example` com o perfil por API como padrão e o perfil local comentado.
- `typecheck` e 104 testes unitários passando.

---

## Etapa 1: ligar as APIs (só configuração)

1. Criar as chaves:
   - Google AI Studio (Gemini);
   - Voyage (recomendado cadastrar cartão);
   - Groq.

   Preencher o `.env` com o bloco do `.env.example`.
2. Confirmar que esta parte é pública:
   - `DEFAULT_ACCESS_CLEARANCE=publico`;
   - mudar o POP 533/2018 de `interno` para `publico`.

   Com isso, nenhum trecho acima de público chega à API.
3. Reindexar: cadastrar `openai / gemini-embedding-2 / 1536` em /admin, aguardar a migração e ativar.
4. Recalibrar o corte do reranker, porque as notas da Voyage têm outra escala que as do `bge`: `npm run eval:calibrate-rerank` e ajustar `rerank.minScore`.
5. Corrigir os casos de avaliação:
   - `rval-03`: conferir o art. 4º, III;
   - `real-17`: reescrever como ambiguidade que o acervo sustenta;
   - `real-19`: remover, porque o controle de acesso continua testado no corpus sintético.
6. Acrescentar ao `realDev` os casos do AC4, todos com "não há divergência" como texto proibido:
   - "O que é o sistema de agendamento de ac4 e como faz para realizar a marcação?": acesso e todos os períodos dos arts. 6º, 7º e 8º;
   - "quais os dias que o servidor pode realizar o agendamento?": dias 25, 26, 28, 11, 12 e 13;
   - "quem pode agendar ac4 nos grupos táticos?": a restrição do art. 2º, § 2º só para esses grupos.
7. Remover do prompt a linha "Quando a mesma frase da fonte trouxer o dia e o horário, escreva os dois" (`PROMPT_VERSION` v12).

**Portão:**
- `typecheck` e testes unitários passam.
- Uma pergunta respondida no chat com citação.
- `dev` e `realDev` com prompt e limites de contexto atuais:
  - busca: recall e MRR iguais ou melhores que os do `bge-m3`;
  - zero resposta sem citação;
  - tempo até o primeiro token registrado.
- As notas do juiz recomeçam a linha de base, porque o juiz mudou.

## Etapa 2: contexto completo (só configuração)

Causa do caso do AC4: o contexto aceita 4 trechos por documento e 6 no total, e as datas estão em quatro artigos. Na pergunta sobre os dias, o art. 8º (segunda quinzena) e o art. 7º (dia 11) foram cortados.

1. Em /admin/configuracoes:
   - `retrieval.finalTopK` 12;
   - `retrieval.maxChunksPerDocument` 12;
   - `retrieval.maxContextTokens` 12000.
2. Avaliar `realDev` com esses valores. Medir antes com `--overrides`, sem salvar.

Só se os casos do AC4 ainda falharem: incluir os trechos vizinhos do mesmo artigo (código pequeno em `buildContext`, usando `structuralRef`).

**Portão:**
- casos do AC4 passam nas três rodadas;
- `realDev` com cobertura de fatos ≥ 0,98;
- `dev` sem queda;
- custo por pergunta registrado em `llm_usage`.

## Etapa 3: apagar as adaptações do modelo pequeno

Cada item é testado removendo-o e rodando `dev` + `realDev`. Se não fizer falta, o código sai.

1. `retrieval/focus.ts`, o filtro específico do POP.
2. A segunda geração quando falta citação e a troca de citação depois da resposta (`retargetWeakCitations`). Elas fazem a resposta salva diferir da que o usuário viu.
   - Se o modelo novo cita bem, saem.
   - Se precisarem ficar, a verificação passa a acontecer antes de exibir.
3. `removeNoEvidenceClauses` e as regras do prompt que só existiam para conter o 7B.
4. `OLLAMA_NUM_CTX` e limites de contexto pequenos continuam só no perfil local.

**Portão:**
- notas iguais ou melhores com menos linhas;
- resposta salva igual à exibida.

## Etapa 4: aceite

1. Os quatro conjuntos em três rodadas, nota 5 em todas as dimensões na pior rodada. Se algo falhar aqui, volta para a etapa responsável, sem ajuste olhando a validação.
2. Revisão humana: 30 perguntas reais avaliadas pelo responsável em /admin/avaliacoes. Meta: nenhuma errada, no máximo duas incompletas.
3. Tempo até o primeiro token p95 ≤ 3 s; resposta completa p95 ≤ 15 s.
4. Custo médio por pergunta e projeção mensal.
5. Teste do perfil local: trocar o `.env` para o bloco local e confirmar que o chat responde (sem exigir as mesmas notas).
6. Congelar prompt, configurações e modelos com versão registrada.

## O que saiu do plano anterior, e por quê

- **Provedor por função para tudo.** Gemini cobre resposta, reescrita e embeddings com uma chave; só o juiz precisava de provedor separado.
- **Roteamento por nível de sigilo.** O acervo desta parte é público. Basta a credencial padrão `publico`.
- **Verificador de citações por LLM.** Só entra se a Etapa 3 mostrar citações fracas.
- **Coleção sintética de 500 documentos.** O acervo real tem 4 documentos; o teste de escala volta quando o acervo crescer.
- **Opção `--repeat`.** Repetir o comando três vezes resolve.
- **Comparar vários modelos.** No máximo Hydrogen contra 3.8 Flash, na Etapa 1.

## Registro de execução

Etapa 1, 21/11/2026. O chat responde pelo Gemini `gemini-3.5-flash-lite`. O `gemini-4-hydrogen` passou de 90 s para responder "ok", mesmo com raciocínio no nível baixo, e o `gemini-3.8-flash` não respondeu (alta demanda). O primeiro token do Flash-Lite chegou em 1,2 s.

Embeddings e reranker continuam locais. O `gemini-embedding-2` ficou abaixo do `bge-m3` (dev R@K 0,955 contra 1; realDev R@K 0,864 contra 1). O Voyage `rerank-3` baixou o MRR do realDev para cerca de 0,53, contra 0,85 do `bge-reranker-v2-m3`. Os vetores do Gemini ficaram no banco, aposentados. A calibração da Voyage não achou um corte que separasse pergunta respondível de abstenção (as duas ficaram em torno de 0,59), então `minScore` segue 0,1.

Busca com `bge-m3` e o reranker local, três rodadas iguais:

| Conjunto | R@K | MRR | Comparado com a linha de base |
|---|---|---|---|
| dev | 1,000 | 1,000 | igual (R@1 0,955) |
| realDev, casos antigos | 1,000 | 0,855 | MRR era 0,846; R@1 continua 0,737 |
| realDev, com os casos novos do AC4 | 0,977 | 0,841 | `real-26` fica em R@K 0,50 pelo limite de 4 trechos por documento. É a Etapa 2 |

Respostas com citação válida: 100% na rodada completa do `dev` e na amostra real (`real-01`, `real-15`, `real-22`, `real-26`). Latência da resposta no `dev`: p50 2,2 s, p95 6,9 s.

O juiz da Groq não fechou a linha de base. A cota gratuita (200 mil tokens por dia) acabou nas rodadas feitas com o embedding do Gemini. Na rodada completa do `dev` com `bge-m3`, 24 de 27 julgamentos voltaram HTTP 429. As três rodadas completas com juiz ficam para quando a cota renovar (meia-noite do horário do Pacífico) ou com um juiz pago.

| Etapa | Experimento | Rodadas | Pior rodada (rec/fid/rel/cit/rob) | Observação |
|---|---|---|---|---|
| 1 | etapa1-final-dev / etapa1-final-real | 3, só busca | busca 5/5 no dev; realDev 0,977 de R@K | Juiz sem linha de base. Relatórios em `tests/evaluations/results/` |
| 1 | etapa1-juiz7b-dev / etapa1-juiz7b-real | 3, completa | dev 5/5/5/4/5; realDev 4/4/4/3/3 | Linha de base com juiz `qwen2.5:7b` local. Etapa 1 fechada |
| 2 | etapa2-ctx-dev / etapa2-ctx-real | 3, completa | dev 5/5/5/4/5; realDev 4/4/4/3/4 | Contexto 12/12/12000 gravado. `real-26` passou depois do prompt v13 |
| 3 | etapa3-final-dev / etapa3-final-real | 3, completa | dev 5/5/5/5/5; realDev 4/5/5/3/4 | Sem segunda geração, sem troca de citação, sem limpeza de recusa. Filtro do POP ficou |
| 4 | etapa4-dev / val / real / rval | 3, completa | nenhum conjunto fecha 5/5/5/5/5 | Aceite não fechou. Sem ajuste a partir da validação |

Linha de base do juiz, 21/11/2026. O juiz passou para o `qwen2.5:7b` local: é de outra família que o Gemini e o GPT e não tem cota. O `gpt-oss` da Groq é da família do GPT, e o `qwen2.5:14b` ocupa cerca de 10 GB e travou a máquina de 16 GB. O 7B é menos rigoroso: no `real-08` acusou como inventado um item que está no trecho. A revisão humana da Etapa 4 cobre essa falha.

O juiz agora recebe a seção de cada trecho (título e artigo), como o modelo de resposta. Antes ele acusava de invenção o número do POP, que vem do título da seção. O nível de raciocínio saiu do código para o `.env` (`LLM_REASONING_EFFORT`).

Resposta pelo `gemini-3.5-flash-lite`, pior das três rodadas:

| Conjunto | Fidelidade (juiz) | Fatos | Citação válida | Comportamento | Latência p50 / p95 |
|---|---|---|---|---|---|
| dev | 4,89 | 0,970 | 100% | 0,963 | 2,3 s / 3,2 s |
| realDev | 4,67 | 0,854 | 100% | 0,815 | 4,8 s / 7,4 s |

Falhas do `realDev` nas três rodadas:
- `real-26`: limite de trechos por documento (Etapa 2).
- `real-17`: caso ainda não reescrito.
- `real-24`: o trecho com "impreterivelmente" foi recuperado, mas o modelo se absteve em vez de concluir "não".
- `real-08`: pergunta ambígua; o modelo listou um único procedimento em vez de apontar a ambiguidade.

`real-24` e `real-08` são limites do modelo de resposta e servem de comparação para o `gpt-6-luna`.

Comparação com o `gpt-6-luna` (OpenAI, raciocínio `none`), 21/11/2026. Mesmo juiz, busca e prompt; resposta e reescrita no GPT. Pior das três rodadas:

| Conjunto | Modelo | Fidelidade (juiz) | Comportamento | Citações relevantes | Citações sustentadas | Latência p50 / p95 |
|---|---|---|---|---|---|---|
| dev | Gemini Flash-Lite | 4,89 | 0,963 | 0,857 | 0,938 | 2,3 s / 3,2 s |
| dev | GPT-6 Luna | 4,85 | 1,000 | 0,923 | 0,828 | 2,3 s / 3,6 s |
| realDev | Gemini Flash-Lite | 4,67 | 0,852 | 0,657 | 0,971 | 4,8 s / 7,4 s |
| realDev | GPT-6 Luna | 4,78 | 0,889 | 0,733 | 0,903 | 5,0 s / 8,0 s |

Comportamento do `realDev` já com o gabarito corrigido (versão 3). O `real-10` e o `real-25` exigiam a frase literal ("não será necessária", "aprimoramento"); o GPT respondeu certo com outras palavras ("não é necessária", "melhorar e aprimorar"). O gabarito passou a aceitar as duas formas, e a correção foi aplicada às respostas salvas dos dois modelos.

- O GPT acertou o `real-24` ("Não. O servidor deve apresentar-se impreterivelmente...") nas três rodadas. O Gemini se absteve nas três.
- Os dois erram o `real-08` (ambiguidade), o `real-17` (caso a reescrever) e o `real-26` (Etapa 2).
- "Citações sustentadas" é menor no GPT porque ele põe uma citação só no fim de uma lista, e o verificador lexical compara a citação com a última frase (exemplo: `real-06`, "Algemas. [Fonte 1, página 93]"). Não são invenções. Revisar na Etapa 3.
- Custo medido em `llm_usage`: cerca de US$ 0,0003 por pergunta no acervo real (2.400 tokens de entrada, 110 de saída), ou US$ 0,30 a cada mil perguntas. Com o contexto da Etapa 2 (até 12 mil tokens), deve ficar perto de US$ 0,001.
- O tempo total é igual nos dois: o GPT leva 1,6 s em média por resposta, e o resto é a busca local.

Decisão: resposta e reescrita no `gpt-6-luna`.

Validação da busca (só mede, uma rodada; a busca é determinística):
- `realValidation`: R@1 = R@K = MRR = 1,000 nos 16 casos.
- `validation`: R@K 0,967, MRR 0,956; só o `val-17` (injeção de prompt) perdeu um dos dois trechos.

Atenção para a Etapa 4: a busca sozinha leva cerca de 3,7 s de p50 no acervo real (reranker local sobre os trechos longos do POP). A meta de primeiro token em até 3 s não cabe sem reduzir esse tempo.

Etapa 2, 21/11/2026. Configuração gravada nos bancos `rag` e `rag_eval`: `finalTopK` 12, `maxChunksPerDocument` 12, `maxContextTokens` 12000. Medido antes com `--overrides`. Pior das três rodadas, com o `gpt-6-luna`:

| Conjunto | R@K | Contexto | Fatos | Comportamento | Fidelidade | Latência p50 / p95 |
|---|---|---|---|---|---|---|
| dev | 1,000 | 1,000 | 0,977 | 1,000 | 4,85 | 2,5 s / 2,8 s |
| realDev | 1,000 | 1,000 | 0,945 | 0,889 | 4,85 | 5,3 s / 8,5 s |

O `dev` não caiu (fidelidade 4,85 e fatos 0,977, iguais à pior rodada do contexto antigo). No `realDev`, R@K foi de 0,977 para 1,000 e o contexto de 0,955 para 1,000.

O portão não fechou. A cobertura de fatos na pior rodada ficou em 0,945, abaixo de 0,98, por causa do `real-26`: os quatro artigos já estavam no contexto nas três rodadas, e mesmo assim a resposta omitiu o dia 11 em todas e, numa delas, resumiu os períodos em "nas datas e horários disponibilizados". O `real-27` (pergunta direta pelos dias) e o `real-28` passaram nas três. Trazer trechos vizinhos não muda isso, porque o trecho que falta na resposta já foi enviado. O que resta é o modelo resumir uma lista que está no contexto.

Custo no acervo real: cerca de US$ 0,00037 por pergunta (3.200 tokens de entrada e 105 de saída), contra US$ 0,0003 com o contexto antigo. A maioria das perguntas não usa os 12 trechos.

Prompt v13, 21/11/2026. Uma frase geral, no prompt e de novo no fim do pedido: se as fontes listarem vários dias, horários, etapas ou valores, escreva cada item, sem resumir. Nas três rodadas, `real-26`, `real-27` e `real-28` ficaram com cobertura de fatos 1. Perguntas estreitas (`real-09`, `real-22`, `real-24`) continuaram respondendo só o que foi perguntado. A cobertura de fatos do `realDev` inteiro não foi remedida; a pior rodada da Etapa 2 era 0,945 por causa do `real-26`, que agora passa.

Etapa 3, 21/11/2026. O que saiu, porque a medição ficou igual ou melhor:

- A segunda geração quando a resposta vinha sem citação.
- A troca de citação depois da resposta (`retargetWeakCitations`). O texto exibido passa a ser o texto salvo.
- A limpeza que apagava "não encontrei informações suficientes" quando vinha grudada numa resposta. Nas rodadas, essa frase só apareceu como recusa inteira, que continua valendo.

O filtro do POP (`focus.ts`) ficou. Sem ele, "materiais da revista pessoal" misturou a revista visual e a tátil, e o `real-07` falhou. As regras do prompt ficaram: ainda definem citação, divergência, ambiguidade e a lista completa. O `OLLAMA_NUM_CTX` continua só no perfil local, em 8192; o contexto de 12 trechos está no banco e vale para a API.

Pior das três rodadas, já sem esses reparos:

| Conjunto | Fidelidade | Fatos | Citações sustentadas | Comportamento |
|---|---|---|---|---|
| dev | 4,89 | 0,977 | 1,000 | 1,000 |
| realDev | 4,85 | 0,977 | 0,946 | 0,926 |

Antes, na Etapa 2, a pior do `realDev` tinha fatos 0,945, citações sustentadas 0,865 e comportamento 0,889. Continuam falhando só `real-08` (responde um procedimento em vez de apontar a ambiguidade) e `real-17` (pergunta "qual é o prazo?" e o modelo se abstém; o caso ainda pede reescrita).

Etapa 4, 21/11/2026. Aceite automático não fechou. Nenhum dos quatro conjuntos teve nota 5 nas cinco dimensões na pior rodada. Não houve ajuste olhando a validação.

| Conjunto | Pior rodada (busca/fidelidade/relevância/citações/robustez) | O que impede o 5 |
|---|---|---|
| dev | 5/5/5/4/5 | fontes citadas relevantes 0,889 |
| validation | 5/5/4/5/4 | fatos 0,933; comportamento 0,889 (`val-17`, `val-18`) |
| realDev | 4/5/5/3/4 | MRR 0,841; fontes citadas relevantes 0,722; `real-08` e `real-17` |
| realValidation | 5/4/4/5/4 | fidelidade 4,69 e uma alucinação grave; fatos 0,875. A falha do `rval-02` era do gabarito (ver abaixo) |

Tempo até o primeiro token, já com a busca: p95 de 2,4 s no `dev` e de 5,1 s no `realDev`. A meta é 3 s. A resposta completa ficou em 3,3 s e 7,7 s, dentro dos 15 s. O tempo extra no acervo real é o reranker local nos trechos longos do POP.

Custo medido nesta rodada, no banco real: US$ 0,052 para 117 respostas, cerca de US$ 0,00045 por pergunta. Mil perguntas no mês ficam em torno de US$ 0,45.

O perfil local respondeu. Com `qwen2.5:7b` no lugar do GPT, a pergunta do horário do dia 11 saiu certa, em 18 s. O `.env` da API não foi trocado.

Versão medida, ainda sem congelar: prompt `assistente-documental-v13`, chat e reescrita `gpt-6-luna`, embeddings `bge-m3`, reranker `bge-reranker-v2-m3`, juiz `qwen2.5:7b`, contexto 12 trechos e 12.000 tokens.

A revisão humana de 30 perguntas em /admin/avaliacoes continua com o responsável.

A mesma regra vale para fundamentação legal, atividades críticas, sequência das ações, resultados esperados, ações corretivas e possibilidades de erros (prompt v15, `realDev` versão 5). Sem procedimento nomeado, a busca traz uma seção de cada procedimento. `real-08` e `real-30` a `real-34` passaram; revista pessoal e estrutural continuaram numa lista só.

Pergunta "qual o material necessário no POP?", 22/11/2026 (prompt v14, `realDev` versão 4). Sem procedimento nomeado, o filtro de material entregava só a lista da página 83 e a resposta apresentava isso como o material do 533/2018. O filtro agora só restringe quando a pergunta cita o procedimento ("revista pessoal" continua numa lista só). A resposta tem de nomear o procedimento antes da lista. `real-29` passou nas duas rodadas; `real-06` e `real-07` continuaram certos.

Correção do gabarito do `rval-02`, 21/11/2026 (`realValidation` versão 3). O ato diz que os membros "não poderão adentrar [...] portando aparelhos de telefonia móvel celular particulares [...]": a proibição é de entrar com os aparelhos, não de entrar. O gabarito antigo cortou a frase e exigia "Não". O modelo respondia certo ("Sim, mas sem celulares..."), e o juiz, que lê o gabarito, marcava alucinação grave. Novo gabarito: "Sim, mas sem celulares e outros dispositivos de comunicação". Com ele, o `rval-02` passou nas três rodadas, com o juiz em 5/5. O `realValidation` inteiro ainda precisa ser remedido com a versão 3.
