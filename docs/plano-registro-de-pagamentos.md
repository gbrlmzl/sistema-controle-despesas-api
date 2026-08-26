# Plano: Registro e rastreio de pagamentos (comprovantes no Amazon S3)

> **Status:** documento de decisão. **Nada foi implementado.** Segue a convenção do projeto: a
> decisão vive no `docs/` primeiro, é aprovada, e só então vira código — e cada fase é testada antes
> da seguinte.
>
> **Revisão 2 (24/08/2026):** reescrito em torno da **entidade de acerto com os dois lados**
> (pagador e recebedor). A revisão 1 tinha um booleano `pago` no mês e linhas só para devedores;
> agora o estado do mês é **derivado** das linhas de acerto, e quem recebe também tem uma ação.
> Mudam: §2 (D-21 a D-28 renumerados), §3 inteira, §4, §5, §6, Fases 3 a 8 e Parte C.
>
> **Revisão 3 (25/08/2026):** a folha-resposta voltou com **D-01 = B** (pares devedor→credor),
> divergindo da recomendação A que esta revisão anterior assumia. O acerto deixa de ser "uma linha
> por participante" e passa a ser **uma linha por par**, com um algoritmo novo de simplificação de
> dívidas (D-29) e liquidação nos dois lados **do mesmo par** — não mais duas populações de linhas
> independentes. Mudam: §2 (D-29 a D-32 novos), §3.2, §3.4, §4 (RN-071/074/075/076/082 reescritas,
> RN-083/084 novas), §5.2, §6 inteira, Fases 3, 4, 5, 8 e Parte C inteira. **Este documento está
> aguardando sua revisão** — nenhum código foi escrito ainda para esta revisão.
>
> **Pré-requisito:** a [folha-resposta](./03-folha-resposta-decisoes.md) preenchida. Este plano
> assume **todas as recomendações dela, com a exceção registrada de D-01**. Se outra decisão
> marcada com 🔔 mudar, pare e peça a revisão do documento antes de escrever código.
>
> **Divisão de trabalho:**
> - **[Parte A](#parte-a--sua-parte-console-da-aws)** — o que **você** faz no console da AWS e no
>   `.env`. Nada aqui é automatizável por um agente.
> - **[Parte B](#parte-b--execução-pelo-sonnet-5)** — roteiro de implementação na **API**, fase a
>   fase, com critério de aceite e comando de verificação em cada uma.
> - **[Parte C](#parte-c--contrato-com-o-front-end)** — o que o repositório do **front-end** precisa
>   implementar. Fora do escopo da API, registrado aqui porque a API define o contrato.
>
> **Ordem correta:** você preenche a folha-resposta → faz a Parte A → aprova este documento → o
> agente executa a Parte B. As **Fases 0 a 6 da Parte B não dependem da Parte A** (o grupo de
> variáveis do S3 é opcional por design, ver D-18); só as Fases 7 e 8 precisam do bucket de verdade.
>
> **IDs novos criados por este plano:** `EP-07`, `FEAT-036` a `FEAT-038`, `US-032` a `US-036`,
> `RN-069` a `RN-084`, `D-01` a `D-32`. Continuam de onde a
> [release V2.0](../sistema-controle-despesas-front/docs/release-v2.0-requisitos.md) parou
> (RN-068, FEAT-035, US-031, EP-06).

---

## 1. O que já existe no projeto e que este plano reaproveita

A análise do código encontrou quase toda a mecânica necessária já construída e testada. **Este plano
foi desenhado para imitar padrões existentes, não para inventar novos.**

| O que já existe | Onde | Como é reaproveitado aqui |
| :---- | :---- | :---- |
| Rateio com saldos que somam exatamente zero (RN-066), já com os booleanos `pays` e `receives` por participante | `calculateSplit` em [reportsService.ts](../sistema-controle-despesas-api/src/services/reports/reportsService.ts) | É a **fonte das linhas de acerto dos dois lados**. Congelado no fechamento (D-21), sem cálculo novo nenhum |
| Fechamento de mês pelo owner | `closeMonth` em [expensesService.ts](../sistema-controle-despesas-api/src/services/expenses/expensesService.ts) | Ganha um passo: congelar o rateio em `Settlement` |
| Grupo de variáveis de ambiente opcional "tudo ou nada" | `googleAuthEnabled` e `mailEnabled` em [env.ts](../sistema-controle-despesas-api/src/config/env.ts) | `storageEnabled` usa o mesmo mecanismo (D-18) |
| Injeção de dependência para tornar efeito colateral testável | [mailer.ts](../sistema-controle-despesas-api/src/lib/mailer.ts), [readiness.ts](../sistema-controle-despesas-api/src/utils/readiness.ts) | O storage é uma **porta** com implementação real e implementação desligada (D-24) |
| Autorização por `Membership`, com 404 para não-membro (RN-010) | `loadUserResidenceContext` em [residencesService.ts](../sistema-controle-despesas-api/src/services/residences/residencesService.ts) | Usado **sem alteração** em todos os endpoints novos |
| Notificação genérica, com texto resolvido por quem publica | `createNotifications` em [notificationsService.ts](../sistema-controle-despesas-api/src/services/notifications/notificationsService.ts) | É o que permite **um único tipo** cobrir "você paga R$ X" e "você recebe R$ X" (D-08) |
| `:period` no formato `AAAA-MM` | `parsePeriodParam` em [expensesController.ts](../sistema-controle-despesas-api/src/controllers/expenses/expensesController.ts) | Reutilizado nas rotas novas, sem duplicar o parser |
| Purga periódica de registros mortos (SEC-09) | [purgeTokens.ts](../sistema-controle-despesas-api/src/scripts/purgeTokens.ts), [tokenPurge.ts](../sistema-controle-despesas-api/src/utils/tokenPurge.ts) | Estendida para limpar comprovantes órfãos (D-26) |
| Log de evento de segurança em JSON de uma linha (SEC-10) | `logSecurityEvent` em [logger.ts](../sistema-controle-despesas-api/src/utils/logger.ts) | Um evento novo na union `SecurityEventName` |
| Validação de corpo com Zod + `validateBody` | [validate.ts](../sistema-controle-despesas-api/src/middlewares/validate.ts) | Um arquivo de schemas novo, no mesmo molde |
| `prisma.$transaction([...])` em operações compostas | [residencesService.ts:460](../sistema-controle-despesas-api/src/services/residences/residencesService.ts) | Fechamento + acertos viram uma transação só |

**Conclusão da análise:** as únicas peças genuinamente novas são o **cliente S3** e o **upload direto
do navegador**. Todo o resto é composição do que o projeto já sabe fazer.

---

## 2. Decisões de arquitetura

`D-01` a `D-20` são as decisões da [folha-resposta](./03-folha-resposta-decisoes.md), resumidas aqui
para o executor não precisar abrir dois arquivos. `D-21` a `D-32` são técnicas, não exigem sua
arbitragem — exceto D-29, D-30 e D-32, marcadas 🔔 porque decorrem diretamente da mudança de D-01 e
vale você conferir o raciocínio — e estão justificadas abaixo.

### Resumo de D-01 a D-20 (aprovadas)

> ⚠️ **D-01 mudou na revisão 3.** A tabela abaixo já reflete a resposta atual da folha (`B`, pares
> devedor→credor). O texto de D-01 e D-02 aqui é o resumo pós-mudança; o raciocínio completo e as
> sub-decisões técnicas que essa mudança exige estão em **D-29 a D-32**, logo depois de D-28.

| ID | Decisão |
| :---- | :---- |
| D-01 | O acerto é **por par devedor→credor**: uma linha para cada par que sobra depois de simplificar as dívidas (D-29), não mais uma por participante |
| D-02 | **Fluxo simétrico, aplicado a cada par**: o devedor daquele par liquida anexando comprovante; o credor daquele par liquida confirmando o recebimento **daquele valor**. Sem ordem obrigatória entre os dois lados de um mesmo par. Sem prova do lado credor. Sem contestação na V1 |
| D-03 | Só o **próprio dono da linha** a liquida |
| D-04 | Competência com comprovante confirmado **não pode ser reaberta** (409) |
| D-05 | Residência **arquivada não aceita liquidação**; leitura continua liberada |
| D-06 | O lado pagador **não** liquida sem comprovante |
| D-07 | O **owner pode dispensar** qualquer linha, dos dois lados, com motivo obrigatório |
| D-08 | Quatro tipos novos de notificação: `SETTLEMENT_PENDING`, `SETTLEMENT_READY`, `MONTH_SETTLED`, `SETTLEMENT_WAIVED` |
| D-09 | Fechamentos **anteriores** a esta funcionalidade ficam sem acertos e sem migração de dados |
| D-10 | Liquidação **não é desfeita** na V1 |
| D-11 | **N comprovantes** por linha; a linha é binária (liquidada / pendente) |
| D-12 | Ex-membro **não** consulta comprovantes (RN-010 sem exceção) |
| D-13 | Upload por **presigned POST**, navegador direto ao S3 |
| D-14 | Em desenvolvimento, **S3 de verdade** num bucket `-dev`; `S3_ENDPOINT` opcional deixa MinIO possível |
| D-15 | `image/jpeg`, `image/png`, `image/webp`, `application/pdf`. Teto de **5 MB** |
| D-16 | `cronos-comprovantes-dev` / `cronos-comprovantes-prod`, em `us-east-2` |
| D-17 | Comprovante guardado **para sempre** |
| D-18 | `storageEnabled`: sem `S3_REGION` + `S3_BUCKET`, a API sobe e só o upload responde 503 |
| D-19 | O navegador comprime e normaliza a imagem antes de enviar |
| D-20 | Entidade **`Settlement`** ("acerto"), termos `payer`/`receiver` (D-30), estado **liquidada** (`paidAt` + `confirmedAt`); no banco e na API tudo em inglês, a tradução para português é do front — como o projeto já faz com `MembershipRole` e `AccessStatus` |

### D-21 — O rateio é **congelado** no fechamento, nunca recalculado 🔔

`calculateSplit` divide o total entre os **membros de hoje** (`prisma.membership.findMany`). Isso é
correto para a competência aberta, mas é uma bomba-relógio para uma competência fechada: se um
morador sair depois do fechamento, a cota de todo mundo muda retroativamente, e a resposta para "quem
ainda deve agosto?" passa a depender de quando você pergunta.

Por isso, no instante do fechamento, o resultado do rateio vira **linhas em `Settlement`** com o
valor e o lado gravados. Depois disso, nada recalcula: sair da residência, entrar na residência ou
reabrir um mês diferente não alteram uma linha existente.

> Este é o item que torna a funcionalidade possível. Sem congelar, "mês quitado" não tem significado
> estável — e agora vale para os dois lados: o valor que o Gabriel *tem a receber* também precisa
> parar de se mexer.

### D-22 — O estado da competência é **derivado**; `settledAt` é carimbo de auditoria

Foi o que o seu insight fixou: o mês não guarda um booleano. `MonthClosure` ganha
`settledAt DateTime?`, mas ele **não é a fonte da verdade** — serve para exibir "quitado em 12/09" e
para não notificar duas vezes. A verdade é sempre calculada a partir das linhas:

```
liquidada(s)     =  s.settledAt !== null || s.waivedAt !== null

AWAITING_PAYMENT       algum PAYER pendente
AWAITING_CONFIRMATION  todo PAYER liquidado, algum RECEIVER pendente
SETTLED                toda linha liquidada  (ou nenhuma linha existe)
```

Três consequências, de propósito:

- **Fechamento sem saldo diferente de zero nasce quitado** (`settlements.length === 0`): mês sem
  despesa, ou em que todos gastaram exatamente a cota. `settledAt` é preenchido junto com o
  fechamento (RN-072).
- **Fechamentos legados** (D-09) também têm zero linhas e portanto são lidos como "nada a acertar",
  sem script de migração.
- **O estado intermediário sai de graça.** `AWAITING_CONFIRMATION` não é um campo — é uma leitura
  das mesmas linhas. Nada a manter em sincronia.

### D-23 — Upload em duas fases, com verificação real na confirmação 🔔

O arquivo não passa pela API (D-13), então a API precisa de outra forma de saber que o objeto existe
e que ele é o que diz ser:

```
1. Front → API    POST .../settlements/:id/receipts
                  API valida: é membro? é o payerId deste par? o mês está fechado?
                  Cria PaymentReceipt com status = PENDING e a chave definitiva
                  Devolve { receiptId, upload: { url, fields } }

2. Front → S3     POST multipart direto no bucket (o arquivo NUNCA toca a API)
                  O S3 recusa sozinho se passar de 5 MB ou se o Content-Type divergir

3. Front → API    POST .../receipts/:receiptId/complete
                  HeadObject           → o objeto existe? tamanho e Content-Type reais
                  GetObject bytes=0-11 → os magic bytes batem com o tipo declarado?
                  Só então: status = STORED, settlement.paidAt = now(), recalcula o mês
```

A leitura de 12 bytes é a verificação de assinatura de arquivo que o OWASP recomenda, feita **sem**
carregar o arquivo na memória da API — que é o que não cabe na `t4g.micro`. Detalhes e assinaturas
por formato em [`02-… §6`](./02-pesquisa-amazon-s3-boas-praticas.md#6-segurança-do-conteúdo-o-furo-do-upload-direto-e-como-fechá-lo-barato).

**Um `PaymentReceipt` em `PENDING` não conta para nada.** Se o passo 2 ou 3 nunca acontecer, a linha
continua pendente e o registro vira órfão, limpo pela purga (D-26).

> **A liquidação do lado `RECEIVER` não tem nada disso.** É um `POST` sem corpo, sem arquivo, sem S3.
> Metade da funcionalidade continua viva mesmo com `storageEnabled === false`.

### D-24 — O storage é uma porta injetável, igual ao envio de email

`src/lib/storage.ts` exporta uma **interface** e duas implementações, exatamente como
[mailer.ts](../sistema-controle-despesas-api/src/lib/mailer.ts) faz com `SendEmail`:

- `createS3Storage()` — usa `@aws-sdk/client-s3`, ativa quando `storageEnabled`
- `createDisabledStorage()` — lança `AppError(503, ...)` em qualquer operação

Os testes injetam um fake em memória. **Nenhum teste automatizado abre conexão com a AWS**, e o CI
continua verde sem segredo nenhum — que é a regra que `googleAuthEnabled` e `mailEnabled` já
estabeleceram.

### D-25 — Toda leitura é uma URL pré-assinada de 5 minutos, emitida sob demanda

Não existe URL de comprovante guardada em banco, nem em cache, nem embutida na listagem. O front
recebe apenas o `receiptId`; para exibir a imagem, pede a URL, que a API só emite depois de checar o
`Membership` (RN-080). Três razões:

1. **Autorização a cada acesso**, não no momento em que a tela foi montada.
2. Credencial de role do ECS **rotaciona a cada 1–6 horas**, e uma URL pré-assinada morre junto com
   ela — URL longa cacheada quebraria em produção de forma intermitente e difícil de reproduzir.
3. A URL é um *bearer token*: quanto menor a validade, menor a janela de um link vazado.

Na emissão, a API força os headers de resposta: imagem sai `inline`, PDF sai `attachment`.

### D-26 — Comprovante órfão é limpo por script, não por ciclo de vida

Uma regra de ciclo de vida do S3 não consegue distinguir "objeto confirmado" de "objeto abandonado" —
essa informação está no Postgres. Então a limpeza é do lado da aplicação, no molde do
`purgeExpiredRefreshTokens`: `purgeOrphanReceipts()` apaga do S3 e do banco os `PaymentReceipt` em
`PENDING` criados há mais de 24 horas.

É por isso que a política IAM concede `s3:DeleteObject` — e é por isso que o **versionamento do
bucket fica ligado** (D-16): com versionamento, `DeleteObject` cria um *delete marker*, então nem um
bug nem uma API comprometida conseguem destruir um comprovante de forma irreversível.

### D-27 — A chave do objeto

```
residences/{residenceId}/{ano}-{MM}/settlements/{settlementId}/{receiptId}.{ext}
```

Hierárquica e legível (prefixo aleatório deixou de ser recomendado em 2018), com dois UUIDs gerados
no servidor no fim. **A chave não adivinhável é defesa em profundidade, não o controle de acesso** —
o controle é o bucket privado mais a checagem de `Membership` em cada emissão de URL.

### D-28 — O front fala com o S3 **direto**, quebrando de propósito a regra de mesma origem 🔔

Toda a arquitetura do front hoje é same-origin: o navegador só conversa com o próprio domínio, e o
Route Handler [`/api/[...path]`](../sistema-controle-despesas-front/src/app/api/%5B...path%5D/route.ts)
proxia para a API. O upload de comprovante é a **primeira exceção deliberada**, com um custo e um
benefício:

- **Custo:** o bucket precisa de regra de CORS listando a origem do front. É a causa nº 1 de "não
  funciona e o erro não faz sentido".
- **Benefício, que é maior:** o comprovante é servido de `*.s3.us-east-2.amazonaws.com`, uma origem
  **sem cookie de sessão e sem `localStorage` do app**. Mesmo que alguém consiga gravar um arquivo
  executável, ele não roda no contexto do Cronos. Por isso o bucket **não** deve ficar atrás do
  domínio do front via CloudFront: isso jogaria fora o isolamento de graça.

### D-29 — O algoritmo de simplificação de dívidas 🔔

Consequência direta de D-01=B. `calculateSplit` continua devolvendo, sem mudar uma linha, o saldo
líquido **por participante** (`balanceInCents`, que já soma exatamente zero — RN-066). O que muda é
o que se faz com essa lista antes de gravar: em vez de virar uma linha por pessoa, ela vira **pares**
por um algoritmo guloso ("simplify debts"), o mesmo que Splitwise e Settle Up usam internamente:

```
1. Separe participantes com saldo ≠ 0 em duas listas: devedores (saldo < 0) e credores (saldo > 0).
2. Ordene as duas por valor absoluto DECRESCENTE; em empate, por userId ASCENDENTE
   (critério só para ser determinístico — sem ele, dois fechamentos com os mesmos saldos
   poderiam gerar pares diferentes, o que dificultaria testar e explicar).
3. Enquanto houver devedor e credor na lista:
     par = min(|saldo do maior devedor|, saldo do maior credor)
     cria uma linha { payerId: devedor, receiverId: credor, amountInCents: par }
     subtrai `par` dos dois; quem chegar a zero sai da lista
4. Termina com as duas listas vazias — nunca sobra devedor sem credor nem vice-versa,
   porque a soma dos saldos já fecha em zero (RN-066).
```

**Não há sobra de centavos.** A preocupação que a pesquisa (`01-…`) registrava para o Modelo 2 vale
para um algoritmo que *divida* uma dívida em partes fracionárias; este aqui só *transfere* centavos
inteiros de um saldo para outro, então o total nunca perde nem ganha um centavo no caminho.

**Isto é um heurístico, não a solução ótima.** Minimizar o número de transferências no caso geral é
NP-difícil; o guloso acima produz no máximo `nº de devedores + nº de credores − 1` linhas, o que é
próximo do mínimo na prática e é exatamente o que produtos reais usam — mas não há garantia
matemática de que seja o menor número possível para toda composição de saldos. Não vale complicar
isso agora: a diferença prática é de zero ou uma linha a mais em casos raros.

**O que se perde, de novo:** os pares podem parecer socialmente arbitrários — "por que estou pagando
a Ana e não ao Gabriel?" — porque o algoritmo não sabe quem gastou com quem, só sabe saldos. A
Parte C precisa de um texto explicando isso (C.2).

Vive em `splitService.ts`, função nova `simplifyDebts(participants): Array<{ payerId, receiverId, amountInCents }>`, ao lado de `calculateSplit` (Fase 3).

### D-30 — Uma linha por par, liquidada dos dois lados **do mesmo par** 🔔

Com D-01=A (revisão 2), pagador e recebedor eram duas populações de linhas independentes: a soma
batia por construção, mas nenhuma linha sabia da outra. Com pares, os dois lados de uma dívida
específica **vivem na mesma linha** — não existe mais um `Settlement` por pessoa, existe um
`Settlement` por par, com dois carimbos independentes:

- `paidAt` — o **devedor** daquele par anexou comprovante (RN-074)
- `confirmedAt` — o **credor** daquele par confirmou que recebeu **aquele valor** (RN-075)

Uma linha está **liquidada** quando os dois carimbos existem, ou quando `waivedAt` existe (D-07
dispensa a linha inteira, nos dois carimbos de uma vez — ver RN-082). **Continua sem ordem
obrigatória** (RN-076): nada impede o credor de confirmar antes do devedor anexar, porque ele
reconhece o Pix específico daquele valor no extrato dele, com ou sem comprovante already anexado.

**Consequência para quem tem mais de uma dívida ou mais de um crédito no mesmo mês:** a ação deixou
de ser "1 anexo, resolve tudo" e passou a ser "1 anexo por par". Quem deve para duas pessoas anexa
dois comprovantes; quem é credor de duas pessoas confirma duas vezes. Isto foi escolhido
deliberadamente (ver folha-resposta) — é o preço de rastrear **quem pagou a quem**, que é
justamente o que motivou trocar para pares.

### D-31 — `SETTLEMENT_PENDING` consolidada por pessoa, não por par

Sem isto, alguém com 3 pares no mesmo fechamento receberia 3 notificações no instante do
fechamento — exatamente o ruído que D-08 já havia evitado para anexos de comprovante. Como o saldo
líquido de uma pessoa **nunca mistura os dois lados** (quem deve não recebe no mesmo fechamento, e
vice-versa — é consequência de D-29 operar sobre o saldo líquido já calculado por `calculateSplit`),
uma pessoa está inteira de um lado só, e a notificação soma os pares dela nesse lado:

- Só devedor, 2 pares: *"Mês fechado: você deve R$ 219,10 a Gabriel e R$ 107,62 a Ana"*
- Só credor, 2 pares: *"Mês fechado: você tem R$ 150,00 a receber de Bruno e R$ 65,00 de Camila"*

Uma notificação por pessoa por fechamento, resolvida em `closeMonth` depois de agrupar as linhas
recém-criadas por `payerId` e por `receiverId` (RN-083).

### D-32 — `SETTLEMENT_READY` é por credor, não pelo fechamento inteiro 🔔

Esta é uma mudança de comportamento real em relação à revisão 2, e existe **porque** pares tornaram
possível ser mais preciso. Antes (D-01=A), só existia "todo mundo pagou" — um evento por fechamento.
Com pares, cada credor sabe exatamente **de quem** está esperando, então esperar por devedores sem
nenhuma relação com ele seria um passo atrás:

| | Revisão 2 (por participante) | Revisão 3 (por par) |
| :---- | :---- | :---- |
| Quando o credor X é notificado | Só depois que **todos** os devedores da casa pagaram, mesmo os que não devem a X | Assim que **todos os pares em que X é credor** têm `paidAt` preenchido |

Numa casa de 6 pessoas com pares esparsos, isto pode ser a diferença entre notificar em minutos ou
depender de alguém que não tem nenhuma relação com aquele credor. **Recomendo esta leitura** — avise
se preferir manter o comportamento antigo (esperar o fechamento inteiro), que também é possível, só
menos preciso.

RN-084 formaliza isto. `MONTH_SETTLED` continua sendo do fechamento inteiro — não há como ficar mais
específico do que "o mês inteiro está quitado".

---

## 3. Modelo de dados

Quatro mudanças. Todas **aditivas** — nenhum `DROP`, nenhum `ALTER` destrutivo.

### 3.1 Alteração em `MonthClosure`

```prisma
model MonthClosure {
  id          Int      @id @default(autoincrement())
  residenceId Int
  month       Int
  year        Int
  closedById  Int
  closedAt    DateTime @default(now())
  //D-22 -> Carimbo de auditoria, NÃO fonte da verdade: o estado do mês é derivado das
  //linhas de Settlement (todas liquidadas ou dispensadas). Existe para exibir a data e
  //para não publicar MONTH_SETTLED duas vezes. RN-072: fechamento sem nenhum saldo
  //diferente de zero nasce com este campo preenchido.
  settledAt   DateTime?

  @@unique([residenceId, year, month])
  residence   Residence    @relation(fields: [residenceId], references: [id], onDelete: Cascade)
  closedBy    User         @relation(fields: [closedById], references: [id])
  settlements Settlement[]
}
```

### 3.2 Novo model `Settlement`

```prisma
//RN-070 -> O acerto de um PAR devedor→credor numa competência fechada, resultado do
//algoritmo de simplificação de dívidas (D-29). A linha é criada no fechamento com o
//valor JÁ CALCULADO (D-21) e nunca mais é recalculada — quem entra ou sai da residência
//depois não muda acerto nenhum. Sem esse congelamento, "quem ainda deve agosto?" mudaria
//de resposta conforme a composição da casa.
//
//RN-071 -> Uma linha por PAR, não por pessoa. Uma pessoa pode aparecer em várias linhas
//da mesma competência (como payer em mais de um par, ou como receiver em mais de um —
//nunca os dois ao mesmo tempo, porque o saldo líquido dela já tinha um sinal só antes de
//virar par, RN-066). A soma de amountInCents de todas as linhas em que alguém é payer
//é o total que ela deve na competência; o mesmo vale para receiver.
model Settlement {
  id            String    @id @default(uuid())
  closureId     Int
  payerId       Int
  receiverId    Int
  //Sempre positivo: quanto o payer deve ao receiver NESTE par.
  amountInCents Int
  //D-30 -> o devedor deste par liquidou o SEU lado, anexando comprovante (RN-074).
  paidAt        DateTime?
  //D-30 -> o credor deste par liquidou o SEU lado, confirmando o recebimento (RN-075).
  //Os dois lados vivem na mesma linha porque o par já os une; não há ordem entre eles
  //(RN-076). A linha está "liquidada" (D-20) quando os dois existem, ou quando waivedAt
  //existe.
  confirmedAt   DateTime?
  //D-07 -> Saída para os dois estados sem saída: o devedor que saiu e não consegue mais
  //anexar, e o credor que nunca abre o app. Dispensa a linha inteira, nos dois lados de
  //uma vez — nunca é o mesmo que liquidada: fica registrada como dispensa, com autor e
  //motivo (RN-082).
  waivedAt      DateTime?
  waivedById    Int?
  waiveReason   String?
  createdAt     DateTime  @default(now())

  //Um par (devedor, credor) por fechamento — o algoritmo de D-29 nunca produz dois pares
  //iguais no mesmo fechamento, mas a constraint barra corrida se o fechamento disparar
  //duas vezes.
  @@unique([closureId, payerId, receiverId])
  //Alimenta "o que eu devo" e "o que tenho a receber" sem varrer a tabela.
  @@index([payerId, paidAt])
  @@index([receiverId, confirmedAt])

  //Cascade: só dispara quando o fechamento é apagado, e RN-077 já impede apagar um
  //fechamento que tenha comprovante confirmado. Na prática, só limpa acerto intocado.
  closure  MonthClosure     @relation(fields: [closureId], references: [id], onDelete: Cascade)
  payer    User             @relation("SettlementPayer", fields: [payerId], references: [id])
  receiver User             @relation("SettlementReceiver", fields: [receiverId], references: [id])
  waivedBy User?            @relation("SettlementWaiver", fields: [waivedById], references: [id])
  receipts PaymentReceipt[]
}
```

> Não há mais enum `SettlementSide`. O lado de uma pessoa numa linha é posicional
> (`payerId === eu` ou `receiverId === eu`), nunca um campo — evita o estado impossível de
> `side` divergir de qual FK está preenchida.

### 3.3 Novo model `PaymentReceipt`

```prisma
//D-23 -> O comprovante em si, sempre do lado PAYER (RN-074): não existe comprovante de
//recebimento, porque não há prova que o sistema consiga ver de "caiu na minha conta".
//Nasce PENDING junto com a URL de upload e só vira STORED depois que a API confirma, no
//S3, que o objeto existe e que os primeiros bytes batem com o tipo declarado. Um PENDING
//não conta para nada: se o navegador desistir no meio, o acerto continua pendente e a
//linha é limpa pela purga (D-26).
model PaymentReceipt {
  id                  String        @id @default(uuid())
  settlementId        String
  //D-27 -> Chave completa do objeto no bucket. Única: duas linhas nunca apontam para o
  //mesmo objeto, então apagar uma nunca cega a outra.
  storageKey          String        @unique
  status              ReceiptStatus @default(PENDING)
  //O que o cliente PEDIU para enviar (usado para assinar a política do POST).
  declaredContentType String
  //O que o S3 relatou de fato no HeadObject. Divergência = confirmação recusada.
  contentType         String?
  sizeInBytes         Int?
  originalName        String?
  uploadedById        Int
  createdAt           DateTime      @default(now())
  storedAt            DateTime?

  @@index([settlementId, status])
  //Alimenta a purga de órfãos (D-26) sem varrer a tabela.
  @@index([status, createdAt])

  settlement Settlement @relation(fields: [settlementId], references: [id], onDelete: Cascade)
  uploadedBy User       @relation(fields: [uploadedById], references: [id])
}

enum ReceiptStatus {
  PENDING
  STORED
}
```

### 3.4 Relações inversas em `User`

```prisma
  settlementsAsPayer    Settlement[]     @relation("SettlementPayer")
  settlementsAsReceiver Settlement[]     @relation("SettlementReceiver")
  settlementWaivers     Settlement[]     @relation("SettlementWaiver")
  paymentReceipts       PaymentReceipt[]
```

### 3.5 Novos valores em `NotificationType`

```prisma
enum NotificationType {
  // ... valores existentes ...
  SETTLEMENT_PENDING  //D-08: mês fechado e você tem um acerto — o texto diz o lado e o valor
  SETTLEMENT_READY    //D-08: todos os pagadores liquidaram; recebedores, confirmem
  MONTH_SETTLED       //D-08: competência inteiramente acertada
  SETTLEMENT_WAIVED   //D-08: o owner dispensou o seu acerto
}
```

> **`SETTLEMENT_PENDING` é um tipo só para os dois lados**, de propósito. O model `Notification` do
> projeto já documenta que `title`, `message` e `linkTo` são resolvidos por quem publica — então
> "Você deve R$ 219,10 a Gabriel" e "Você tem R$ 150,00 a receber de Bruno" são o mesmo tipo com
> texto diferente, e a leitura não precisa conhecer a regra.
>
> **Uma notificação por pessoa, não por par (D-31).** Se alguém está em 3 pares no mesmo
> fechamento, o texto soma os 3 numa mensagem só — nunca 3 notificações. Mesmo raciocínio de
> `SETTLEMENT_READY` (D-32): dispara por credor, quando **todos os pares em que ele é credor**
> têm `paidAt`, não quando o fechamento inteiro termina.

> ⚠️ **Atenção na migration:** no PostgreSQL, `ALTER TYPE ... ADD VALUE` adiciona o rótulo mas ele
> **não pode ser usado na mesma transação** em que foi criado. Como esta migration só adiciona
> valores (não insere linhas usando-os), roda sem problema — mas não misture inserção de dados nela.

---

## 4. Regras de negócio

| ID | Regra |
| :---- | :---- |
| **RN-069** | Liquidar acerto só é possível em competência **fechada**. Competência aberta responde 409 |
| **RN-070** | O rateio é congelado no fechamento. Nenhum evento posterior recalcula um acerto existente |
| **RN-071** | Existe uma linha de acerto para **cada par (devedor, credor)** que sobra depois de aplicar a simplificação de dívidas (D-29) sobre os saldos diferentes de zero. Saldo zero não entra no algoritmo e não gera par |
| **RN-072** | Fechamento sem nenhuma linha nasce com `settledAt = closedAt` |
| **RN-073** | A competência é **quitada** quando toda linha tem (`paidAt` **e** `confirmedAt`) ou `waivedAt`. Sem linhas = quitada |
| **RN-074** | Uma linha é liquidada do lado devedor **anexando comprovante** (grava `paidAt`), e só por quem é `payerId` **daquela linha**. Não há liquidação sem comprovante (D-06) |
| **RN-075** | Uma linha é liquidada do lado credor **confirmando o recebimento** (grava `confirmedAt`), e só por quem é `receiverId` **daquela linha**. Não há anexo desse lado |
| **RN-076** | **Não há ordem obrigatória** entre os dois lados de uma mesma linha: o credor pode confirmar antes do devedor ter anexado comprovante |
| **RN-077** | Competência com pelo menos um comprovante `STORED` **não pode ser reaberta** (409) |
| **RN-078** | Residência arquivada recusa liquidação e dispensa (409); leitura continua liberada |
| **RN-079** | A aplicação nunca apaga comprovante `STORED`. Correção é anexar outro (D-10) |
| **RN-080** | Toda leitura exige `Membership` na residência. Não-membro recebe **404**, nunca 403 (RN-010) |
| **RN-081** | Só `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, no máximo 5 MB, com assinatura de arquivo conferida na confirmação |
| **RN-082** | Dispensar acerto é do owner, exige motivo de 3 a 200 caracteres, dispensa a linha **inteira** (os dois carimbos de uma vez), e nunca é registrada como liquidação |
| **RN-083** | `SETTLEMENT_PENDING` é **uma notificação por pessoa por fechamento** (D-31), somando todas as linhas em que ela é `payerId` ou todas em que é `receiverId` — nunca as duas, e nunca uma por linha |
| **RN-084** | `SETTLEMENT_READY` dispara **por credor** (D-32): quando todas as linhas em que aquela pessoa é `receiverId` têm `paidAt` preenchido, não quando o fechamento inteiro termina |

---

## 5. Máquina de estados

### 5.1 A competência

```
     ABERTA ──────────── owner fecha ────────────┐
        ▲                                        │
        │                            ┌───────────┴────────────┐
        │                            │                        │
        │              algum saldo ≠ 0?                 nenhum saldo ≠ 0
        │                            │                        │
   owner reabre                      ▼                        ▼
   (só o fechamento          AWAITING_PAYMENT              SETTLED
    mais recente, e só    "aguardando pagamento"           (RN-072)
    se nenhum comprovante         │
    STORED existir                │  todos os PAYER liquidaram
    — RN-077)                     ▼
        │                 AWAITING_CONFIRMATION  ──► notifica SETTLEMENT_READY
        │                "aguardando confirmação"      aos recebedores
        │                         │
        │                         │  todos os RECEIVER confirmaram
        │                         ▼
        └──────────────────────  SETTLED  ──► notifica MONTH_SETTLED a todos
                                (RN-073)
```

> Os três estados são **derivados** das linhas (D-22), não campos. `AWAITING_CONFIRMATION` sai de
> graça — nada a manter em sincronia.

### 5.2 Uma linha de acerto (um par devedor→credor)

Cada linha tem **dois carimbos independentes**, um por lado do par — não dois estados separados
como na revisão anterior, porque agora os dois lados vivem na mesma linha (D-30):

```
                          devedor anexa comprovante (RN-074)
                          ─────────────────────────────────►  paidAt preenchido
                                                                       │
   criada, PENDENTE                                                   │
   (paidAt = null,                                                    │
    confirmedAt = null)                                               ▼
                          credor confirma o recebimento (RN-075)
                          ─────────────────────────────────►  confirmedAt preenchido
                                                                       │
                    quando OS DOIS carimbos existem ──────────────────┘
                                    │
                                    ▼
                               LIQUIDADA

   De qualquer estado (mesmo com um dos dois carimbos já preenchido):
   owner dispensa, com motivo (D-07 / RN-082) ──► DISPENSADA (waivedAt), nunca LIQUIDADA
```

**Sem ordem entre os dois carimbos** (RN-076): o credor pode confirmar antes do devedor anexar.
Não há transição de volta na V1 (D-10). Comprovante extra numa linha cujo `paidAt` já existe é
aceito e vira histórico (D-11), sem mudar o carimbo.

---

## 6. Contrato HTTP

Todas as rotas exigem sessão (`requireAuth`) e são montadas em
`app.use('/residences', paymentsRoutes)`, como `expensesRoutes` e `reportsRoutes` já são. `:period` é
`AAAA-MM`.

> **Nomenclatura:** `complete` finaliza um **upload**; `confirm` é o recebedor dizendo que **o
> dinheiro caiu**. São coisas diferentes e os nomes não devem se misturar.

### 6.1 `GET /residences/:code/closures/:period/settlements`

Estado de acerto de uma competência fechada. Qualquer membro (RN-080). Cada item da lista é um
**par** devedor→credor (D-01/D-29), não mais uma pessoa.

```jsonc
{
  "competency": { "month": 8, "year": 2026 },
  "closedAt": "2026-09-01T14:02:11.000Z",
  "closedByName": "Gabriel Mizael",
  "status": "AWAITING_CONFIRMATION",   // AWAITING_PAYMENT | AWAITING_CONFIRMATION | SETTLED
  "settledAt": null,
  "totals": {
    // "linha" aqui é um par; uma pessoa com 2 dívidas conta em 2 linhas
    "payerSide":    { "lines": 3, "paid": 2 },
    "receiverSide": { "lines": 3, "confirmed": 1 }
  },
  "canAct": true,          // false se residência arquivada (D-05)
  "canUpload": true,       // false também se storageEnabled === false (D-18)
  "settlements": [
    {
      "id": "8d21c07e-…",
      "payer":    { "userId": 7, "name": "Letícia Rocha" },
      "receiver": { "userId": 3, "name": "Gabriel Mizael" },
      "amountInCents": 21910,
      "isMinePaying": false,      // true se payer.userId === eu
      "isMineReceiving": true,    // true se receiver.userId === eu
      "status": "AWAITING_CONFIRMATION",  // PENDING | AWAITING_CONFIRMATION | SETTLED | WAIVED
      "paidAt": "2026-09-03T09:11:00.000Z",
      "confirmedAt": null,
      "waivedAt": null,
      "waiveReason": null,
      "receipts": [
        {
          "id": "4f0c9ab1-…",
          "contentType": "image/webp",
          "sizeInBytes": 244121,
          "originalName": "comprovante.jpg",
          "uploadedAt": "2026-09-03T09:11:00.000Z",
          "uploadedByName": "Letícia Rocha"
        }
      ]
    },
    {
      "id": "b71e4a02-…",
      "payer":    { "userId": 7, "name": "Letícia Rocha" },
      "receiver": { "userId": 9, "name": "Ana Prado" },
      "amountInCents": 10762,
      "isMinePaying": false,
      "isMineReceiving": false,
      "status": "PENDING",
      "paidAt": null,
      "confirmedAt": null,
      "waivedAt": null,
      "waiveReason": null,
      "receipts": []
    }
  ]
}
```

> **`status` de uma linha** é derivado dos dois carimbos (D-30): `PENDING` (nenhum), `AWAITING_CONFIRMATION`
> (só `paidAt`), `SETTLED` (os dois), `WAIVED` (`waivedAt`). Não existe status onde só `confirmedAt`
> exista sem `paidAt` — o credor pode confirmar primeiro (RN-076), mas a leitura desse instante ainda
> é `PENDING` até o devedor anexar; o carimbo `confirmedAt` fica gravado e é respeitado quando o
> `paidAt` chegar depois.

- `404` — não é membro, ou o período não tem fechamento
- `settlements: []` para fechamento legado (D-09); nesse caso `status` é `SETTLED`
- **Só comprovantes `STORED` aparecem** na lista

### 6.2 `POST /residences/:code/closures/:period/settlements/:settlementId/receipts`

Abre a intenção de upload. Só quem é `payerId` **daquele par** (RN-074).

**Corpo:**
```jsonc
{
  "contentType": "image/webp",          // um dos 4 de RN-081
  "sizeInBytes": 244121,                 // 1 .. 5242880 — validado de novo pelo S3
  "originalName": "comprovante.jpg"      // opcional, ≤ 120 caracteres
}
```

**201:**
```jsonc
{
  "receiptId": "4f0c9ab1-…",
  "upload": {
    "url": "https://cronos-comprovantes-dev.s3.us-east-2.amazonaws.com",
    "fields": { "key": "residences/42/2026-08/settlements/…", "Content-Type": "image/webp",
                "bucket": "…", "Policy": "…", "X-Amz-Signature": "…", "…": "…" }
  },
  "expiresInSeconds": 300
}
```

| Código | Quando |
| :---- | :---- |
| `400` | `contentType` fora da lista, ou `sizeInBytes` fora de 1..5242880 |
| `403` | Você não é `payerId` desta linha (RN-074) |
| `404` | Não é membro, ou a linha não existe nesta competência |
| `409` | Você é `receiverId`, não `payerId`, desta linha (esse lado não anexa, RN-075); ou competência não fechada (RN-069); ou residência arquivada (RN-078); ou linha já dispensada |
| `503` | `storageEnabled === false` (D-18) |

### 6.3 `POST /residences/:code/closures/:period/settlements/:settlementId/receipts/:receiptId/complete`

Sem corpo. Só quem é `payerId` desta linha. Executa `HeadObject` + leitura dos 12 primeiros bytes (D-23).

**200:**
```jsonc
{
  "receipt":    { "id": "…", "contentType": "image/webp", "sizeInBytes": 244121,
                  "uploadedAt": "…", "uploadedByName": "Letícia Rocha" },
  // status desta LINHA (par): vira SETTLED só se confirmedAt já existia (RN-076)
  "settlement": { "id": "…", "status": "AWAITING_CONFIRMATION", "paidAt": "…", "confirmedAt": null },
  "closureStatus": "AWAITING_CONFIRMATION"
}
```

| Código | Quando |
| :---- | :---- |
| `404` | Comprovante não existe, não é seu, ou o objeto não foi encontrado no bucket |
| `422` | O objeto existe mas **não** confere: tamanho acima do teto, `Content-Type` diferente do declarado, ou magic bytes incompatíveis. O registro é marcado como órfão e entra na fila de purga |
| `503` | Storage indisponível |

> **Já completado devolve `200` com o estado atual**, não 409 — idempotência (ver Fase 4).

### 6.4 `POST /residences/:code/closures/:period/settlements/:settlementId/confirm`

**A ação do credor: "Recebi o pagamento" — deste par específico.** Sem corpo, sem anexo. Só quem é
`receiverId` **desta linha** (RN-075).

**200:**
```jsonc
{
  // status desta LINHA: vira SETTLED só se paidAt já existia (RN-076)
  "settlement": { "id": "…", "status": "SETTLED", "paidAt": "…", "confirmedAt": "…" },
  "closureStatus": "SETTLED"
}
```

| Código | Quando |
| :---- | :---- |
| `403` | Você não é `receiverId` desta linha |
| `404` | Não é membro, ou a linha não existe nesta competência |
| `409` | Você é `payerId`, não `receiverId`, desta linha (esse lado liquida com comprovante, RN-074); ou competência não fechada; ou residência arquivada; ou linha já liquidada / dispensada |

> **Não existe 409 por "o devedor deste par ainda não anexou"** — RN-076 é explícita: sem ordem
> obrigatória. O credor conhece o extrato dele melhor que o sistema, mesmo por par.
>
> **Esta rota não toca o S3** e continua funcionando com `storageEnabled === false`.

### 6.5 `GET /residences/:code/closures/:period/receipts/:receiptId/url`

URL pré-assinada de leitura, 5 minutos (D-25). Qualquer membro (RN-080).

```jsonc
{ "url": "https://cronos-comprovantes-dev.s3.us-east-2.amazonaws.com/residences/…?X-Amz-…",
  "expiresInSeconds": 300 }
```

- `404` — não é membro, ou o comprovante não existe / não está `STORED`
- `503` — storage indisponível

### 6.6 `POST /residences/:code/closures/:period/settlements/:settlementId/waive`

Dispensa (D-07). **Só o owner** (RN-082). Dispensa a linha **inteira** — os dois lados do par de
uma vez, independente de qual dos dois estava travado.

**Corpo:** `{ "reason": "Morador saiu da residência em setembro" }` — 3 a 200 caracteres.

**200:** `{ "settlement": { "id": "…", "status": "WAIVED", "waivedAt": "…", "waiveReason": "…" }, "closureStatus": "SETTLED" }`

- `403` — não é owner · `404` — não é membro / linha inexistente
- `409` — linha já liquidada (os dois carimbos) ou já dispensada, ou residência arquivada

> Notifica `SETTLEMENT_WAIVED` para **os dois lados do par** — o devedor e o credor daquela
> linha — porque a dispensa muda a pendência dos dois, mesmo que só um deles estivesse travado.

### 6.7 Alteração em `GET /residences/:code/expenses`

Acrescenta o bloco `settlement` à resposta existente, para o badge não custar uma segunda
requisição. **Nenhum campo existente muda.**

```jsonc
"settlement": {         // null quando a competência está aberta OU não tem linhas (legado)
  "status": "AWAITING_PAYMENT",
  "totals": { "payerSide": { "lines": 3, "paid": 1 }, "receiverSide": { "lines": 3, "confirmed": 0 } },
  // "mine" agora é uma lista — você pode estar em mais de um par (D-30).
  // Vazia se você não tem linha nenhuma nesta competência.
  "mine": [
    { "id": "…", "role": "PAYER", "counterpartyName": "Gabriel Mizael", "amountInCents": 21910, "status": "PENDING" },
    { "id": "…", "role": "PAYER", "counterpartyName": "Ana Prado",      "amountInCents": 10762, "status": "SETTLED" }
  ]
}
```

---

# PARTE A — Sua parte (console da AWS)

> Nada aqui é automatizável pelo agente. Faça na ordem; leva algo entre 20 e 40 minutos.

## A.1 — Criar o bucket

Console → **S3** → *Create bucket*:

| Campo | Valor |
| :---- | :---- |
| AWS Region | **US East (Ohio) `us-east-2`** — a mesma da instância |
| Bucket name | `cronos-comprovantes-dev` (nome é global na AWS; se estiver tomado, acrescente sufixo) |
| Object Ownership | **ACLs disabled (Bucket owner enforced)** |
| Block Public Access | **Marque os quatro** |
| Bucket Versioning | **Enable** |
| Default encryption | **SSE-S3 (Amazon S3 managed keys)** |
| Bucket Key | Desabilitado (só faz diferença com SSE-KMS) |

Repita depois para `cronos-comprovantes-prod`, com a mesma configuração.

## A.2 — CORS do bucket

Bucket → aba **Permissions** → *Cross-origin resource sharing (CORS)* → Edit:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000"],
    "AllowedMethods": ["POST"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Location"],
    "MaxAgeSeconds": 3000
  }
]
```

Três coisas que economizam uma tarde:

- **Origem inclui esquema e porta.** `http://localhost:3000` ≠ `http://localhost` ≠ `https://localhost:3000`.
- **Só `POST`.** A leitura acontece via `<img src="…">`, que é navegação, não `fetch` — não passa por
  CORS. Se um dia você buscar o objeto com `fetch`, aí sim acrescente `GET`.
- No bucket de **produção**, a origem é o domínio real do front, não `localhost`.

## A.3 — Usuário IAM só para desenvolvimento

IAM → *Users* → *Create user* → sem acesso ao console → anexe uma política inline:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ComprovantesObjetos",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::cronos-comprovantes-dev/residences/*"
    }
  ]
}
```

Depois: *Security credentials* → *Create access key* → **Application running outside AWS** → guarde
o par (o secret aparece **uma vez só**).

Três detalhes que valem entender, porque vão aparecer nos erros:

1. **`s3:HeadObject` não existe como ação.** Uma requisição `HEAD` é autorizada por `s3:GetObject`.
   Procurar por `s3:HeadObject` na política é um erro comum e silencioso.
2. **Não há `s3:ListBucket` de propósito** (menor privilégio). Efeito colateral: pedir um objeto que
   não existe devolve **`403 AccessDenied`**, não `404 NoSuchKey`. O código trata os dois como "não
   encontrado" — está previsto na Fase 2.
3. **O prefixo `/residences/*` no `Resource`** garante que a aplicação não consegue tocar em nada
   fora da árvore que ela mesma cria.

## A.4 — Regras de ciclo de vida

Bucket → **Management** → *Create lifecycle rule*, duas regras, escopo do bucket inteiro:

| Nome | Ação |
| :---- | :---- |
| `abortar-multipart-incompleto` | *Delete expired object delete markers or incomplete multipart uploads* → **7 dias** |
| `expirar-versoes-antigas` | *Permanently delete noncurrent versions of objects* → **30 dias** |

Nenhuma regra toca a **versão corrente** — comprovante fica para sempre (D-17).

## A.5 — (Opcional, depois que tudo funcionar) Teto de idade de assinatura

Bucket → **Permissions** → *Bucket policy*. Nega qualquer requisição pré-assinada com assinatura de
mais de 10 minutos, mesmo que alguém aumente a validade no código por engano:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NegaAssinaturaVelha",
      "Effect": "Deny",
      "Principal": { "AWS": "*" },
      "Action": "s3:*",
      "Resource": "arn:aws:s3:::cronos-comprovantes-dev/*",
      "Condition": { "NumericGreaterThan": { "s3:signatureAge": "600000" } }
    }
  ]
}
```

> Aplique **só depois** que o fluxo estiver funcionando de ponta a ponta. Bucket policy com `Deny`
> é a forma mais rápida de se trancar do lado de fora e passar uma hora sem entender por quê.

## A.6 — Preencher o `.env` local

```bash
# --- Armazenamento de comprovantes (Amazon S3) ---
# S3_REGION e S3_BUCKET são o par que LIGA o upload (D-18). Deixe os dois em branco para
# rodar sem storage: a API sobe normal, a confirmação de recebimento continua funcionando,
# e só o anexo de comprovante responde 503.
S3_REGION=us-east-2
S3_BUCKET=cronos-comprovantes-dev

# Credenciais explícitas: só em desenvolvimento. Em produção elas ficam VAZIAS e o SDK
# pega a credencial da role da task no ECS (provider chain) — nunca coloque chave de
# acesso longa em produção.
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

# Só para apontar a um S3 compatível (MinIO/LocalStack). Vazio = AWS de verdade.
S3_ENDPOINT=

RECEIPT_MAX_SIZE_BYTES=5242880
RECEIPT_UPLOAD_URL_EXPIRES_IN=300
RECEIPT_DOWNLOAD_URL_EXPIRES_IN=300
```

## A.7 — Verificar que a credencial funciona

```bash
aws s3api head-bucket --bucket cronos-comprovantes-dev --region us-east-2
```

Depois que a Fase 2 estiver pronta, o teste de verdade é o script do projeto:

```bash
npm run storage:test
```

## A.8 — Produção (quando o deploy alcançar esta funcionalidade)

1. **Nada de chave de acesso.** Anexe a política da §A.3 (com o ARN do bucket `-prod`) à **role da
   task do ECS**. O SDK acha a credencial sozinho pela provider chain.
2. `S3_REGION` e `S3_BUCKET` **não são segredo** — vão como `String` comum no SSM Parameter Store.
   `S3_ACCESS_KEY_ID` e `S3_SECRET_ACCESS_KEY` ficam **ausentes**.
3. CORS do bucket de produção aponta para o **domínio real do front**, não `localhost`.
4. A role da task rotaciona credencial a cada 1–6 horas: com URL de 5 minutos gerada sob demanda
   (D-25), isso é invisível. Não aumente essa validade sem reler o §3 da
   [pesquisa de S3](./02-pesquisa-amazon-s3-boas-praticas.md#3-urls-pré-assinadas-as-regras-que-a-documentação-estabelece).

## A.9 — O que **não** muda (verificado na análise)

- Autenticação, refresh token, recuperação de senha: intocados.
- O Route Handler `/api/[...path]` do front continua sendo o único caminho para a API. O S3 é a
  única exceção, e ela é direta do navegador (D-28).
- O `docker-compose.yml` do repositório de deploy **não** ganha serviço novo: o storage é externo.
- Nenhuma variável existente muda de nome, tipo ou valor padrão.

---

# PARTE B — Execução pelo Sonnet 5

> **Instruções para o agente executor.** Este roteiro é normativo: as decisões `D-xx` da §2 já foram
> tomadas e aprovadas — implemente-as, **não as reabra**. Se algo no código contradisser este
> documento, **pare e reporte** em vez de escolher sozinho.
>
> **Regras de execução:**
> 1. **Uma fase por vez.** Ao fim de cada fase, rode o comando de verificação e só siga se estiver
>    verde.
> 2. **Não invente padrão novo.** Cada arquivo novo tem um irmão existente citado na fase — leia o
>    irmão antes de escrever e siga o estilo dele, inclusive a densidade e o tom dos comentários,
>    que neste projeto explicam *por quê*, não *o quê*.
> 3. **Comentários em português**, ancorados na decisão (`//D-23 -> ...`) ou na regra
>    (`//RN-075 -> ...`), do mesmo jeito que o código existente ancora nos `SEC-xx` e `RN-xxx`.
> 4. **Nenhum segredo em log, nunca.** Não logue `S3_SECRET_ACCESS_KEY`, não logue URL pré-assinada
>    inteira (a assinatura é credencial). Chave do objeto pode.
> 5. **Nenhum teste automatizado abre conexão com a AWS.** Storage é sempre injetado como fake.
> 6. **Não rode migration destrutiva** e não toque em migrations existentes.
> 7. **Não mexa no front-end.** A Parte C é do outro repositório.
> 8. Se `storageEnabled === false`, **tudo que não seja anexo/leitura de comprovante continua
>    funcionando** — inclusive a confirmação de recebimento do lado `RECEIVER`, que não toca o S3.
>    Isso é requisito, não cortesia.
> 9. **Não confunda `complete` com `confirm`.** `complete` finaliza um upload (lado pagador);
>    `confirm` é o recebedor declarando que o dinheiro caiu. Nomes distintos, fluxos distintos.

## Fase 0 — Dependências e variáveis de ambiente ✅

**Arquivos:** `package.json`, `src/config/env.ts`, `.env.example`

1. Instale: `npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @aws-sdk/s3-presigned-post`
2. Em [env.ts](../sistema-controle-despesas-api/src/config/env.ts), acrescente ao schema, usando o
   helper `optionalString` que já existe:
   - `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT` — todos
     `optionalString`. `S3_ENDPOINT` validado como `z.url()`.
   - `RECEIPT_MAX_SIZE_BYTES: z.coerce.number().int().positive().default(5242880)`
   - `RECEIPT_UPLOAD_URL_EXPIRES_IN` e `RECEIPT_DOWNLOAD_URL_EXPIRES_IN`, inteiros positivos,
     default `300`. ⚠️ Use o mesmo `preprocess` que `SMTP_PORT` usa: `z.coerce.number()` transforma
     `''` em `0`, e um default nunca dispararia.
3. **Dois `.refine()` novos**, no tom dos que já existem:
   - `S3_REGION` e `S3_BUCKET`: os dois juntos, ou nenhum.
   - `S3_ACCESS_KEY_ID` e `S3_SECRET_ACCESS_KEY`: os dois juntos, ou nenhum.
4. Exporte, no molde de `mailEnabled`:
   ```ts
   export const storageEnabled = env.S3_REGION !== undefined && env.S3_BUCKET !== undefined;
   ```
   Comente por que a credencial **não** entra nessa conta: em produção ela vem da role da task do
   ECS, então exigi-la desligaria a funcionalidade justamente onde ela deve estar ligada.
5. Replique as entradas **em branco** no `.env.example`, com os comentários da §A.6.

**Verificação:**
```bash
npm run build
```
Confirme os dois extremos: com `S3_REGION` e `S3_BUCKET` em branco a API sobe e `storageEnabled` é
`false`; com só um dos dois preenchido, `env.ts` recusa subir com a mensagem do refine.

## Fase 1 — Modelo e migration ✅

**Arquivos:** `prisma/schema.prisma`, `prisma/migrations/`

1. Aplique as alterações da §3 — `MonthClosure.settledAt`, `Settlement` (com `payerId`/`receiverId`,
   sem enum de lado), `PaymentReceipt`, `ReceiptStatus`, relações inversas em `User`, e os quatro
   valores novos de `NotificationType` — **exatamente como escritos, com os comentários**.
2. `npx prisma migrate dev --name add_settlement_tracking`
3. Confira o SQL gerado: só `CREATE TABLE`, `CREATE TYPE`, `CREATE INDEX`,
   `ALTER TABLE ... ADD COLUMN` (nulo) e `ALTER TYPE ... ADD VALUE`. **Nenhum `DROP`, nenhum
   `NOT NULL` sem default em tabela existente.**

**Verificação:**
```bash
npm run build && npm test
```
A suíte inteira precisa continuar verde: a migration não muda comportamento existente.

## Fase 2 — A porta de storage ✅

**Arquivos:** `src/lib/storage.ts`, `src/scripts/testStorage.ts`, `package.json` (script),
`tests/unit/storage.test.ts`

Irmãos a imitar: [mailer.ts](../sistema-controle-despesas-api/src/lib/mailer.ts) (porta com
implementação real e implementação desligada) e
[purgeTokens.ts](../sistema-controle-despesas-api/src/scripts/purgeTokens.ts) (entrypoint fino).

**Interface (normativa):**

```ts
export interface UploadTicket {
  url: string;
  fields: Record<string, string>;
}

export interface StoredObjectInfo {
  contentType: string | null;
  sizeInBytes: number;
}

export interface StoragePort {
  createUploadTicket(input: {
    key: string;
    contentType: string;
    maxSizeInBytes: number;
    expiresInSeconds: number;
  }): Promise<UploadTicket>;

  //Devolve null quando o objeto não existe. Ver nota sobre 403 abaixo.
  headObject(key: string): Promise<StoredObjectInfo | null>;

  //Lê só os primeiros bytes (Range), para conferir a assinatura do arquivo (D-23).
  readFirstBytes(key: string, length: number): Promise<Buffer | null>;

  createDownloadUrl(input: {
    key: string;
    expiresInSeconds: number;
    contentType: string;
    disposition: 'inline' | 'attachment';
    fileName: string;
  }): Promise<string>;

  deleteObject(key: string): Promise<void>;
}

export const storage: StoragePort = storageEnabled ? createS3Storage() : createDisabledStorage();
```

**Pontos de implementação que não são opcionais:**

1. **Um `S3Client` só**, no escopo do módulo. Criar um por requisição desperdiça o pool de conexões.
2. **Credencial:** passe `credentials` explicitamente **apenas** se `S3_ACCESS_KEY_ID` e
   `S3_SECRET_ACCESS_KEY` existirem. Caso contrário, **não passe a opção** — deixe o SDK resolver
   pela provider chain (é assim que a role da task do ECS entra em produção).
3. **`S3_ENDPOINT`**, se presente, vai junto com `forcePathStyle: true` (MinIO exige).
4. **`headObject` trata `403` como `null`**, além de `404` / `NotFound`. Motivo na §A.3: sem
   `s3:ListBucket`, o S3 devolve `AccessDenied` para chave inexistente. Comente isso no código — sem
   o comentário, a próxima pessoa "conserta" tratando 403 como erro e o fluxo quebra.
5. **`createUploadTicket`** usa `createPresignedPost` do `@aws-sdk/s3-presigned-post`. A chamada é
   exatamente esta — foi conferida contra o código do pacote (`3.1116.0`), porque a forma
   "intuitiva" está errada:

   ```ts
   const { url, fields } = await createPresignedPost(s3Client, {
     Bucket: env.S3_BUCKET!,
     Key: key,                                   //parâmetro próprio, NÃO um campo de Fields
     Expires: expiresInSeconds,                  //em segundos; o default do pacote é 3600
     Fields: { 'Content-Type': contentType },
     Conditions: [['content-length-range', 1, maxSizeInBytes]],
   });
   ```

   **Três coisas que o pacote faz sozinho — não as repita:**
   - Ele já acrescenta `{ key: Key }` à política como igualdade exata. Escrever
     `['eq', '$key', key]` em `Conditions` é redundante.
   - Ele já acrescenta **uma igualdade exata para cada entrada de `Fields`**. Então
     `Fields: { 'Content-Type': contentType }` **é** a trava de tipo; `['eq', '$Content-Type', …]`
     também é redundante.
   - Ele já devolve em `fields` tudo que o formulário precisa: `key`, `bucket`, `Policy`,
     `X-Amz-Signature`, `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date` e — quando a credencial
     é temporária, como a role da task do ECS — `X-Amz-Security-Token`.

   O que **não** é automático é o `content-length-range`: ele não é um campo do formulário, só existe
   como condição, e é a única forma de o S3 recusar sozinho um arquivo grande demais. É por isso que
   a decisão foi POST e não PUT (D-13).
6. **`createDownloadUrl`** usa `GetObjectCommand` com `ResponseContentType` e
   `ResponseContentDisposition` (`inline` ou `attachment` + `filename="…"`), assinado com
   `getSignedUrl`. Escape as aspas do nome do arquivo.
7. **`createDisabledStorage()`** lança `AppError(503, 'Armazenamento de comprovantes indisponível.')`
   em toda operação — nunca falha em silêncio.
8. **`src/scripts/testStorage.ts`** + script `"storage:test": "tsx src/scripts/testStorage.ts"`:
   grava um objeto de teste, faz `headObject`, lê os primeiros bytes, gera URL de leitura, apaga, e
   imprime cada passo. É o que a §A.7 usa.
9. **`tests/unit/storage.test.ts`** cobre só o que é puro: a montagem das `Conditions`, o
   `Content-Disposition` por tipo, e que `createDisabledStorage` lança 503. **Nenhuma chamada de
   rede.**

**Verificação:**
```bash
npm test -- storage
```

## Fase 3 — Congelar o rateio no fechamento ✅

**Arquivos:** `src/services/reports/splitService.ts` (novo), `src/services/reports/reportsService.ts`,
`src/services/expenses/expensesService.ts`, `tests/unit/expenses.service.test.ts`

**3.1 — Quebrar o ciclo de importação (faça primeiro).** `reportsService` já importa de
`expensesService`. Se `expensesService` passasse a importar `calculateSplit` de `reportsService`,
haveria ciclo. Então:

1. **Mova** `calculateSplit` (e só ela) para `src/services/reports/splitService.ts`. A função usa
   apenas `prisma` — o arquivo novo não importa nenhum outro service.
2. Em `reportsService.ts`, importe de `splitService.js` e **reexporte**
   (`export { calculateSplit } from './splitService.js'`) para não quebrar nada.
3. Rode `npm test` **antes de continuar**: este passo é um refactor puro e a suíte precisa passar sem
   nenhuma alteração de teste.

**3.2 — `closeMonth` simplifica as dívidas e cria uma linha por par.** Em
[expensesService.ts](../sistema-controle-despesas-api/src/services/expenses/expensesService.ts),
dentro de `closeMonth`, **antes** de criar o `MonthClosure`:

1. `const split = await calculateSplit(context.residence.id, competency.month, competency.year)`
2. **Nova função em `splitService.ts`**, ao lado de `calculateSplit` (D-29):
   ```ts
   export interface DebtPair { payerId: number; receiverId: number; amountInCents: number }

   export function simplifyDebts(
     participants: Array<{ userId: number; balanceInCents: number }>,
   ): DebtPair[] {
     //RN-071 -> saldo zero não entra no algoritmo e não gera par.
     const debtors = participants
       .filter((p) => p.balanceInCents < 0)
       .map((p) => ({ userId: p.userId, remaining: -p.balanceInCents }))
       //Ordem decrescente por valor, userId como desempate — determinístico (D-29).
       .sort((a, b) => b.remaining - a.remaining || a.userId - b.userId);
     const creditors = participants
       .filter((p) => p.balanceInCents > 0)
       .map((p) => ({ userId: p.userId, remaining: p.balanceInCents }))
       .sort((a, b) => b.remaining - a.remaining || a.userId - b.userId);

     const pairs: DebtPair[] = [];
     let i = 0, j = 0;
     while (i < debtors.length && j < creditors.length) {
       const amount = Math.min(debtors[i].remaining, creditors[j].remaining);
       pairs.push({ payerId: debtors[i].userId, receiverId: creditors[j].userId, amountInCents: amount });
       debtors[i].remaining -= amount;
       creditors[j].remaining -= amount;
       if (debtors[i].remaining === 0) i++;
       if (creditors[j].remaining === 0) j++;
     }
     //RN-066 garante soma zero: as duas listas terminam vazias juntas, sem resíduo.
     return pairs;
   }
   ```
3. Monte as linhas: `const pairs = simplifyDebts(split.participants)`.
4. Crie fechamento e acertos numa **única transação**, na forma de **callback**
   (`prisma.$transaction(async (tx) => { … })`) — a forma de array não serve, porque o `closureId`
   só existe depois do `create`. Comente essa razão.
   - `monthClosure.create` com `settledAt: pairs.length === 0 ? new Date() : null` (RN-072)
   - `settlement.createMany` com os pares montados acima (`payerId`, `receiverId`, `amountInCents`)
5. Notificações (D-08), **fora** da transação, como o código já faz hoje:
   - `MONTH_CLOSED` para todos (mantém o comportamento atual, texto intacto)
   - `SETTLEMENT_PENDING`, **uma por pessoa** (RN-083 / D-31): agrupe `pairs` por `payerId` e por
     `receiverId`, monte o texto somando os pares de cada pessoa —
     *"Você deve R$ 219,10 a Gabriel e R$ 107,62 a Ana"* / *"Você tem R$ 150,00 a receber de Bruno"*.
     `linkTo` apontando para `/app/residences/{code}/settlements?mes={month}&ano={year}`

   > Use o prefixo `/app/...` como o código existente já faz: o front traduz em
   > [linkNotificacao.ts](../sistema-controle-despesas-front/src/utils/linkNotificacao.ts).
6. `closeMonth` passa a devolver também `settlementsCreated: pairs.length`.

> **Teste dedicado para `simplifyDebts`**, isolado de `closeMonth`: saldo líquido gera o número
> esperado de pares (no máximo devedores + credores − 1); a soma dos `amountInCents` por devedor
> bate com o valor absoluto do saldo dele; nunca sobra devedor ou credor com `remaining > 0` ao
> final; ordem de entrada não muda o resultado (só a ordenação interna decide).

**3.3 — `reopenMonth` bloqueia (RN-077).** Antes de apagar o fechamento, conte comprovantes `STORED`
daquele fechamento. Se houver algum:
`throw new AppError(409, 'Este mês já tem comprovante de pagamento anexado e não pode ser reaberto.')`

**Verificação:**
```bash
npm run build && npm test
```
Acrescente casos unitários: fechamento sem saldo diferente de zero nasce com `settledAt`; fechamento
com 2 devedores e 2 credores cria as linhas de par com `payerId`/`receiverId`/`amountInCents`
corretos; a soma de `amountInCents` por devedor bate com o saldo dele; reabrir com comprovante
`STORED` devolve 409.

## Fase 4 — Service de acertos ✅

**Arquivos:** `src/services/payments/settlementsService.ts`, `tests/unit/settlements.service.test.ts`

Irmão a imitar:
[expensesService.ts](../sistema-controle-despesas-api/src/services/expenses/expensesService.ts) — o
mesmo formato de "carrega contexto, valida regra, age".

**Assinaturas (normativas):**

```ts
export async function getClosureSettlements(code: string, userId: number, period: Competency)
export async function createReceiptIntent(code: string, userId: number, period: Competency, settlementId: string, input: ReceiptIntentInput)
export async function completeReceipt(code: string, userId: number, period: Competency, settlementId: string, receiptId: string)
export async function confirmReceived(code: string, userId: number, period: Competency, settlementId: string)
export async function getReceiptDownloadUrl(code: string, userId: number, period: Competency, receiptId: string)
export async function waiveSettlement(code: string, userId: number, period: Competency, settlementId: string, reason: string)
export async function getCompetencySettlementSummary(residenceId: number, month: number, year: number, userId: number)
```

**Regras que o executor precisa acertar:**

1. **Toda função começa com `loadUserResidenceContext(code, userId)`.** É o que garante o 404 do
   RN-080 sem escrever autorização nova.
2. **Estado derivado num só lugar.** Escreva as funções puras abaixo e **não duplique** essas
   expressões em nenhum outro lugar do código:
   ```ts
   //D-30 -> uma linha (par) está liquidada quando os DOIS carimbos existem, ou quando
   //foi dispensada. Um só carimbo não basta -- não há ordem entre eles (RN-076).
   function isPairSettled(s): boolean {
     return s.waivedAt !== null || (s.paidAt !== null && s.confirmedAt !== null);
   }

   function closureStatus(settlements): 'AWAITING_PAYMENT' | 'AWAITING_CONFIRMATION' | 'SETTLED' {
     if (settlements.every(isPairSettled)) return 'SETTLED';       //inclui a lista vazia
     //RN-071: falta ALGUM devedor anexar, em qualquer par -- não importa se o credor
     //daquele par já confirmou.
     if (settlements.some((s) => s.waivedAt === null && s.paidAt === null)) return 'AWAITING_PAYMENT';
     return 'AWAITING_CONFIRMATION';
   }
   ```
3. **`createReceiptIntent`:**
   - `settlement.payerId !== userId` → 403 (RN-074: você precisa ser o devedor **deste par**)
   - `context.isArchived` → 409 (RN-078); competência sem `MonthClosure` → 409 (RN-069)
   - `settlement.paidAt !== null` **não** é erro -- reenviar antes do `complete` é normal;
     `settlement.waivedAt !== null` → 409
   - `receiptId = randomUUID()`, chave montada como em D-27, extensão derivada do `contentType`
     por um mapa explícito (`image/jpeg → jpg`), **nunca** do `originalName`
   - grava `PaymentReceipt` com `status: 'PENDING'` **antes** de assinar. Se a assinatura falhar, a
     linha vira órfã e a purga limpa — o contrário (assinar e não gravar) deixaria objeto no bucket
     sem nenhum registro
4. **`completeReceipt`** — a função mais delicada, nesta ordem exata:
   - Carrega o `PaymentReceipt` com o acerto. Se não existe, não é seu, ou o fechamento é outro → 404
   - **Se já está `STORED`, devolve 200 com o estado atual** (idempotência: o front pode reenviar
     depois de um timeout de rede, e um 409 aqui viraria um erro visível sem nada de errado ter
     acontecido)
   - `storage.headObject(key)` → `null` significa 404
   - `info.sizeInBytes > env.RECEIPT_MAX_SIZE_BYTES` → 422
   - `info.contentType !== receipt.declaredContentType` → 422
   - `storage.readFirstBytes(key, 12)` e compara com a assinatura do tipo declarado (tabela em
     [`02-… §6`](./02-pesquisa-amazon-s3-boas-praticas.md#6-segurança-do-conteúdo-o-furo-do-upload-direto-e-como-fechá-lo-barato)).
     Não bateu → 422
   - Em **qualquer** 422: **não** apague o objeto direto. Deixe o registro em `PENDING` e chame
     `logSecurityEvent('receipt_content_mismatch', { receiptId, settlementId, declared, actual })` —
     a purga (Fase 7) remove depois. Motivo: apagar dentro do request transforma um erro do usuário
     numa operação destrutiva no caminho quente
   - Sucesso → transação: `receipt.status = 'STORED'` + `storedAt`, `contentType`, `sizeInBytes`;
     `settlement.paidAt = now()` **se ainda for null** (D-11); recalcula o fechamento
   - **Depois** da transação, fora dela, as notificações — ver item 6
5. **`confirmReceived`** — a ação do credor **deste par**, e a mais simples do arquivo:
   - `settlement.receiverId !== userId` → 403 (RN-074: esse lado liquida com comprovante, não você)
   - já liquidada (os dois carimbos) ou dispensada → 409; arquivada → 409
   - **Nenhuma checagem de ordem** — RN-076 é explícita. Não verifique se `paidAt` já existe
   - **Não toca o S3.** Esta função precisa funcionar com `storageEnabled === false`
   - Grava `confirmedAt` e recalcula o fechamento
6. **Notificações de transição, num helper compartilhado** por `completeReceipt`, `confirmReceived` e
   `waiveSettlement` — as três podem provocar a mesma transição:
   - Depois de `completeReceipt`, para **cada credor distinto** entre as linhas afetadas: se todas
     as linhas em que ele é `receiverId` nesta competência têm `paidAt` ou `waivedAt` preenchido
     **agora** (e não tinham todas antes), publique `SETTLEMENT_READY` (D-32/RN-084) — uma vez por
     credor, não uma vez por linha
   - Se o `closureStatus` do fechamento **passou** para `SETTLED` agora → grava `closure.settledAt`
     e publica `MONTH_SETTLED` para todos os membros
   - **"Passou agora" é o ponto**, nos dois casos. Compare o estado antes e depois; publicar pelo
     estado atual notificaria de novo a cada comprovante extra (D-11) ou a cada linha já resolvida
7. **`getReceiptDownloadUrl`:** só comprovante `STORED`; `disposition` é `attachment` para
   `application/pdf` e `inline` para os três tipos de imagem.
8. **`waiveSettlement`:** `context.isOwner` obrigatório (403 se não); linha já liquidada (os dois
   carimbos) ou já dispensada → 409; dispensa a linha **inteira**, independente de qual carimbo
   faltava (RN-082); grava `waivedAt`, `waivedById`, `waiveReason`; recalcula; notifica
   `SETTLEMENT_WAIVED` para **os dois lados do par** (`payerId` e `receiverId` daquela linha).
9. **`getCompetencySettlementSummary`** é usada pela Fase 6 dentro de `listExpensesForCompetency`.
   Devolve a lista `mine` (§6.7), filtrando `Settlement` por `payerId = userId OR receiverId = userId`.
   Precisa ser **barata**: uma consulta agregada, nunca uma varredura de comprovantes.

**Verificação:**
```bash
npm test -- settlements
```
Com o storage **fake injetado**. Cubra pelo menos: devedor anexa e a linha vira `AWAITING_CONFIRMATION`
(RN-074); credor confirma em seguida e a linha vira `SETTLED`; o `receiverId` de uma linha tentando
`/receipts` recebe 409 e o `payerId` tentando `/confirm` recebe 409; um membro que não é `payerId`
nem `receiverId` daquela linha recebe 403; competência aberta recebe 409; credor confirma **antes**
do devedor anexar e recebe 200 (RN-076), e a linha vira `SETTLED` quando o `paidAt` chegar depois;
magic bytes errados devolvem 422 com a linha ainda pendente; `complete` duas vezes devolve 200 nas
duas; um credor com pares de 2 devedores diferentes só recebe `SETTLEMENT_READY` quando **os dois**
tiverem `paidAt` (RN-084); último par liquidado marca o mês como quitado e publica `MONTH_SETTLED`
**uma vez só**.

## Fase 5 — Schemas, controller e rotas ✅

**Arquivos:** `src/schemas/acertos.ts`, `src/controllers/payments/settlementsController.ts`,
`src/routes/payments/settlementsRoutes.ts`, `src/app.ts`,
`src/controllers/expenses/expensesController.ts`, `tests/unit/acertos.schemas.test.ts`

1. **`src/schemas/acertos.ts`** — irmão: [despesas.ts](../sistema-controle-despesas-api/src/schemas/despesas.ts)
   ```ts
   export const RECEIPT_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

   export const receiptIntentSchema = z.object({
     contentType: z.enum(RECEIPT_CONTENT_TYPES, { message: 'Formato não suportado. Envie JPEG, PNG, WebP ou PDF.' }),
     sizeInBytes: z.number().int().positive().max(5 * 1024 * 1024, 'O comprovante deve ter no máximo 5 MB'),
     originalName: z.string().trim().max(120).optional(),
   });

   export const waiveSettlementSchema = z.object({
     reason: z.string().trim().min(3, 'Explique o motivo da dispensa').max(200),
   });
   ```
2. **Controller** — irmão:
   [expensesController.ts](../sistema-controle-despesas-api/src/controllers/expenses/expensesController.ts).
   **Extraia `parsePeriodParam` para um utilitário compartilhado** e importe nos dois controllers —
   não duplique o parser.
3. **Rotas** — irmão:
   [expensesRoutes.ts](../sistema-controle-despesas-api/src/routes/expenses/expensesRoutes.ts):
   ```ts
   router.use(requireAuth);
   router.get('/:code/closures/:period/settlements', listSettlements);
   router.post('/:code/closures/:period/settlements/:settlementId/receipts', validateBody(receiptIntentSchema), createIntent);
   router.post('/:code/closures/:period/settlements/:settlementId/receipts/:receiptId/complete', completeUpload);
   router.post('/:code/closures/:period/settlements/:settlementId/confirm', confirmReceived);
   router.post('/:code/closures/:period/settlements/:settlementId/waive', validateBody(waiveSettlementSchema), waive);
   router.get('/:code/closures/:period/receipts/:receiptId/url', downloadUrl);
   ```
4. Em `src/app.ts`, `app.use('/residences', settlementsRoutes)`, **depois** de `expensesRoutes`.
5. Acrescente `'receipt_content_mismatch'` à union `SecurityEventName` em
   [logger.ts](../sistema-controle-despesas-api/src/utils/logger.ts), com comentário no tom dos
   existentes.

**Verificação:**
```bash
npm run build && npm test
```

## Fase 6 — Integração com o que já existe ✅

**Arquivos:** `src/services/expenses/expensesService.ts`, `tests/integration/expenses.test.ts`

1. Em `listExpensesForCompetency`, acrescente `settlement` à resposta (§6.7). Busque em **paralelo**,
   dentro do `Promise.all` que já existe — não acrescente um round trip serial.
2. `settlement` é `null` quando a competência está aberta **ou** quando o fechamento não tem linhas
   (D-09). Comente essa segunda condição citando D-09; sem o comentário ela parece bug.
3. **Nenhum campo existente da resposta muda.** O front atual precisa continuar funcionando sem
   nenhuma alteração.

**Verificação:**
```bash
npm test -- expenses
```

## Fase 7 — Purga de comprovantes órfãos ✅

**Arquivos:** `src/utils/receiptPurge.ts`, `src/scripts/purgeTokens.ts`,
`tests/unit/receiptPurge.test.ts`

Irmão a imitar, quase linha a linha:
[tokenPurge.ts](../sistema-controle-despesas-api/src/utils/tokenPurge.ts) — fábrica com dependências
injetadas, para o teste não precisar nem de banco nem de rede.

1. `purgeOrphanReceipts({ prisma, storage, olderThanHours = 24 })`: busca `PaymentReceipt` com
   `status: 'PENDING'` e `createdAt` anterior ao corte; para cada um, `storage.deleteObject(key)` e
   depois apaga a linha.
2. **Uma falha no S3 não pode abortar o lote.** Trate por item, conte sucessos e falhas, devolva o
   resumo. Um objeto que já não existe conta como sucesso.
3. Chame a função no `purgeTokens.ts` existente, no mesmo lote das outras purgas, **só quando
   `storageEnabled`**.

**Verificação:**
```bash
npm test -- receiptPurge
```

## Fase 8 — Testes de integração ✅

**Arquivo:** `tests/integration/settlements.test.ts`

Irmão: [expenses.test.ts](../sistema-controle-despesas-api/tests/integration/expenses.test.ts).
O storage é substituído por um **fake em memória**; nenhuma chamada sai da máquina.

Cobertura mínima:

- [ ] Não-membro recebe **404** em todas as 6 rotas (RN-080)
- [ ] Competência **aberta** recusa intenção de upload e confirmação com 409 (RN-069)
- [ ] Fechar mês com 2 devedores e 2 credores cria as linhas de **par** que `simplifyDebts` produz
      (D-29), com `payerId`/`receiverId`/`amountInCents` corretos (RN-070, RN-071)
- [ ] Participante com saldo **zero** não entra no algoritmo e não gera par (RN-071)
- [ ] Fechar mês sem saldo diferente de zero nasce **quitado** (RN-072)
- [ ] Devedor de um par anexa e completa → aquela linha vira `AWAITING_CONFIRMATION`; status do mês
      continua `AWAITING_PAYMENT` enquanto **outra** linha ainda não tiver `paidAt`
- [ ] Uma pessoa devedora em 2 pares: `SETTLEMENT_READY` só é publicado para o(s) credor(es) dela
      quando **os dois** pares dela tiverem `paidAt` — nunca no primeiro (D-32/RN-084)
- [ ] Credor confirma um par → aquela linha vira `SETTLED`; último par de todo o fechamento →
      mês `SETTLED` e `MONTH_SETTLED` publicado **uma vez só**
- [ ] Credor confirma **antes** do devedor daquele par anexar → **200** (RN-076), e a linha vira
      `SETTLED` quando o `paidAt` chegar depois
- [ ] `payerId` de uma linha chamando `/confirm` → 409; `receiverId` da mesma linha chamando
      `/receipts` → 409
- [ ] Membro que não é `payerId` nem `receiverId` daquela linha recebe 403 nas duas ações
      (RN-074, RN-075)
- [ ] `complete` com magic bytes divergentes → **422**, linha continua com `paidAt = null`
- [ ] `complete` duas vezes → 200 nas duas, sem duplicar comprovante nem notificação
- [ ] Reabrir mês com comprovante `STORED` → **409** (RN-077)
- [ ] Residência arquivada recusa anexo e confirmação com 409, mas a **leitura continua 200** (RN-078)
- [ ] Dispensa: só o owner (403 para os outros); dispensa a linha **inteira**, mesmo com só um dos
      dois carimbos preenchido; linha vira `WAIVED`, nunca `SETTLED` (RN-082); notifica os dois lados
      do par; dispensar a última pendência quita o mês
- [ ] Uma pessoa com 3 pares no mesmo fechamento recebe **uma única** notificação
      `SETTLEMENT_PENDING`, somando os 3 valores (D-31/RN-083)
- [ ] Com `storageEnabled = false`: intenção e URL devolvem **503**, mas
      `POST .../settlements/:id/confirm`, `GET .../settlements`, fechamento de mês e listagem de
      despesas continuam **200**

**Verificação:**
```bash
npm test
```

## Fase 9 — Documentação ✅

**Arquivos:** `README.md` (API), `.env.example`, `docs/`

1. Seção nova no README da API descrevendo a funcionalidade, as 6 rotas e o grupo de variáveis do
   S3, no tom das seções existentes.
2. `.env.example` conferido contra a §A.6 — todas as variáveis presentes e **em branco**.
3. Copie este documento para `sistema-controle-despesas-api/docs/plano-registro-de-pagamentos.md`,
   marcando cada fase concluída com ✅ (foi o que o plano de recuperação de senha fez).

**Verificação:**
```bash
npm run build && npm test && npm run test:coverage
```

## Checklist de aceite (o executor deve reportar item a item) ✅

- [x] `npm run build` limpo
- [x] `npm test` verde, incluindo os testes novos (333 testes, 33 suítes)
- [x] A API sobe com `S3_REGION` e `S3_BUCKET` **em branco**, e só o anexo/leitura de comprovante
      responde 503 — a confirmação de recebimento continua funcionando
- [x] A API **recusa** subir com apenas uma das duas preenchida
- [x] Nenhum teste automatizado abre conexão de rede (storage sempre trocado por
      `tests/helpers/fakeStorage.ts` via `setStorageForTests`)
- [x] A migration só adiciona: nenhum `DROP`, nenhuma coluna `NOT NULL` sem default
- [x] Nenhum campo existente de resposta HTTP mudou de nome, tipo ou semântica
- [x] `calculateSplit` foi movida para `splitService.ts` **e reexportada** — nenhum import quebrado
- [x] `simplifyDebts` não deixa devedor nem credor com saldo residual (D-29)
- [x] `closureStatus` e `isPairSettled` existem em **um único lugar** (`settlementsService.ts`) e
      são usadas por todos os pontos
- [x] `SETTLEMENT_READY` é publicado **por credor** (RN-084), `SETTLEMENT_PENDING` é **uma
      notificação por pessoa** (RN-083), e ambos disparam **na transição**, nunca por estado atual
- [x] Nenhuma URL pré-assinada aparece em log
- [x] Comentários em português, ancorados em `D-xx` / `RN-xxx`
- [x] Nenhum arquivo do repositório do front-end foi tocado

---

# PARTE C — Contrato com o front-end

> Fora do escopo da API. Registrado aqui porque a API define o contrato. Cada item mira um arquivo
> que já existe no repositório do front.

## C.1 — O badge de estado da competência

Hoje [`ResumoDoMes.tsx`](../sistema-controle-despesas-front/src/app/dashboard/residences/%5Bcode%5D/ResumoDoMes.tsx)
mostra um selo `fechado` quando `resumo.isClosed`. Ele passa a ter **quatro** estados, alimentados
pelo bloco `settlement` de `GET /residences/:code/expenses` (§6.7) — **sem requisição extra**:

| Condição | Selo | Tom |
| :---- | :---- | :---- |
| `!isClosed` | *(nenhum)* | — |
| `isClosed && settlement === null` | `fechado` | neutro (fechamento legado ou sem acerto) |
| `status === 'AWAITING_PAYMENT'` | `aguardando pagamento · 1 de 2` | atenção |
| `status === 'AWAITING_CONFIRMATION'` | `aguardando confirmação · 0 de 2` | atenção, tom distinto |
| `status === 'SETTLED'` | `mês quitado` | positivo |

E o card de saldo pessoal ganha a chamada direta, somando as linhas de `settlement.mine` (agora uma
**lista** — D-30, você pode estar em mais de um par):

- Só linhas `role: 'PAYER'`, alguma `PENDING` → *"Você deve R$ 326,72, em 2 pagamentos ·
  **Ver acertos**"* (o total soma os pares; o botão leva para C.2, onde cada par se anexa
  separadamente)
- Só linhas `role: 'RECEIVER'`, alguma `PENDING` → *"Você tem R$ 219,10 a receber, de 2 pessoas ·
  **Ver acertos**"*
- Uma pessoa nunca tem `PAYER` e `RECEIVER` misturados no mesmo fechamento (D-29 opera sobre o saldo
  líquido) — não desenhe esse caso.

## C.2 — A tela de acertos

Rota nova: `/dashboard/residences/[code]/settlements?mes=&ano=`, Server Component consumindo
`GET .../closures/:period/settlements`. Cada item da lista agora é um **par**, não uma pessoa —
a tela deixa de ter duas colunas fixas "quem paga / quem recebe" e passa a listar as **linhas**,
com destaque para as que envolvem você:

```
┌─ SEUS ACERTOS ────────────────────────────────────────────────────────┐
│  Você deve → Gabriel Mizael        R$ 219,10   ⏳  [ Anexar comprovante ]│
│  Você deve → Ana Prado             R$ 107,62   ✅  há 2 horas           │
└─────────────────────────────────────────────────────────────────────────┘
┌─ TODOS OS ACERTOS DO MÊS ──────────────────────────────────────────────┐
│  Letícia Rocha  →  Gabriel Mizael     R$ 219,10   ✅ pago · aguardando  │
│                                                       confirmação de Gabriel │
│  Bruno Alves    →  Ana Prado          R$ 107,62   ✅ liquidado          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Cada linha tem dois indicadores independentes** (D-30): "comprovante anexado" (o que o devedor
fez) e "recebimento confirmado" (o que o credor fez) — nunca um selo só, porque os dois podem
acontecer em qualquer ordem (RN-076).

**Texto explicando o par (custo de D-01=B, previsto na pesquisa 01 §3.1):** como os pares vêm de um
algoritmo de saldos e não de quem gastou com quem, inclua uma linha discreta de ajuda na primeira
visita à tela: *"Os pares acima foram calculados para minimizar o número de transferências — nem
sempre são entre quem realmente dividiu uma despesa junto."* Sem isso, "por que estou pagando a Ana
e não ao Gabriel?" vira ticket de suporte.

**Não acrescente item na navegação do `AppShell` nesta versão.** A tab bar do mobile já está com 4
itens, e resolver isso é decisão de UI própria. A tela é alcançada por dois caminhos, que bastam: o
botão dentro da tela de despesas quando a competência está fechada, e o `linkTo` das notificações
`SETTLEMENT_PENDING` e `SETTLEMENT_READY`.

Como a competência vem da URL, o requisito *"os usuários devem poder consultar os comprovantes quando
quiser"* já está atendido: qualquer mês fechado é acessível pelo mesmo seletor de competência que a
tela de despesas usa.

## C.3 — A confirmação de recebimento

É a ação mais simples do fluxo — e a mais fácil de errar por ser irreversível na V1 (D-10). Age
sobre **uma linha (um par) por vez** — quem é credor de duas pessoas confirma duas vezes,
separadamente.

- Um `POST` sem corpo, via Server Action, no molde de
  [fecharMesAction.ts](../sistema-controle-despesas-front/src/app/dashboard/residences/%5Bcode%5D/expenses/fecharMesAction.ts)
- **Passe por `ConfirmacaoModal.tsx`**, que o projeto já tem: *"Confirmar que você recebeu
  R$ 219,10 de Letícia Rocha? Isso não pode ser desfeito."* — **nomeie o devedor daquele par**, não
  fale em termos genéricos de "o pagamento", porque a pessoa pode ter mais de um pendente
- Mostre as miniaturas dos comprovantes **daquele par**, na mesma tela, antes do botão — é o que a
  pessoa olha para decidir
- **Não bloqueie o botão** enquanto o devedor daquele par não tiver anexado (RN-076). No máximo, um
  aviso discreto: *"Letícia ainda não anexou o comprovante deste pagamento."*

## C.4 — O upload: os quatro passos, e o que quebra em cada um

Esta é a única parte do front que fala com um domínio que não é o próprio (D-28).

```ts
// 1) Comprimir e normalizar ANTES de qualquer requisição (D-19)
//    createImageBitmap + canvas → WebP, lado maior ~1600px, alvo ~300 KB.
//    Redesenhar no canvas descarta o EXIF junto — inclusive o GPS. PDF não passa por aqui.

// 2) Pedir a intenção à API (mesma origem, via apiFetchClient)
const { receiptId, upload } = await apiFetchClient(
  `/residences/${code}/closures/${periodo}/settlements/${settlementId}/receipts`,
  { method: 'POST', body: { contentType, sizeInBytes, originalName } },
);

// 3) POST direto no S3 — cross-origin, SEM credenciais, com o arquivo POR ÚLTIMO
const form = new FormData();
for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
form.append('file', arquivo);                       // ⚠️ SEMPRE o último campo
await fetch(upload.url, { method: 'POST', body: form });   // ⚠️ NÃO use credentials: 'include'

// 4) Completar na API — só aqui a linha liquida
await apiFetchClient(
  `/residences/${code}/closures/${periodo}/settlements/${settlementId}/receipts/${receiptId}/complete`,
  { method: 'POST' },
);
```

**As quatro armadilhas, na ordem em que costumam aparecer:**

1. **`file` tem que ser o último campo do `FormData`.** O S3 ignora tudo que vier depois dele. Um
   campo fora de ordem produz erro de política que não menciona ordem nenhuma.
2. **Nunca `credentials: 'include'` no passo 3.** Mandar cookie para a AWS não ajuda em nada e
   atrapalha o CORS.
3. **Não use `apiFetchClient` no passo 3.** Ele prefixa `/api` e trata 401 com refresh — nenhuma das
   duas coisas faz sentido contra o S3. Use `fetch` puro.
4. **Se o passo 4 falhar, tente de novo o passo 4**, não o 3. O objeto já está no bucket, e o
   `complete` é idempotente. Refazer o 3 gera um objeto duplicado.

## C.5 — Exibir o comprovante

O front recebe só o `receiptId`. Para mostrar, pede `GET .../receipts/:receiptId/url` e usa a URL
devolvida direto no `<img src>` — **sem** `fetch`, o que evita CORS na leitura (§A.2). A URL vale 5
minutos: peça no momento de exibir, **nunca** guarde em estado de longa duração nem em cache do Next.

Para PDF, a API devolve URL com `Content-Disposition: attachment` — abra em nova aba, não tente
embutir.

## C.6 — Tipos, API client e notificações

- `src/types/acerto.ts` (novo):
  ```ts
  // Não há mais "lado" como campo do acerto — cada linha já tem payer e receiver
  // explícitos (D-30). "Meu lado" é derivado comparando com o usuário logado.
  export type StatusAcerto = 'PENDING' | 'AWAITING_CONFIRMATION' | 'SETTLED' | 'WAIVED';
  export type StatusFechamento = 'AWAITING_PAYMENT' | 'AWAITING_CONFIRMATION' | 'SETTLED';
  ```
  mais `Acerto` (com `payer`, `receiver`, `amountInCents`, `paidAt`, `confirmedAt`),
  `ComprovantePagamento`, `ResumoAcertos`
- `src/types/notificationType.ts`: acrescentar `SETTLEMENT_PENDING`, `SETTLEMENT_READY`,
  `MONTH_SETTLED`, `SETTLEMENT_WAIVED`
- `src/lib/acertosApi.ts` (novo), no molde de
  [expensesApi.ts](../sistema-controle-despesas-front/src/lib/expensesApi.ts): traduz os nomes da API
  para os nomes em português usados no front — é onde `SETTLED` vira "liquidado" (D-20)
- Server Actions: `anexarComprovanteAction`, `confirmarRecebimentoAction`, `dispensarAcertoAction`

## C.7 — Mensagens de erro que a interface precisa tratar

| Situação | O que o usuário deve ler |
| :---- | :---- |
| `503` do storage | "O envio de comprovantes está indisponível no momento. Tente mais tarde." |
| `422` no `complete` | "O arquivo enviado não pôde ser validado. Tente enviar novamente." |
| `409` de competência aberta | "O mês precisa ser fechado antes de registrar acertos." |
| `409` de lado errado | Não deve acontecer pela interface — se acontecer, é bug do front mostrando o botão errado. Logue |
| `409` ao reabrir | "Este mês já tem comprovante anexado e não pode ser reaberto." |
| Falha de rede no passo 3 | "Não foi possível enviar o arquivo. Verifique sua conexão." + botão de tentar de novo |

---

## 7. O que este plano deliberadamente **não** faz

Registrado para não parecer esquecimento:

| Fora de escopo | Por quê |
| :---- | :---- |
| Solução ótima de minimização de transferências | D-29. O guloso é heurístico, não provadamente mínimo — ver a nota de honestidade em D-29 |
| Contestação / desfazer liquidação | D-10. Com este modelo, vira uma coluna a mais depois — [§3.6 da pesquisa](./01-pesquisa-apps-similares-e-fluxos.md#36-extensão-natural-para-depois--janela-de-contestação) |
| Pagamento parcial | D-11. N comprovantes na mesma linha já cobrem o caso real |
| Histórico global de acertos entre residências | Fora do que você descreveu; a consulta por competência já atende o requisito 3 |
| Integração com Pix (QR Code / copia-e-cola) | Exigiria guardar chave Pix no perfil — mais dado sensível, decisão própria |
| Varredura antivírus dos anexos | Desproporcional para o cenário; as quatro camadas do §6 da pesquisa impedem execução |
| CloudFront na frente do bucket | D-28. Jogaria fora o isolamento de origem, que é a defesa mais barata que existe aqui |
| Item novo na navegação do `AppShell` | C.2. A tab bar do mobile já está cheia; é decisão de UI própria |
