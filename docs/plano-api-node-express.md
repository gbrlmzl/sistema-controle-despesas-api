# Plano: API Node.js + Express separada do Next.js

> Documento de planejamento. Nada foi implementado ainda. Objetivo duplo e explícito: (1)
> aprender Node.js "de verdade" com Express, sem a abstração do runtime do Next.js por baixo, e
> (2) ter uma API REST real para aplicar os cursos 3 e 4 do cronograma de testes (que assumem
> Express + Supertest).

## 1. Decisão de escopo — confirmada

> **Decisão confirmada (2026-08-07): Escopo B, em fases incrementais.** As seções abaixo mantêm o
> raciocínio original por trás dessa escolha; a incerteza foi resolvida.

A ideia original ("remover as rotas de API do Next e criar um servidor Express com as mesmas
funcionalidades") admitia duas leituras muito diferentes em tamanho, e a escolha entre elas muda
o resto deste plano (e é pré-requisito para a decisão do [documento de arquitetura de
frontend](decisao-arquitetura-frontend.md)):

| Escopo | O que migra | Tamanho |
| :---- | :---- | :---- |
| **A — Só os Route Handlers** | Os 4 endpoints hoje em `src/app/api/**` (notifications, residences, users/me, nextauth) | Pequeno (dias) |
| **B — Tudo que é servidor** | Os 4 Route Handlers **+** as 23 Server Actions de `src/app/(auth)/**` | Grande (semanas) |

**Por quê isso importa:** hoje, a maior parte da lógica de escrita do sistema não passa pelos 4
Route Handlers — passa pelas 23 Server Actions (`'use server'`), que são um mecanismo RPC do
próprio Next.js, não uma API REST. Se o escopo for só A, o Next.js continua sendo um framework
full-stack de verdade (as Server Actions continuam rodando no servidor Next.js), e a pergunta do
documento de arquitetura ("ainda compensa usar Next.js, ou um SPA mais leve resolve?") não tem uma
resposta honesta — Next.js ainda estaria fazendo trabalho de back-end de qualquer forma.

**Por que essa escolha:** Escopo B, em fases incrementais (seção 6), migrando um domínio por vez e
trocando as chamadas de Server Action por `fetch()` no front-end conforme cada domínio sai do
Next.js — mas só depois que **todo** o backend (fases 1-5) estiver pronto e testado (ver seção 6).
Isso dá o aprendizado completo de Node/Express, dá o "peso" de API real que os cursos 3 e 4
esperam, e só então a pergunta de arquitetura do outro documento faz sentido com evidência real na
mão (você vai sentir, na prática, se o Next.js ainda está "pagando o aluguel dele" uma vez que
toda a busca de dados virar `fetch()`).

Se o tempo apertar no meio do caminho, dá pra pausar ao final de qualquer fase da seção 6 com o
sistema ainda funcional — o Escopo A (só os 4 Route Handlers) fica registrado aqui como a
alternativa de corte, não como algo em avaliação agora.

## 2. Inventário completo do que existe hoje

### 2.1 Route Handlers (`src/app/api/**`, 4 arquivos)

| Rota atual | Método | Endpoint REST proposto | Descrição |
| :---- | :---- | :---- | :---- |
| `api/auth/[...nextauth]` | GET/POST | *(substituído — ver seção 5)* | Handlers do NextAuth |
| `api/notifications` | GET | `GET /notifications?pagina=` | Lista notificações + não lidas |
| `api/notifications` | PATCH | `PATCH /notifications` | Marca como lida(s) |
| `api/residences` | GET | `GET /residences` | Lista residências + convites/solicitações do usuário |
| `api/users/me` | PATCH | `PATCH /users/me` | Troca o avatar |

### 2.2 Server Actions (`src/app/(auth)/**`, 23 arquivos) → endpoints REST propostos

> **Revisão (2026-08-07):** a proposta original tinha verbos no path (`/join`, `/respond`,
> `/leave`, `/regenerate-code`, `/transfer-ownership`, `/archive`, `/close-month`,
> `/stop-recurrence`). Em REST a URL identifica um **recurso**, não uma chamada de função — o
> verbo já está no método HTTP (`POST`/`PATCH`/`DELETE`). A tabela abaixo troca cada verbo por um
> recurso: às vezes um substantivo novo (ex.: "join-request"), às vezes uma transição de estado no
> recurso existente (`PATCH` com um campo `status`), às vezes um sub-recurso singleton que se
> substitui por inteiro (`PUT`).

**Auth / usuário**

> **Exceção deliberada (2026-08-07):** login/registro/logout ficam em `/auth/...`, com verbo no
> path mesmo. Autenticação não é um recurso CRUD — é uma ação sobre a sessão do cliente — e
> `/auth/login`, `/auth/register`, `/auth/logout` é convenção pragmática comum (Auth0, Firebase,
> boilerplates de Node/Express em geral), mais legível do que forçar login/logout no molde de
> criar/destruir um recurso "session". O resto da seção 2.2 continua evitando verbo.

| Action atual | Endpoint REST proposto | Padrão aplicado |
| :---- | :---- | :---- |
| `loginAction` | `POST /auth/login` | exceção — ver nota acima |
| `registerAction` | `POST /auth/register` | exceção — ver nota acima |
| *(novo, seção 5.1)* | `POST /auth/refresh` | exceção — ver nota acima; troca refresh token por um par novo |
| `changePasswordAction` | `PATCH /users/me/password` | já era substantivo, mantido |
| `logoutAction` | `POST /auth/logout` | exceção — ver nota acima |

**Residências (nível raiz)**

| Action atual | Endpoint REST proposto | Padrão aplicado |
| :---- | :---- | :---- |
| `criarResidenciaAction` | `POST /residences` | já era substantivo, mantido |
| `entrarResidenciaAction` | `POST /residences/join-requests` (body: `{ codigo }`) | entrar = criar uma solicitação de entrada |
| `cancelarSolicitacaoAction` | `DELETE /residences/join-requests/:id` | já era substantivo, mantido |
| `responderConviteAction` | `PATCH /residences/invites/:id` (body: `{ status: "aceito" \| "recusado" }`) | responder = transição de estado do convite |

**Residências (dentro do contexto `[code]`)**

| Action atual | Endpoint REST proposto | Padrão aplicado |
| :---- | :---- | :---- |
| *(painel)* | `GET /residences/:code` | — |
| `renomearResidenciaAction` + `arquivarResidenciaAction` | `PATCH /residences/:code` (body: `{ nome?, status? }`) | duas actions viram um único update parcial do recurso |
| `regenerarCodigoAction` | `POST /residences/:code/code` | gera um valor novo a cada chamada — não é idempotente, então `POST`, não `PUT` (ver nota abaixo) |
| `sairDaResidenciaAction` | `DELETE /residences/:code/members/me` | sair = remover a própria associação (mesma convenção de `/users/me`) |
| `removerMembroAction` | `DELETE /residences/:code/members/:userId` | já era substantivo, mantido |
| `transferirPropriedadeAction` | `PUT /residences/:code/owner` (body: `{ userId }`) | dono é um sub-recurso singleton, `PUT` substitui |
| `responderSolicitacaoAction` | `PATCH /residences/join-requests/:id` (body: `{ status }`) | mesma transição de estado do convite; achatado pra raiz porque `:id` já é único |
| `cancelarConviteAction` | `DELETE /residences/invites/:id` | achatado pra raiz pelo mesmo motivo |
| `convidarUsuarioAction` | `POST /residences/:code/invites` | criação continua aninhada — só quem já está na residência convida |

> **`PUT` vs. `POST` — por que `code` é `POST` mas `owner` é `PUT`:** `PUT` promete idempotência —
> repetir a mesma requisição N vezes deixa o recurso no mesmo estado final que repetir 1 vez. Em
> `PUT /residences/:code/owner` (body `{ userId }`), isso vale: chamar duas vezes com o mesmo
> `userId` termina com o mesmo dono nas duas vezes. Em `regenerarCodigoAction` não vale: o servidor
> sorteia um código novo a cada chamada, então duas chamadas idênticas terminam em dois códigos
> *diferentes* — a segunda invalida a primeira. Isso quebra a garantia prática que faz o `PUT` valer
> a pena (retry seguro): se a resposta da 1ª chamada se perder na rede e o cliente reenviar por
> segurança, um código que o usuário já viu/copiou vira inválido silenciosamente. `POST` comunica
> corretamente "isso não é seguro de repetir sem querer" — mesmo padrão que APIs conhecidas usam
> pra rotacionar credencial/token (ex.: regenerar chave de API).
>
> **Nota sobre o `:code`:** ele é ao mesmo tempo o identificador da residência na URL *e* um valor
> regenerável (`POST /residences/:code/code`). Depois de regenerar, a própria URL que o cliente
> acabou de chamar fica com o código velho. Isso já é assim no roteamento atual do Next.js
> (`residences/[code]/...`) — não é uma regressão introduzida aqui, só vale ter em mente. Não é
> para resolver nesta fase: mexe em rotas de front-end, que é uma etapa separada (seção 6).

**Despesas**

| Action atual | Endpoint REST proposto | Padrão aplicado |
| :---- | :---- | :---- |
| *(consulta)* | `GET /residences/:code/expenses?mes=&ano=` | já era substantivo, mantido |
| `cadastrarDespesaAction` | `POST /residences/:code/expenses` | já era substantivo, mantido |
| `editarDespesaAction` | `PATCH /residences/:code/expenses/:expenseId` | já era substantivo, mantido |
| `excluirDespesaAction` | `DELETE /residences/:code/expenses/:expenseId` | já era substantivo, mantido |
| `fecharMesAction` | `POST /residences/:code/expenses/month-closures` (body: `{ mes, ano }`) | fechar = criar um "fechamento de mês" |
| `reabrirMesAction` | `DELETE /residences/:code/expenses/month-closures/:periodo` (`:periodo` = `YYYY-MM`) | reabrir = remover o fechamento |
| *(recorrentes)* | `GET /residences/:code/expenses/recurring` | mantido — "recurring" é adjetivo do recurso, não verbo de ação |
| `pararRecorrenciaAction` | `DELETE /residences/:code/expenses/:expenseId/recurrence` | parar = remover o sub-recurso "recorrência" |

**Relatórios**

| Origem atual | Endpoint REST proposto |
| :---- | :---- |
| `src/lib/reports.ts` (consumido só pela página) | `GET /residences/:code/reports?mes=&ano=&aba=` |

## 3. O que é reaproveitável quase sem reescrever

Isto reduz bastante o trabalho real de escopo B, e vale citar explicitamente porque muda a
estimativa de tempo:

- **`src/lib/*.ts`** (residence, expenses, access, notifications, reports, user, username,
  avatars): já são funções puras que só importam o Prisma Client (`src/lib/prisma.ts`) e tipos do
  `src/generated/client`. Nenhuma delas importa nada do Next.js. Isso significa que a lógica de
  negócio inteira pode ser **copiada praticamente como está** para o projeto Express — o trabalho
  é escrever a camada de rotas/controllers em volta dela, não reescrever as regras.
- **`src/schemas/*.ts`** (despesas, residencias, usuarios): schemas Zod, também framework-agnostic.
  Reaproveitáveis 1:1.
- **`prisma/schema.prisma`**: o schema do banco não muda. O novo projeto Express só precisa do
  seu próprio `npx prisma generate` apontando pro mesmo banco (ou uma cópia dele em dev).
- **O que NÃO é reaproveitável direto**: qualquer coisa em `src/auth.ts`/`src/auth.config.ts`
  (é config do NextAuth, amarrada ao Next.js) e os componentes React (é lógica de apresentação,
  fica no front-end de qualquer forma).

## 4. Arquitetura proposta do servidor Express

**Versões (pesquisado em 2026-08-07, [expressjs.com/en/support](https://expressjs.com/en/support/)
e [endoflife.date/nodejs](https://endoflife.date/nodejs)):**

- **Node.js 24.x (Active LTS)** — entrou em LTS em outubro/2025, suporte até abril/2028. É a
  versão recomendada pra começar um projeto novo hoje (Node 22 ainda está em Maintenance LTS, mas
  não é o ponto de partida ideal pra algo novo).
- **Express 5.x** (versão estável atual — Express 4 segue mantido, com EOL não antes de
  outubro/2026, mas não há razão pra começar um projeto novo nele). Requer Node.js ≥ 18, então roda
  sem problema no Node 24. Vale a pena pelo suporte nativo a `async/await` em middlewares e
  handlers: um erro de Promise rejeitada chega direto no `errorHandler` sem precisar da dependência
  `express-async-errors` que a v4 exigia — simplifica exatamente a camada de middlewares abaixo.

Estrutura de pastas sugerida (camadas: rota → controller → serviço, com o "serviço" sendo em boa
parte o `src/lib/*.ts` já existente, só migrado):

```
server/
├── src/
│   ├── config/
│   │   ├── env.ts            # validação de env vars (zod, mesmo padrão já usado no projeto)
│   │   └── prisma.ts         # Prisma Client singleton (igual src/lib/prisma.ts atual)
│   ├── middlewares/
│   │   ├── auth.ts           # valida JWT, popula req.user
│   │   ├── errorHandler.ts   # middleware de erro central (última posição da chain)
│   │   └── validate.ts       # valida body/query com Zod antes do controller
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.routes.ts
│   │   │   ├── auth.controller.ts
│   │   │   └── auth.service.ts     # login, register, JWT, Google OAuth
│   │   ├── residences/
│   │   │   ├── residences.routes.ts
│   │   │   ├── residences.controller.ts
│   │   │   └── residences.service.ts   # praticamente o lib/residence.ts + lib/access.ts atuais
│   │   ├── expenses/            # idem, a partir de lib/expenses.ts
│   │   ├── reports/             # idem, a partir de lib/reports.ts
│   │   ├── notifications/       # idem, a partir de lib/notifications.ts
│   │   └── users/                # avatar, troca de senha
│   ├── schemas/                  # cópia de src/schemas/*.ts do projeto Next
│   ├── app.ts                    # monta o Express, middlewares globais, rotas
│   └── server.ts                 # só sobe o servidor (app.listen)
├── tests/
│   ├── unit/                     # curso 3
│   └── integration/              # curso 4 (Supertest)
├── prisma/                       # schema.prisma (ou apontar pro mesmo do projeto Next, ver nota)
├── .env
└── package.json
```

**Nota sobre o Prisma schema:** enquanto os dois projetos (Next.js e Express) apontarem pro mesmo
banco PostgreSQL, dá pra manter um único `schema.prisma` (ex.: no repo do Express, que vira a
"fonte de verdade" do banco) e o Next.js deixa de rodar `prisma generate`/migrações — só consome
dados através da API. Isso é consistente com o Escopo B da seção 1 (Next.js deixa de tocar o
banco diretamente).

## 5. Autenticação — a parte de maior risco

> **Decisão confirmada (2026-08-07): Opção B (JWT + Passport.js na mão).** O NextAuth
> (`src/auth.ts`/`auth.config.ts`) não é reaproveitado — é config amarrada ao Next.js e fica pra
> trás por completo. Com o desenho da seção 2.2, login é `POST /auth/login` (gera o JWT e seta o
> cookie `httpOnly`) e logout é `POST /auth/logout` (limpa o cookie) — o mecanismo abaixo (JWT
> assinado, `bcrypt`, Passport pro Google) é o mesmo, só muda o nome da rota.

O NextAuth (`src/auth.ts`/`auth.config.ts`) é acoplado ao Next.js. Duas opções reais:

**Opção A — reaproveitar via `@auth/express`.** O Auth.js (mesmo projeto por trás do NextAuth) tem
um pacote oficial para Express (`npm install @auth/express`, middleware `ExpressAuth`). Reduz
bastante o retrabalho — o `Provider` do Google, a config de sessão JWT, tudo migra quase igual.
**Risco:** menos aprendizado "de verdade" sobre auth em Node puro, que é justamente parte do
objetivo desta fase.

**Opção B — JWT + Passport.js na mão (recomendado para o objetivo de aprendizado).**
- Login com credenciais: reaproveita a comparação com `bcrypt` (já usada no projeto atual) +
  emite um JWT assinado (`jsonwebtoken`) guardado em cookie `httpOnly`.
- Login com Google: `passport-google-oidc` implementa o fluxo OpenID Connect (o `passport-google-oauth20"`
  citado numa versão anterior deste documento está sem atualização há 7 anos — trocado pela
  estratégia atual recomendada pelo próprio passportjs.org) — mesmo fluxo conceitual que o
  `GoogleProvider` do NextAuth já usa hoje, só que explícito em vez de abstraído.
- Middleware de rota protegida: substitui o `src/proxy.ts` atual — decodifica o JWT do cookie/
  header `Authorization`, popula `req.user`, retorna 401 se inválido/ausente.
- **Ponto de atenção real:** as permissões por papel (owner vs. membro comum) já existem hoje
  como checagens dentro das funções de `lib/residence.ts` (ex.: `contexto.isOwner`) — isso não
  muda, é regra de negócio, não de autenticação. Só o "quem é o usuário logado" muda de mecanismo.

Opção B foi a escolhida (é o cerne do aprendizado e dos cursos de JWT recomendados na seção 8) — a
Opção A (`@auth/express`) fica registrada aqui só como plano de contingência, caso o tempo aperte e
a prioridade vire "ter a API funcionando" em vez de "aprender auth em Node".

### 5.1 Expiração do access token + refresh token (adicionado em 2026-08-07)

**Decisão:** access token (JWT) de vida curta — **15 minutos** — combinado com um **refresh token
opaco, rotativo e revogável**, guardado com hash numa tabela própria (`RefreshToken`). Pesquisado
contra a recomendação atual (RFC 9700 — OAuth 2.0 Security Best Current Practice, e OAuth 2.1):

- **Por que não só um JWT de vida longa:** um JWT é stateless por definição — não dá pra revogar
  antes da expiração (não existe "apagar" um JWT já emitido, só esperar expirar). Um access token
  de 15 min limita bem o estrago se vazar.
- **Por que o refresh token não é outro JWT:** ele não precisa carregar claim nenhuma — só
  identifica uma sessão que o banco valida a cada uso. Sendo opaco (valor aleatório, 40 bytes), não
  há por que ser auto-contido; o banco é sempre a fonte de verdade sobre validade/revogação.
- **Rotação (one-time use):** cada `POST /auth/refresh` consome o refresh token atual e emite um
  novo — nunca reaproveitável.
- **Detecção de reuso:** se um refresh token **já usado** (revogado) for apresentado de novo, é
  sinal de token roubado — a família inteira daquela sessão é revogada, forçando novo login. Isso é
  o que a rotação sem detecção de reuso não pega sozinha.
- **Nunca texto puro no banco:** só o hash (SHA-256) do refresh token é armazenado — igual senha,
  mas sem custo de bcrypt (já é aleatório de alta entropia, não escolhido por humano).
- **Cookies diferentes, propriedades diferentes:** `JWT` (access token) com `path: '/'`,
  `sameSite: 'lax'`, 15 min. `refreshToken` com `path: '/auth'` (só é enviado pras próprias rotas
  de auth, nunca pro resto da API), `sameSite: 'strict'`, 7 dias (`REFRESH_TOKEN_EXPIRES_IN`).
- **Logout revoga de verdade:** não é só limpar cookie — o refresh token correspondente é marcado
  revogado no banco, então não pode ser reaproveitado mesmo que alguém tenha capturado o valor
  antes do logout.

Fontes: RFC 9700 (OAuth 2.0 Security BCP) e OAuth 2.1 recomendam rotação de refresh token com
detecção de reuso como alternativa a sender-constraining (mTLS/DPoP); OWASP e a maioria das
implementações de referência tratam refresh token como valor opaco, não JWT.

## 6. Fases de implementação (incrementais, escopo B)

> **Ajuste (2026-08-07):** testes deixam de ser uma fase separada no fim. Cada fase de backend
> (1 a 5) só é considerada concluída quando os testes dela (unitário do service + integração da
> rota via Supertest) estão passando. A integração com o front-end (fase 6) só começa depois que
> **todas** as fases de backend estiverem prontas e testadas — vira uma etapa própria, numa
> conversa/branch separada.

1. **Setup** — scaffold do projeto Express + TypeScript, Prisma Client, middleware de erro, rota
   de health-check (`GET /health`). Jest + Supertest configurados aqui também, não depois. Nenhuma
   regra de negócio ainda. *Pronto quando:* `GET /health` responde 200 e tem teste de integração
   cobrindo isso.
2. **Auth** — `POST /auth/login`, `POST /auth/register`, `POST /auth/logout`, Google OAuth,
   middleware de sessão. *Pronto quando:* testes unitários do
   `auth.service` (hash de senha, geração/validação de JWT) e testes de integração das rotas
   (incluindo credencial inválida e token expirado) passam; testável isoladamente via
   Postman/Insomnia antes de tocar no front-end.
3. **Residências** — os endpoints da seção 2.2 (residência raiz + contexto `[code]` + membros +
   convites + solicitações). *Pronto quando:* testes unitários do `residences.service`
   (`lib/residence.ts` + `lib/access.ts` migrados) e testes de integração de cada rota passam,
   incluindo os casos de permissão (owner vs. membro comum).
4. **Despesas + relatórios** — os endpoints de despesas (incluindo `month-closures` e
   `recurrence`) + o endpoint de relatórios (o mais complexo, agrega várias funções de
   `lib/reports.ts`). *Pronto quando:* testes unitários + integração passam, incluindo os cálculos
   de fechamento/reabertura de mês.
5. **Notificações + usuário** — os 2 route handlers restantes. *Pronto quando:* testes unitários +
   integração passam.

**→ Checkpoint antes da próxima etapa:** com as fases 1-5 prontas e testadas, a API Express está
funcionalmente completa e verificável isoladamente (Postman/Insomnia/Supertest), sem depender do
front-end Next.js pra nada.

6. **Integração no front-end** *(etapa separada e futura — não começa junto com as fases acima)* —
   troca das 23 chamadas de Server Action por `fetch()` (ver seção 7), domínio por domínio, na
   mesma ordem das fases 2-5. Cada domínio migrado no front-end é uma oportunidade de confirmar
   que a API se comporta igual ao que ela substituiu.

## 7. O que muda no front-end Next.js

Isso é trabalho real, não trivial — vale nomear antes de começar:

- Todo `useActionState(algumaAction, ...)` + `<Form action={formAction}>` precisa virar um
  `fetch()` manual com estado de loading/erro próprio (ou introduzir uma lib de data-fetching
  client-side, ex. SWR/TanStack Query — o projeto hoje não usa nenhuma).
- `revalidatePath(...)` (usado em quase toda action para atualizar a UI após escrever) deixa de
  existir — o equivalente client-side é revalidar/refazer o fetch depois da mutação
  (`router.refresh()` já é usado em vários lugares hoje e continua funcionando se a página que
  busca dados também migrar para `fetch()` do lado do cliente, ou vira um `mutate()` de SWR/Query).
- Páginas que hoje são Server Components lendo o Prisma direto (ex.:
  `residences/[code]/page.tsx`) passam a fazer `fetch()` para a API Express — isso pode continuar
  sendo feito **no servidor** (dentro do próprio Server Component, com `fetch()` normal) sem virar
  Client Component. Ou seja: a migração da fonte de dados (Prisma → API HTTP) não obriga abrir mão
  do SSR do Next.js — essa é justamente a pergunta central do
  [documento de arquitetura de frontend](decisao-arquitetura-frontend.md).
- Sessão: o cookie de sessão precisa ser lido pelo Next.js (para saber se renderiza a página
  autenticada) e enviado/validado pela API Express. Se os dois rodarem em domínios diferentes em
  produção, isso implica configurar CORS com `credentials: true` e `SameSite` do cookie com
  cuidado.

## 8. Riscos e mitigação

| Risco | Mitigação |
| :---- | :---- |
| Auth reimplementada do zero introduz falha de segurança (ex.: JWT sem expiração, cookie sem `httpOnly`) | Seguir literalmente os cursos de JWT recomendados (seção 9) antes de escrever a versão final; revisar com checklist de segurança básica (expiração, `httpOnly`, `SameSite`, secret fora do código) |
| Escopo B parece grande demais e trava o projeto no meio | Seguir as fases da seção 6 estritamente — cada fase entrega algo testável; dá pra pausar em qualquer fase com o sistema ainda funcional (ex.: parar após a fase 3 e continuar depois) |
| Regressão de comportamento (endpoint novo não faz exatamente o que a Server Action fazia) | Os `lib/*.ts` sendo reaproveitados quase 1:1 (seção 3) reduz muito esse risco — a lógica não é reescrita, só a camada de transporte |
| CORS/cookies entre domínios em produção | Resolver isso cedo, na fase 1 (setup), com um teste manual simples de login cross-origin, antes de migrar os 23 domínios de negócio |

## 9. Cursos recomendados na Alura

Considerando que você já entende REST (Spring Boot) e já tem noção de JS/TS — o foco aqui é
**o runtime do Node.js e o ecossistema Express**, não fundamentos de API REST.

**1. Modelo mental do Node.js (o maior salto vindo de Java/Spring)**
- [JavaScript: entendendo promises e async/await](https://www.alura.com.br/curso-online-javascript-entendendo-promises-async-await)
  — Event Loop, Call Stack, Task Queue. Vindo de JVM (multi-thread), esse é o conceito que mais
  vale entender antes de escrever Express de verdade.

**2. Express — fundamentos e primeira API**
- [Node.js: continue seu projeto full stack criando uma API com Express](https://www.alura.com.br/curso-online-node-primeira-api-express)
  — roteamento, middlewares, primeira API do zero.
- [Formação em APIs com Node.js e Express](https://www.alura.com.br/formacao-node-js-express)
  — trilha mais completa: protocolo HTTP, validação de dados, tratamento de erros, busca/filtros,
  paginação. Recomendado como espinha dorsal, em vez de cursos avulsos equivalentes.

> Nota: alguns cursos de Express da Alura usam MongoDB ou MySQL como banco (ex.: o curso
> "Node.js: criando uma API Rest com Express e MongoDB"). Não é necessário fazê-los por causa do
> banco — o projeto já usa Prisma + PostgreSQL, e o Prisma Client funciona de forma idêntica fora
> do Next.js. Aproveite esses cursos só pela parte de Express/roteamento/middleware e ignore a
> parte específica de ORM/banco deles.

**3. Autenticação (a Opção B da seção 5)**
- [Node.js: criptografia e tokens JWT](https://www.alura.com.br/curso-online-node-jwt-autenticacao-tokens)
  — geração/validação de JWT (o `bcrypt` para hash de senha você já usa no projeto atual).
- [Node.js: criando API Rest com autenticação, perfis de usuários e permissões](https://www.alura.com.br/curso-online-node-js-api-rest-autenticacao-perfis-usuarios-permissoes)
  — middleware de autenticação, perfis e permissões nas rotas (mapeia direto pro seu conceito
  atual de owner vs. membro).
- Os dois acima também existem empacotados como
  [Formação Autenticação, testes e segurança em Node.js](https://www.alura.com.br/formacao-avancando-nodejs)
  (20h) — mais barato/coerente que fazer os dois separados se comprar por formação.

**4. Testes (já estava no seu cronograma original — cursos 3 e 4)**
- Node.js: testes unitários e de integração
- Node.js: implementando testes em uma API Rest

*(mantidos como já estavam no seu documento original, mas o momento mudou — ver seção 6: os testes
agora acompanham cada fase de backend (2 a 5), começando pelo setup do Jest/Supertest já na fase 1,
não ficam guardados pro final)*

## 10. Estimativa de tempo

Estimativa em dias de trabalho focado — o calendário real depende de quantas horas/semana você
consegue dedicar (a base de comparação é o ritmo que você levou pra fazer a migração TypeScript
completa, que foi rápido por ser um trabalho mecânico; isto aqui tem mais superfície nova).

| Etapa | Estimativa |
| :---- | :---- |
| Cursos (seção 9, ritmo part-time) | 2-3 semanas corridas |
| Fase 1 — Setup (+ Jest/Supertest configurados) | 1-2 dias |
| Fase 2 — Auth (+ testes) | 4-6 dias (a mais arriscada) |
| Fase 3 — Residências (+ testes) | 3-4 dias |
| Fase 4 — Despesas + relatórios (+ testes) | 4-5 dias |
| Fase 5 — Notificações/usuário (+ testes) | 1-2 dias |
| **Total backend (fases 1-5, com testes)** | **~2,5-3,5 semanas de trabalho focado** |
| Fase 6 — Integração no front-end *(etapa separada, futura)* | 4-6 dias (toca quase todo componente client do app) |

## 11. Critério de "pronto"

1. `npm test` (unitário + integração) passa ao final de cada fase de backend (seção 6) — não só no
   final de tudo — e para todos os módulos migrados.
2. Cada domínio migrado tem paridade funcional confirmada manualmente contra o comportamento
   atual (mesmo roteiro de verificação já usado nas migrações anteriores do projeto: testar no
   navegador antes/depois).
3. O front-end Next.js não faz mais nenhuma chamada direta ao Prisma para os domínios já
   migrados — só `fetch()` para a API Express.
4. `src/deprecated/` continua fora de escopo (decisão já pendente, não relacionada a este plano).
