# Plano: recuperação de senha ("esqueci minha senha")

> **Status:** documento de decisão. Nada foi implementado. Segue a convenção do repositório: a
> decisão vive no `docs/` primeiro, é aprovada, e só então vira código — e cada fase é testada
> antes da seguinte.
>
> **Divisão de trabalho deste documento:**
> - **[Parte A](#parte-a--sua-parte-configuração-manual)** — o que **você** faz no console do
>   Google e no `.env`. Nada aqui é automatizável por um agente.
> - **[Parte B](#parte-b--execução-pelo-sonnet-5)** — o roteiro de implementação para o **Sonnet 5**
>   executar, fase a fase, com critério de aceite e comando de teste em cada uma.
> - **[Parte C](#parte-c--contrato-com-o-front-end)** — o que o repositório do front-end precisa
>   implementar. Fora do escopo deste repositório, registrado aqui porque a API define o contrato.
>
> **Ordem correta:** você faz a Parte A (ou pelo menos decide os itens da seção A.0) → aprova este
> documento → o Sonnet executa a Parte B. A Fase 0 da Parte B **não depende** da Parte A estar
> pronta (o grupo SMTP é opcional por design, ver D-08), então o Sonnet pode começar em paralelo;
> só a Fase 5 (validação com email real) precisa das credenciais.

---

## 1. O que já existe no projeto e que este plano reaproveita

A análise do código encontrou quase toda a mecânica necessária já construída e testada. Este plano
foi desenhado para **imitar padrões existentes**, não para inventar novos.

| O que já existe | Onde | Como é reaproveitado aqui |
| :---- | :---- | :---- |
| Token opaco de alta entropia, guardado só como hash SHA-256 | `RefreshToken` + `hashRefreshToken` em [authService.ts](src/services/auth/authService.ts) | O token de reset segue **exatamente** o mesmo padrão (ver D-02) |
| Revogar todas as sessões ao trocar a senha (SEC-06) | `revokeAllUserTokens` + [usersController.ts](src/controllers/users/usersController.ts) | Reutilizado sem alteração no fim do reset (ver D-06) |
| Resposta indistinguível para não permitir enumeração | `loginWithCredentials` em [authService.ts](src/services/auth/authService.ts) | Mesma filosofia; o reset é um caso mais estrito (ver D-03) |
| Grupo de variáveis de ambiente opcional "tudo ou nada" | `googleAuthEnabled` em [env.ts](src/config/env.ts) | O grupo SMTP usa o mesmo mecanismo (ver D-08) |
| Injeção de dependência para tornar efeito colateral testável | [tokenPurge.ts](src/utils/tokenPurge.ts), [shutdown.ts](src/utils/shutdown.ts), [readiness.ts](src/utils/readiness.ts) | O envio de email é injetado, nunca importado direto pelo service (ver D-09) |
| Limpeza periódica de tokens mortos (SEC-09) | `purgeExpiredRefreshTokens` + [purgeTokens.ts](src/scripts/purgeTokens.ts) | Estendido para limpar também os tokens de reset |
| Rate limiter nomeado, com log de evento de segurança (SEC-01/SEC-10) | [rateLimit.ts](src/middlewares/rateLimit.ts) | Dois limitadores novos, no mesmo molde |
| Log de evento de segurança estruturado em JSON | `logSecurityEvent` em [logger.ts](src/utils/logger.ts) | Dois eventos novos na union `SecurityEventName` |
| Validação de corpo com Zod + `validateBody` | [validate.ts](src/middlewares/validate.ts), [usuarios.ts](src/schemas/usuarios.ts) | Schemas novos no mesmo arquivo |

**Conclusão da análise:** a única peça genuinamente nova é o **envio de email**. Todo o resto é
composição de coisas que o projeto já sabe fazer.

---

## 2. Decisões de arquitetura

Cada decisão abaixo tem um identificador (`D-xx`) usado pelo roteiro da Parte B. As marcadas com
🔔 são as que eu recomendo mas que **você deve confirmar** antes do Sonnet começar (seção A.0).

### D-01 — O identificador aceito é o **email**, não o username 🔔

Você perguntou qual é mais seguro. **Email.** Em anti-enumeração os dois empatam (a resposta é
sempre a mesma, ver D-03), mas eles não empatam em outra coisa:

Neste sistema o `username` é **público por design** — é o identificador que uma pessoa usa para
convidar outra para uma residência (`POST /residences/:code/invites`), e o próprio comentário no
[schema.prisma](prisma/schema.prisma) o descreve como "identificador público". Aceitar username no
reset significa que **qualquer pessoa que conheça o handle público de alguém consegue disparar
emails para a caixa daquela pessoa**. Com uma botnet pequena para driblar o rate limit por IP, isso
vira *email bombing* contra um alvo escolhido — e o alvo não fez nada além de existir no sistema.

Com email, o atacante já precisa saber o email da vítima antes de conseguir incomodá-la, o que
remove o ganho de usar o seu sistema como ferramenta de assédio.

**Consequência para a UX:** a tela de login usa username e a tela de recuperação vai pedir email.
Isso é normal (GitHub, Discord e Reddit fazem igual) e o texto do formulário resolve: *"Digite o
email cadastrado na sua conta"*.

### D-02 — Token opaco, aleatório, guardado só como hash SHA-256

Mesma decisão já tomada e comentada para o refresh token, pelos mesmos motivos:

- **Opaco, não JWT** — não precisa carregar claim nenhuma; o banco é a fonte de verdade sobre
  validade, expiração e uso.
- **32 bytes de `randomBytes`** (64 caracteres hex) — entropia suficiente para tornar adivinhação
  irrelevante, mesmo sem rate limit.
- **Só o hash no banco** — um dump do banco (ou um backup vazado) não pode ser usado para redefinir
  a senha de ninguém. Sem isso, `PasswordResetToken` seria uma tabela de chaves-mestras em texto
  puro.
- **SHA-256, não bcrypt** — o valor já é aleatório de alta entropia, não uma senha escolhida por
  humano; bcrypt aqui só adicionaria custo de CPU sem ganho. É a mesma justificativa que já está
  escrita em `hashRefreshToken`.

### D-03 — Resposta sempre 200, com mensagem fixa

O endpoint responde **sempre** o mesmo, exista ou não conta com aquele email:

```json
{ "message": "Caso exista uma conta vinculada a esse email, ela receberá um email para criar uma nova senha." }
```

A mensagem vira uma constante exportada (`PASSWORD_RESET_REQUESTED_MESSAGE`), para o teste comparar
contra a constante e não contra uma string copiada — assim ela só muda de propósito.

**Único caso em que a resposta difere:** email em formato inválido (`"abc"`) → `400` do
`validateBody`. Isso não é vazamento: é validação de formato, não de existência.
`naoexiste@x.com` e um email real cadastrado recebem exatamente o mesmo `200`.

### D-04 — O 200 é respondido **antes** do email sair (crítico)

Esta é a parte que quase todo tutorial erra e que anularia o D-03.

Um `await sendEmail(...)` antes do `res.json()` cria um **oráculo de tempo**: conta que existe
responde em ~800 ms (round trip SMTP), conta que não existe responde em ~5 ms. A resposta fica
idêntica, mas o cronômetro entrega tudo — e enumerar volta a ser trivial.

**Portanto:** o service faz o trabalho de banco de forma síncrona (alguns milissegundos, dentro do
ruído da rede) e o envio do email é despachado **sem `await`**, com o erro capturado e logado. O
cliente recebe o 200 no mesmo tempo nos dois caminhos.

O despacho não pode ser um `void promise` solto, por dois motivos: (a) teste de integração ficaria
com corrida, e (b) um `SIGTERM` no meio de um deploy (SEC-08) descartaria emails já prometidos ao
usuário. Solução: um registrador de promessas pendentes com `flushPendingEmails()`, usado pelos
testes e pelo `createShutdownHandler`. Detalhado na Fase 3.

### D-05 — Token de uso único, 30 minutos, e o pedido novo invalida o anterior

- **TTL de 30 minutos**, configurável em `PASSWORD_RESET_TOKEN_EXPIRES_IN` (default `30m`). Curto o
  bastante para reduzir a janela de um link vazado (email é um canal que fica armazenado), longo o
  bastante para quem foi buscar o celular.
- **Uso único** — `usedAt` marcado na redefinição. O botão "voltar" do navegador não redefine a
  senha de novo.
- **Pedir um link novo invalida os anteriores** — quem clica duas vezes em "esqueci minha senha"
  espera que o email mais recente seja o que funciona. Sem isso, um link antigo (talvez o que
  vazou) continua vivo.
- As linhas invalidadas **não são apagadas**: elas ainda contam para o limite por conta (D-07), e o
  `usedAt` também significa "superado por um pedido novo". A limpeza definitiva é a purga (Fase 6).

### D-06 — Redefinir a senha derruba todas as sessões, e **não** faz login automático 🔔

- **Derrubar tudo:** chamada direta a `revokeAllUserTokens(userId)`, exatamente como o SEC-06 já
  faz na troca de senha. O gatilho aqui é ainda mais forte: quem redefine a senha por email
  frequentemente está fazendo isso *porque* desconfia que perdeu a conta.
- **Sem login automático:** ao contrário de `PATCH /users/me/password` (que reemite a sessão do
  dispositivo atual, porque o usuário já estava autenticado), o reset **não** seta cookie nenhum.
  Fazer login automático transformaria "quem tem acesso à caixa de email" em "quem tem sessão
  aberta", e um link de email é copiado, encaminhado e indexado com muito mais facilidade do que
  uma senha digitada. O usuário é mandado para a tela de login e digita a senha nova — o que também
  confirma que ele memorizou/salvou a senha que acabou de criar.

### D-07 — Dois limitadores por IP, mais um limite por conta

| Limitador | Alvo | Janela / limite | Motivo |
| :---- | :---- | :---- | :---- |
| `forgotPasswordLimiter` | `POST /auth/forgot-password` | 5 por hora, por IP | Cada requisição válida dispara um email real: custo externo, cota do Gmail, incômodo para terceiro |
| `resetPasswordLimiter` | `POST /auth/reset-password` | 10 por hora, por IP | Fecha a porta para tentativa de adivinhar token e limita o gasto de `bcrypt.hash` |
| Teto por conta (no service) | qualquer envio de email para um usuário | 3 por hora, por usuário | Um IP só é barrado no seu próprio balde; 200 IPs disparando para a **mesma** caixa passariam pelos dois limitadores acima. Este teto é o que protege o dono da caixa |

⚠️ **Armadilha a evitar:** `skipSuccessfulRequests: true` (usado no `loginLimiter`) **não pode** ser
usado no `forgotPasswordLimiter`. Como o endpoint responde `200` por design (D-03), *toda*
requisição é "bem-sucedida" — a opção desarmaria o limitador por completo, silenciosamente.

O teto por conta, quando estourado, **não muda a resposta**: continua `200` com a mesma mensagem,
só não envia o email. Um evento de segurança é logado.

**O contador é uma tabela própria (`PasswordResetAttempt`), não a contagem de tokens emitidos.**
Contar `PasswordResetToken` seria o caminho óbvio e estaria errado: a conta só-Google (D-11) recebe
email **sem** gerar token nenhum, então ela ficaria com contador sempre zerado e **fora do teto** —
justamente a caixa mais fácil de inundar, porque o atacante só precisa saber que a vítima usa login
social. Uma tabela de tentativas cobre os dois ramos com o mesmo mecanismo.

O precedente é do próprio projeto: `JoinAttempt` existe exatamente por isso (RN-052), e o
comentário dele já explica por que um contador em memória não serve — não sobrevive a restart e não
funciona com mais de uma task no ECS.

### D-08 — SMTP é um grupo de variáveis opcional, "tudo ou nada"

Exatamente o mecanismo que o [env.ts](src/config/env.ts) já usa para o Google OAuth
(`googleAuthEnabled` + `.refine()`): ou as 5 variáveis SMTP vêm juntas, ou nenhuma vem.

Isso não é preciosismo — é o que mantém o CI verde. O [ci.yml](.github/workflows/ci.yml) monta o
ambiente de teste **sem** segredos de SMTP (e não deve mesmo ganhar um), e o `.env` efêmero do
smoke test também não os tem. Se as variáveis fossem obrigatórias, `env.ts` lançaria e o pipeline
inteiro quebraria.

Com `mailEnabled === false`, o endpoint continua respondendo `200` normalmente; o "envio" só
registra em log (e, em `development`, imprime o link no console — o que também dá um caminho de
desenvolvimento local sem configurar SMTP nenhum).

### D-09 — O envio de email é uma porta, não uma dependência direta

`sendEmail` é passada como parâmetro para o service, no mesmo padrão de
`runTokenPurge`/`createShutdownHandler`/`createReadinessHandler`. Ganhos:

1. O teste unitário do service roda sem SMTP, sem rede e sem mock de módulo.
2. Trocar Gmail por **AWS SES** depois (que é a resposta certa para produção de verdade — ver A.4)
   mexe em um arquivo só, sem tocar em regra de negócio.

### D-10 — Token viaja no **corpo**, nunca na URL da API 🔔

O [app.ts](src/app.ts) usa `morgan('combined')` em produção, que loga a URL completa de toda
requisição no CloudWatch. Um token em `POST /auth/reset-password/:token` viraria uma credencial
válida gravada em texto puro no log de acesso — e logs costumam ter retenção maior e controle de
acesso mais frouxo do que o banco.

Então: o token vai no corpo (`{ token, newPassword, confirmNewPassword }`), tanto na verificação
quanto na redefinição.

*Nota:* o token **precisa** ir na query string do link do **front-end**
(`.../change-password?token=...`) — não há alternativa, é assim que um link funciona. O que mitiga
isso é o TTL curto (D-05), o uso único, e o front-end limpar o token da URL assim que a página
monta. Isso é responsabilidade do repositório do front (Parte C).

### D-11 — Conta que só entra com Google recebe um email diferente 🔔

Um usuário criado pelo login social tem `password: null`. Se ele pedir reset:

- **Não** criamos senha local para ele por este caminho (isso converteria silenciosamente uma conta
  social em conta com senha).
- Ele recebe um email **diferente**: *"Sua conta entra com o Google — use o botão 'Entrar com
  Google'"*.
- A resposta HTTP continua sendo exatamente a mesma (D-03). Só o dono da caixa vê a diferença, e
  para ele essa diferença é a única coisa que evita ficar preso num silêncio sem explicação.

⚠️ **Este ramo também passa pelo teto por conta do D-07** — e é justamente por causa dele que o teto
conta `PasswordResetAttempt` em vez de tokens emitidos: aqui nenhum token é criado. Sem isso, a
conta só-Google seria a única caixa do sistema sem proteção antiflood, e bastaria ao atacante saber
que a vítima usa login social para explorar a diferença.

### D-12 — Endpoints

Seguindo a exceção já documentada na seção 2.2 do
[plano principal](docs/plano-api-node-express.md) ("autenticação não é um recurso CRUD;
`/auth/login` e `/auth/logout` são convenção pragmática"):

| Método | Rota | Corpo | Resposta |
| :---- | :---- | :---- | :---- |
| `POST` | `/auth/forgot-password` | `{ email }` | Sempre `200` + mensagem fixa (D-03) |
| `POST` | `/auth/reset-password/verify` | `{ token }` | `200 { valid: true }` ou `400` |
| `POST` | `/auth/reset-password` | `{ token, newPassword, confirmNewPassword }` | `200 { message }`, sem cookie (D-06) |

O `/verify` existe para a tela de redefinição conseguir mostrar "este link expirou" **antes** do
usuário digitar uma senha nova duas vezes e só então descobrir que perdeu o trabalho. Ele não
enfraquece nada: adivinhar um token de 32 bytes não é um ataque viável, e o limitador já está lá.

---

## 3. Modelo de dados

```prisma
//Token de redefinição de senha por email. Mesmo padrão do RefreshToken: o valor em si
//nunca é guardado, só o hash — um dump do banco não pode redefinir a senha de ninguém.
//usedAt significa "não vale mais": ou foi consumido, ou foi superado por um pedido novo.
model PasswordResetToken {
  id        Int       @id @default(autoincrement())
  userId    Int
  tokenHash String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId, createdAt])
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

```prisma
//D-07 -> Contador do teto por conta. Existe separado do PasswordResetToken porque o
//ramo da conta só-Google (D-11) envia email SEM emitir token: contar tokens deixaria
//justamente essa caixa sem teto nenhum. Uma linha por email disparado, dos dois tipos.
//Mesmo desenho do JoinAttempt (RN-052), e pelo mesmo motivo: um contador em memória não
//sobrevive a restart nem funciona com mais de uma task no ECS.
model PasswordResetAttempt {
  id        Int      @id @default(autoincrement())
  userId    Int
  createdAt DateTime @default(now())

  @@index([userId, createdAt])
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

E, no model `User`, as duas relações inversas: `passwordResetTokens PasswordResetToken[]` e
`passwordResetAttempts PasswordResetAttempt[]`.

O índice composto `[userId, createdAt]` das duas tabelas serve ao teto por conta (D-07), que é uma
contagem por usuário numa janela de tempo — mesmo formato do índice que o `JoinAttempt` já usa para
o RN-052.

---

# PARTE A — Sua parte (configuração manual)

Nada nesta parte pode ser feito por um agente: envolve o console do Google, sua conta pessoal e
segredos que não devem passar por um terminal compartilhado.

## A.0 — Decisões ✅ confirmadas em 18/08/2026

Todas as cinco foram respondidas; nenhuma está mais em aberto. O Sonnet implementa o que está aqui.

| # | Decisão | Resposta |
| :---- | :---- | :---- |
| 1 | D-01: identificador aceito | ✅ **Email** |
| 2 | D-06: login automático após redefinir | ✅ **Não** — manda para a tela de login |
| 3 | D-10: token no corpo | ✅ **Sim** — fora da URL da API |
| 4 | D-11: conta só-Google | ✅ **Email explicando** que a conta usa Google |
| 5 | Texto exato da resposta | ✅ *"Caso exista uma conta vinculada a esse email, ela receberá um email para criar uma nova senha."* |

> **Consequência do item 4 (levantada na aprovação):** a pergunta "seria interessante colocar uma
> proteção antiflood?" expôs um furo na primeira versão deste plano. O teto por conta contava
> tokens emitidos, e a conta só-Google recebe email **sem** emitir token — ela ficaria fora do teto,
> que é o oposto do que se quer. Corrigido: o contador virou a tabela `PasswordResetAttempt`
> (seção 3), a checagem passou a acontecer **antes** do ramo do D-11 (Fase 3, passo 4), e há um
> teste dedicado a esse caso (Fase 3 e Fase 5).

## A.1 — Criar a senha de app no Google

A senha de app é uma credencial de 16 caracteres que autentica no SMTP do Gmail sem expor a senha
real da conta e sem passar por 2FA a cada envio.

**Pré-requisito obrigatório:** a verificação em duas etapas precisa estar ligada na conta. O Google
**não mostra a opção de senha de app** sem ela.

1. Acesse <https://myaccount.google.com/security> e ligue a **Verificação em duas etapas**, se ainda
   não estiver ligada.
2. Vá em <https://myaccount.google.com/apppasswords>.
   - Se a página disser que a opção não está disponível, quase sempre é (a) 2FA desligada, ou (b)
     conta gerenciada por uma organização Workspace que bloqueia senhas de app.
3. Dê um nome ao app — sugestão: `sistema-controle-despesas-api`.
4. O Google exibe **16 caracteres em 4 blocos** (ex.: `abcd efgh ijkl mnop`). **Copie agora** — a
   tela não mostra de novo.
5. Ao colocar no `.env`, você pode manter ou remover os espaços; o SMTP aceita os dois. Prefira
   **remover**, para não depender de aspas.

> **Guarde como segredo real.** Essa senha dá acesso de envio à sua conta Gmail para quem a tiver.
> Ela nunca entra no Git (o `.gitignore` já cobre `.env`), nunca vai para o `.env.example`, e em
> produção vai para o SSM Parameter Store (A.4).

## A.2 — Preencher o `.env` local

Acrescente ao seu `.env` (o Sonnet vai criar as entradas correspondentes, em branco, no
`.env.example`):

```dotenv
# --- Recuperação de senha por email ---
# Validade do link de redefinição.
PASSWORD_RESET_TOKEN_EXPIRES_IN=30m
# Caminho da tela de redefinição no front-end (o link = FRONTEND_URL + este caminho + ?token=)
PASSWORD_RESET_PATH=/change-password

# SMTP — as 5 variáveis abaixo são "tudo ou nada" (ver D-08).
# Deixe TODAS em branco para rodar sem envio de email (em dev o link é impresso no console).
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=seu.email@gmail.com
SMTP_PASSWORD=abcdefghijklmnop
MAIL_FROM=Controle de Despesas <seu.email@gmail.com>
```

**Pontos de atenção:**

- **`SMTP_PORT=465`** usa TLS implícito (`secure: true`), que é o modo mais simples de acertar. A
  porta 587 (STARTTLS) também funciona, mas exige `secure: false` — se você trocar a porta, avise,
  porque essa derivação é feita no código.
- **O endereço dentro do `MAIL_FROM` precisa ser o mesmo do `SMTP_USER`** (ou um alias verificado na
  conta). O Gmail reescreve ou rejeita um `From` de terceiro. Não adianta usar
  `no-reply@qualquercoisa.com` aqui.
- **`FRONTEND_URL`** já existe no seu `.env` e é o que monta o link. Confirme que aponta para o
  endereço onde o front realmente roda.

## A.3 — Verificar que o envio funciona

Depois que a Fase 2 estiver implementada, rode o teste manual que o Sonnet vai deixar pronto:

```bash
npm run mail:test -- seu.email@gmail.com
```

Se falhar, os erros mais comuns do Gmail são:

| Erro | Causa |
| :---- | :---- |
| `535-5.7.8 Username and Password not accepted` | Senha de app errada, ou você colou a senha normal da conta |
| `534-5.7.9 Application-specific password required` | 2FA ligada e você usou a senha normal |
| `Invalid login` com a senha certa | Espaços colados junto da senha, ou `SMTP_USER` diferente da conta que gerou a senha de app |
| Conexão trava sem resposta | Porta 465 bloqueada pela rede/firewall — teste em outra rede antes de suspeitar do código |

## A.4 — Produção (quando o deploy AWS acontecer)

Isto **não** é para agora; fica registrado para a hora do deploy, e conversa com o **SEC-03** da
[revisão de segurança](docs/revisao-seguranca-deploy-aws.md), que ainda está aberto.

1. **`SMTP_PASSWORD` vai para o SSM Parameter Store como `SecureString`**, referenciado pelo bloco
   `secrets:` da task definition — nunca como variável em texto plano, que ficaria legível para
   qualquer um com `ecs:DescribeTaskDefinition`.
2. **Cota do Gmail:** ~500 destinatários por dia numa conta gratuita. Suficiente para portfólio e
   uso real pequeno; não é uma plataforma de envio.
3. **Entregabilidade:** enviando de `@gmail.com`, SPF/DKIM são do Google e a reputação é razoável,
   mas mensagem automatizada para outros provedores cai em spam com alguma frequência.
4. **O destino certo em produção é o AWS SES.** Por causa do D-09, essa troca é a substituição de um
   arquivo, sem tocar em service, controller ou teste. Não faça agora; só saiba que o caminho está
   aberto de propósito.

## A.5 — O que **não** muda (verificado na análise)

Para você não procurar trabalho que não existe:

- **`.github/workflows/ci.yml`** — nenhuma alteração. O grupo SMTP opcional (D-08) mantém o pipeline
  verde sem nenhum segredo novo. **Não adicione secrets de SMTP no GitHub.**
- **`docker-compose.yml`** — nenhuma alteração. Os serviços `api` e `api-dev` já usam
  `env_file: .env`, então as variáveis novas fluem sozinhas.
- **`Dockerfile`** — nenhuma alteração.

---

# PARTE B — Execução pelo Sonnet 5

> **Instruções para o agente executor.** Este roteiro é normativo: as decisões `D-xx` da seção 2 já
> foram tomadas e aprovadas — implemente-as, não as reabra. Se algo no código contradisser este
> documento, **pare e reporte** em vez de escolher sozinho.
>
> **Regras de execução:**
> 1. **Uma fase por vez.** Ao fim de cada fase, rode o comando de verificação indicado e só siga se
>    estiver verde.
> 2. **Não invente padrão novo.** Cada arquivo novo tem um irmão existente citado na fase — leia o
>    irmão antes de escrever e siga o estilo dele, inclusive a densidade e o tom dos comentários,
>    que neste projeto explicam *por quê*, não *o quê*.
> 3. **Comentários em português**, como todo o resto do repositório, ancorados na decisão
>    (`// D-04 -> ...`) do mesmo jeito que o código existente ancora nos `SEC-xx`.
> 4. **Nenhum segredo em log, nunca.** Não logue o token de reset, não logue `SMTP_PASSWORD`, não
>    logue senha. Vale o padrão do `logSecurityEvent`: prefixo de hash, sim; valor, não.
> 5. **Não rode migration destrutiva** e não toque em migrations já existentes.

## Fase 0 — Dependência e variáveis de ambiente ✅

**Arquivos:** `package.json`, `src/config/env.ts`, `.env.example`

1. `npm i nodemailer` e `npm i -D @types/nodemailer` (confirme se o pacote de tipos ainda é separado
   na versão instalada; se o nodemailer já embutir tipos, não instale o `@types`).
2. Em [env.ts](src/config/env.ts), acrescente ao schema:
   - `PASSWORD_RESET_TOKEN_EXPIRES_IN: z.string().default('30m')`
   - `PASSWORD_RESET_PATH: z.string().startsWith('/').default('/change-password')`
   - `SMTP_HOST`, `SMTP_USER`, `MAIL_FROM`, `SMTP_PASSWORD` como `optionalString(...)`; `SMTP_PORT`
     como opcional numérico. ⚠️ **Cuidado:** `z.coerce.number()` transforma `''` em `0` — passe pelo
     `optionalString` **antes** de coagir, ou o grupo "todas em branco" seria lido como preenchido.
   - `SMTP_USER` validado como email.
3. Acrescente um **segundo `.refine()`** exigindo que as 5 variáveis SMTP venham todas juntas ou
   nenhuma, com mensagem no mesmo tom do refine do Google que já existe.
4. Exporte `export const mailEnabled = ...`, no mesmo molde de `googleAuthEnabled`.
5. Replique as entradas **em branco** no `.env.example`, com os comentários explicativos (siga o
   estilo do bloco do Google OAuth que já está lá).

**Verificação:**
```bash
npm run build
```
Depois confirme os dois extremos: com as 5 SMTP em branco a aplicação sobe (`npm run dev`) e
`mailEnabled` é `false`; com só 2 preenchidas, `env.ts` recusa a subir com a mensagem do refine.

## Fase 1 — Modelo e migration ✅

**Arquivos:** `prisma/schema.prisma`, `prisma/migrations/`

1. Acrescente os models `PasswordResetToken` e `PasswordResetAttempt` exatamente como na seção 3,
   com os comentários.
2. Acrescente as duas relações inversas no model `User`.
3. Gere a migration:
   ```bash
   npx prisma migrate dev --name add_password_reset_tokens
   ```
4. Confira que o SQL gerado só **cria** tabelas e índices — nenhum `DROP`, nenhum `ALTER`
   destrutivo.

**Verificação:**
```bash
npm run build
npm test
```
A suíte inteira precisa continuar verde: a migration não muda comportamento existente.

## Fase 2 — A porta de email e o transporte Gmail ✅

**Arquivos:** `src/lib/mailer.ts`, `src/lib/emailTemplates.ts`, `src/scripts/testMail.ts`,
`package.json` (script), `tests/unit/emailTemplates.test.ts`

Irmãos a imitar: [readiness.ts](src/utils/readiness.ts) (fábrica com dependência injetada) e
[purgeTokens.ts](src/scripts/purgeTokens.ts) (entrypoint fino que só chama e sai).

1. **`src/lib/mailer.ts`**
   - `export interface OutgoingEmail { to: string; subject: string; text: string; html: string }`
   - `export type SendEmail = (email: OutgoingEmail) => Promise<void>`
   - `createSmtpSender()` — cria o transport do nodemailer a partir do `env`, com
     `secure: env.SMTP_PORT === 465`. **Crie o transport uma vez** no escopo do módulo: o nodemailer
     faz pool de conexão, e criar um por envio é desperdício e esbarra em limite do Gmail.
   - `createDisabledSender()` — usado quando `mailEnabled === false`: não envia; loga em
     `development` (incluindo o link, que em dev é justamente o que se quer ver) e fica em silêncio
     nos demais ambientes.
   - `export const sendEmail: SendEmail = mailEnabled ? createSmtpSender() : createDisabledSender()`
2. **`src/lib/emailTemplates.ts`** — funções puras, sem I/O, retornando `OutgoingEmail`:
   - `passwordResetEmail({ name, resetUrl, expiresInMinutes })`
   - `passwordResetGoogleAccountEmail({ name })` (D-11)
   - Ambos com versão `text` **e** `html`. Cliente de email com HTML desligado é comum, e sem `text`
     a mensagem chega vazia.
   - O HTML tem que ser simples: `div`/tabela com estilo inline. Nada de CSS externo, nada de
     `<style>` no head, nada de imagem remota (que também seria um pixel de rastreio).
   - **Escape de HTML no `name`**: o nome vem do usuário. Interpolar direto abre injeção de HTML no
     corpo do email. Escape, ou simplesmente não use o nome no HTML.
   - Texto em português, no tom do produto, e uma linha explícita: *"Se você não pediu isso, ignore
     este email — sua senha continua a mesma."*
3. **`src/scripts/testMail.ts`** + script `"mail:test": "tsx src/scripts/testMail.ts"` no
   `package.json` — envia um email de teste para o destinatário passado em `argv[2]`, imprime
   sucesso/erro e sai com o código apropriado. É o que a seção A.3 usa.
4. **`tests/unit/emailTemplates.test.ts`** — cobre só os templates (funções puras): assunto correto,
   o `resetUrl` aparece no `text` e no `html`, o nome é escapado, e o template do D-11 **não** contém
   link de redefinição.

**Verificação:**
```bash
npm test -- emailTemplates
```
Nenhum teste desta fase pode abrir conexão de rede.

## Fase 3 — Service de recuperação de senha ✅

**Arquivos:** `src/services/auth/passwordResetService.ts`,
`tests/unit/passwordReset.service.test.ts`

Irmão a imitar: [authService.ts](src/services/auth/authService.ts) — o bloco de refresh token é
quase uma planta baixa deste arquivo.

Assinaturas:

```ts
export const PASSWORD_RESET_REQUESTED_MESSAGE =
  'Caso exista uma conta vinculada a esse email, ela receberá um email para criar uma nova senha.';

export const PASSWORD_RESET_MAX_PER_HOUR = 3;

export async function requestPasswordReset(
  email: string,
  deps: { sendEmail: SendEmail },
  context?: SecurityContext,
): Promise<void>;

export async function verifyPasswordResetToken(rawToken: string): Promise<void>; // AppError(400) se inválido

export async function resetPassword(
  rawToken: string,
  newPassword: string,
  context?: SecurityContext,
): Promise<void>;

export async function purgeExpiredPasswordResetTokens(): Promise<number>;

export async function flushPendingEmails(): Promise<void>; // ver D-04
```

**`requestPasswordReset` — passo a passo:**

1. Normalize o email: `trim()` + `toLowerCase()`.
2. Busque com **`findFirst` + `mode: 'insensitive'`**, não `findUnique`. Motivo: o registro grava o
   email como digitado (`registerSchema` não normaliza), então uma conta criada como
   `Fulano@Gmail.com` nunca seria encontrada por busca exata em minúsculas — e por causa do D-03 o
   usuário veria o mesmo `200` de sempre e ficaria esperando um email que nunca vem. Deixe isso
   comentado no código; é uma decisão contraintuitiva.
3. **Se não achar o usuário: retorne.** Sem erro, sem log de aviso, sem email. O controller responde
   o mesmo 200.
4. **Teto por conta (D-07), ANTES de qualquer ramo.** Conte os `PasswordResetAttempt` do usuário com
   `createdAt` na última hora. Se `>= PASSWORD_RESET_MAX_PER_HOUR`: logue
   `logSecurityEvent('password_reset_throttled', { userId, ip })` e retorne sem enviar.
   ⚠️ **A ordem é normativa.** Colocar esta checagem depois do ramo do D-11 deixaria a conta
   só-Google sem teto nenhum — ela sai no passo 5 e nunca chegaria aqui. Releia o D-07 se ficar
   tentado a reordenar.
5. Se `user.password === null` (conta só-Google, D-11): grave um `PasswordResetAttempt`, despache
   `passwordResetGoogleAccountEmail` e retorne. **Não** crie token.
6. Invalide os tokens ainda válidos do usuário: `updateMany` setando `usedAt: new Date()` onde
   `usedAt: null` (D-05).
7. Gere `randomBytes(32).toString('hex')`, calcule o SHA-256, grave a linha com
   `expiresAt = now + ms(env.PASSWORD_RESET_TOKEN_EXPIRES_IN)`, e grave também o
   `PasswordResetAttempt` correspondente.
8. Monte a URL: `${env.FRONTEND_URL}${env.PASSWORD_RESET_PATH}?token=${encodeURIComponent(raw)}`.
9. **Despache o email sem `await`** (D-04) e registre a promessa no rastreador (abaixo).

**Rastreador de envios pendentes (D-04):** um `Set<Promise<void>>` no escopo do módulo. Ao
despachar, adicione a promessa e, no `.finally()`, remova. `flushPendingEmails()` faz
`await Promise.allSettled([...pending])`. Todo despacho leva `.catch()` chamando
`logError(err, 'passwordReset/sendEmail')` — uma falha de SMTP não pode virar `unhandledRejection`
e ser recolhida pelo handler do [server.ts](src/server.ts).

**`resetPassword` — passo a passo:**

1. Hash do token → `findUnique({ where: { tokenHash } })`.
2. Não existe, ou `usedAt !== null`, ou `expiresAt < now` → `AppError(400, 'Link inválido ou
   expirado. Peça um novo.')`. **A mesma mensagem para os três casos**: diferenciar "já usado" de
   "não existe" conta ao atacante que o token existiu.
3. Reuso de um token **já consumido** merece `logSecurityEvent('password_reset_token_reuse', ...)`,
   com prefixo do hash, nunca o token — mesma decisão do `refresh_token_reuse`.
4. `bcrypt.hash(newPassword, 10)` — cost 10 é decisão fechada do projeto (SEC-15); não mude.
5. Numa **`prisma.$transaction`**: atualize a senha do usuário e marque `usedAt` no token. Sem
   transação, uma falha entre os dois deixa o token vivo com a senha já trocada.
6. Depois da transação, `revokeAllUserTokens(user.id)` (D-06) — importado do `authService`.
7. Retorne `void`. **Não** chame `establishSession` e **não** sete cookie (D-06).

**`tests/unit/passwordReset.service.test.ts`:** email desconhecido não cria linha e não chama
`sendEmail`; conta só-Google recebe o template do D-11 e não gera token; o 4º pedido em uma hora não
envia; **o 4º pedido para uma conta só-Google também não envia** (é o caso que prova o D-07 no ramo
sem token — sem ele, a correção pode ser desfeita num refactor sem nada acusar); pedido novo
invalida o anterior; token expirado e token já usado são recusados com a mesma mensagem; redefinir
chama `revokeAllUserTokens`.

**Verificação:**
```bash
npm test -- passwordReset.service
```

## Fase 4 — Schemas, controller e rotas ✅

**Arquivos:** `src/schemas/usuarios.ts`, `src/middlewares/rateLimit.ts`, `src/utils/logger.ts`,
`src/controllers/auth/authController.ts`, `src/routes/auth/authRoutes.ts`

1. **`src/utils/logger.ts`** — acrescente `'password_reset_throttled'` e
   `'password_reset_token_reuse'` à union `SecurityEventName`, cada um com o comentário de uma linha
   explicando o que significa quando aparecer no CloudWatch (siga o estilo dos existentes).
2. **`src/schemas/usuarios.ts`** — três schemas novos. Reaproveite a **mesma regra de senha** do
   `changePasswordSchema` (mín. 8, máx. 100, ao menos um número ou símbolo, confirmação batendo).
   Extraia a regra para um `passwordSchema` compartilhado se isso não ficar artificial — hoje ela já
   está duplicada entre `registerSchema` e `changePasswordSchema`, e uma terceira cópia é uma a mais
   do que o aceitável.
   - `forgotPasswordSchema`: `{ email: z.email('Email inválido') }`
   - `verifyResetTokenSchema`: `{ token: z.string().min(1) }`
   - `resetPasswordSchema`: `{ token, newPassword, confirmNewPassword }` com o `.refine()` de
     confirmação.
3. **`src/middlewares/rateLimit.ts`** — `forgotPasswordLimiter` e `resetPasswordLimiter` via
   `buildLimiter`, com as constantes `FORGOT_PASSWORD_LIMIT = 5` e `RESET_PASSWORD_LIMIT = 10`
   exportadas (os testes importam as constantes, não números soltos).
   ⚠️ **Sem `skipSuccessfulRequests`** no `forgotPasswordLimiter` — releia o aviso do D-07 e deixe um
   comentário no código explicando por quê, senão alguém "padroniza" com o `loginLimiter` depois.
4. **`src/controllers/auth/authController.ts`** — três handlers. `forgotPassword` responde `200` com
   `PASSWORD_RESET_REQUESTED_MESSAGE` **em todos os caminhos**; qualquer exceção inesperada do
   service (banco fora, por exemplo) também vira `200` com log — um `500` seletivo seria mais um
   canal de enumeração. Use o helper `securityContext(req)` que já existe no arquivo.
5. **`src/routes/auth/authRoutes.ts`** — as três rotas, com o limitador **antes** do `validateBody`,
   como o comentário do SEC-01 no arquivo determina.

**Verificação:**
```bash
npm run build
npm test
```

## Fase 5 — Testes de integração ✅

**Arquivos:** `tests/integration/passwordReset.test.ts`, `tests/integration/authRateLimit.test.ts`
(estender)

Irmão a imitar: [passwordChange.test.ts](tests/integration/passwordChange.test.ts) — copie a
estrutura de setup, o `TEST_EMAIL_DOMAIN` próprio, o `uniqueSuffix()` e o `afterAll` que limpa por
sufixo de domínio.

Injete um `sendEmail` espião para capturar o link sem tocar em SMTP. Depois de chamar o endpoint,
`await flushPendingEmails()` antes de qualquer asserção (D-04).

Casos obrigatórios:

1. Email cadastrado → `200` com a mensagem exata da constante.
2. Email **não** cadastrado → `200` com **a mesma** mensagem exata, e nenhuma linha criada em
   `PasswordResetToken`.
3. Email em formato inválido → `400` (validação de formato, não de existência).
4. Fluxo feliz completo: pedir → capturar o link no email espião → extrair o token →
   `POST /auth/reset-password` → `200`; a senha **antiga** falha no login (`401`) e a **nova**
   funciona (`200`).
5. **Uso único:** repetir a redefinição com o mesmo token → `400`.
6. **Expiração:** manipule `expiresAt` para o passado via Prisma e confirme `400`.
7. **Pedido novo invalida o anterior:** dois pedidos seguidos; o token do primeiro email → `400`, o
   do segundo → `200`.
8. **D-06 — derruba as sessões:** logue em "outro dispositivo" antes do reset (mesmo padrão do
   `loginNoOutroDispositivo` do `passwordChange.test.ts`), redefina, e confirme que o
   `POST /auth/refresh` daquele dispositivo devolve `401`.
9. **D-06 — sem login automático:** a resposta do reset **não** traz `Set-Cookie` de `JWT` nem de
   `REFRESH`.
10. **D-11:** conta criada só com Google (crie direto via Prisma, com `password: null`) → `200`
    normal, nenhum token criado, e o email espião recebeu o template de conta Google.
11. **D-07 no ramo sem token:** 4 pedidos seguidos para essa mesma conta só-Google → todos `200`,
    mas o espião recebeu **3** emails, não 4. É o caso que prova que o teto por conta cobre o ramo
    que não emite token.
12. **Nenhum email real sai durante a suíte** — garantido pelo espião; deixe isso explícito num
    comentário no topo do arquivo.

Em `authRateLimit.test.ts`, acrescente o caso do `forgotPasswordLimiter` armado na rota real, no
mesmo formato dos existentes: IP próprio via `X-Forwarded-For`, contagem até `FORGOT_PASSWORD_LIMIT`
e o `+1` esperando `429`.

**Verificação:**
```bash
npm test
```
A suíte **inteira** precisa passar, não só os arquivos novos.

## Fase 6 — Purga e desligamento gracioso ✅

**Arquivos:** `src/utils/tokenPurge.ts`, `src/scripts/purgeTokens.ts`,
`src/services/auth/passwordResetService.ts`, `src/server.ts`, `tests/unit/tokenPurge.test.ts`

1. `purgeExpiredPasswordResetTokens()` remove linhas de **`PasswordResetToken`** com `expiresAt`
   anterior a `PASSWORD_RESET_RETENTION_DAYS = 7` dias atrás, e linhas de
   **`PasswordResetAttempt`** com `createdAt` no mesmo corte. A retenção é folgada de propósito: o
   token vive 30 minutos e o teto do D-07 só olha a última hora, mas uma linha recente ainda serve
   para investigar um `password_reset_token_reuse` ou um `password_reset_throttled` no log.
2. Estenda `runTokenPurge` para receber **as duas** purgas (refresh e reset) e logar as duas
   contagens. Mantenha o contrato de dependências injetadas — é o que torna o arquivo testável sem
   banco.
3. Atualize `tests/unit/tokenPurge.test.ts` para o contrato novo.
4. Em [server.ts](src/server.ts), inclua `flushPendingEmails()` no caminho do
   `createShutdownHandler` (SEC-08), **com timeout de guarda**: um SMTP travado não pode impedir o
   processo de morrer. Se o handler atual não tiver onde encaixar isso, prefira estender
   `createShutdownHandler` com uma dependência opcional a espalhar `await` no `server.ts`.

**Verificação:**
```bash
npm test
npm run build
npm run purge:tokens
```

## Fase 7 — Documentação ✅

**Arquivos:** `README.md`, `.env.example` (revisão final), `docs/revisao-seguranca-deploy-aws.md`

1. **README** — quatro pontos a atualizar, seguindo a formatação exata que já está lá:
   - `## Referência de endpoints` → `### Auth — /auth`: as três rotas novas.
   - `## Variáveis de ambiente`: as 7 variáveis novas, marcando o grupo SMTP como opcional.
   - `## Autenticação e sessão`: um parágrafo sobre o fluxo de recuperação, mencionando D-03
     (anti-enumeração), D-05 (uso único, 30 min) e D-06 (derruba sessões, sem login automático).
   - `## Scripts npm`: o `mail:test`.
2. **`docs/revisao-seguranca-deploy-aws.md`** — acrescente uma nota na seção 8 (decisões abertas)
   registrando que `SMTP_PASSWORD` entra no escopo do **SEC-03** (SSM Parameter Store) e que o
   alarme do CloudWatch sugerido no item 6 ganha dois eventos novos: `password_reset_token_reuse`
   (toda ocorrência é suspeita real, mesmo peso do `refresh_token_reuse`) e
   `password_reset_throttled`.
3. **Este documento** — marque as fases concluídas, no mesmo estilo dos `SEC-xx ✅`.

**Verificação final (do zero):**
```bash
npm run build && npm test
```

## Checklist de aceite (o Sonnet deve reportar item a item)

- [x] `POST /auth/forgot-password` responde `200` com a mensagem da constante para email existente, inexistente e de conta só-Google
- [x] O tempo de resposta é o mesmo nos três casos, porque o email não é aguardado — D-04
- [x] O token nunca aparece em nenhum log, e o banco guarda só o SHA-256 — D-02
- [x] Token expira em 30 min, é de uso único, e um pedido novo invalida o anterior — D-05
- [x] Redefinir revoga todas as sessões e **não** devolve `Set-Cookie` — D-06
- [x] Token trafega no corpo, nunca na URL da API — D-10
- [x] `forgotPasswordLimiter` está armado na rota real e **não** usa `skipSuccessfulRequests` — D-07
- [x] O teto de 3/hora por conta vale também para a conta só-Google, que não emite token — D-07
- [x] Com as 5 variáveis SMTP em branco, a API sobe e a suíte passa (é o cenário do CI) — D-08
- [x] Nenhum email real é enviado durante `npm test`
- [x] `npm run build && npm test` verdes, incluindo todos os testes que já existiam

---

# PARTE C — Contrato com o front-end

Fora do escopo deste repositório (o front é outro projeto), registrado porque a API define o
contrato.

> **O plano de execução do front já existe**, escrito em 18/08/2026:
> `docs/plano-recuperacao-de-senha-frontend.md`, no repositório
> **sistema-controle-despesas-front**. Ele tem as decisões `F-xx`, as fases para o Sonnet e o
> checklist de aceite de lá. O resumo abaixo fica aqui só como referência rápida — **em caso de
> divergência entre os dois, o documento do front manda** no que é tela, e este manda no que é
> contrato de endpoint.

**Três telas:**

1. **Login** — link "Esqueci minha senha" abaixo do formulário, apontando para `/forgot-password`.
2. **`/forgot-password`** — campo de email → `POST /auth/forgot-password`. A resposta é **sempre**
   `200`; a tela mostra a mensagem devolvida pela API e **não** deve tentar adivinhar sucesso ou
   falha. Ofereça "reenviar" com um cooldown visual (o limite real é o do servidor, D-07).
3. **`/change-password?token=...`** — o caminho tem que bater com `PASSWORD_RESET_PATH` do `.env` da
   API.
   - Ao montar: `POST /auth/reset-password/verify` com `{ token }`. Se `400`, mostre "link expirado
     ou já usado" com um botão para pedir outro, **sem** renderizar o formulário.
   - Se válido: formulário de senha nova + confirmação, com **a mesma regra de validação da API**
     (mínimo 8, ao menos um número ou símbolo), para o usuário não descobrir a regra por um `400`.
   - `POST /auth/reset-password` com `{ token, newPassword, confirmNewPassword }` → em caso de `200`,
     redirecione para `/login` com um aviso de sucesso. **Não** espere sessão: a API não seta cookie
     nenhum (D-06).
   - **Limpe o token da URL** (`router.replace` sem a query) assim que a página montar, para não
     deixá-lo no histórico do navegador nem vazar por `Referer` — a outra metade do D-10.
