# Revisão de segurança — pré-deploy no ECR/ECS

> **Status:** bloco 1 ("antes do ECR") **aplicado e verificado** em 17/08/2026 — SEC-01, SEC-02,
> SEC-04, SEC-05, SEC-07, SEC-08, SEC-11 e SEC-16, mais a metade de logging do SEC-10.
> Bloco 2 (itens que dependem **só de código**) **aplicado e verificado** em 18/08/2026 —
> SEC-06, SEC-09, SEC-12 e a metade que faltava do SEC-10.
> O que resta depende de console AWS ou de esteira (SEC-13/SEC-20). O SEC-15 foi avaliado e
> **fechado por decisão** — o cost do bcrypt fica em 10. Ver a seção 6 para o recorte exato.
> **Data:** 17/08/2026 · **Última atualização:** 18/08/2026
> **Escopo:** todo o código de `src/`, `prisma/schema.prisma`, `Dockerfile`, `docker-compose.yml` e `.github/workflows/ci.yml`.

## 1. Premissas desta revisão

Confirmadas com você antes de escrever este documento:

| Premissa | Valor |
| --- | --- |
| Compute | **ECS com launch type EC2** (não Fargate) |
| Banco | **Ainda indefinido** — o documento cobre RDS e container, com recomendação para RDS |
| Domínio | **Subdomínios do mesmo domínio** (ex.: `app.seudominio.com` + `api.seudominio.com`), com HTTPS |
| Orçamento de borda | **Só o que é grátis/barato** — sem AWS WAF por enquanto |
| Risco central | Conta AWS com cartão vinculado: força bruta, flood e conexões repetitivas não podem virar custo |

Essas premissas mudam bastante o desenho. Duas consequências importantes já de saída:

**A boa notícia do ECS/EC2.** Diferente do Fargate, seu custo de compute é o custo das instâncias EC2 que estão ligadas — não o número de requisições. Um flood de requisições **degrada a performance, mas não multiplica a fatura**, desde que você não tenha um Auto Scaling Group subindo instâncias sozinho. Isso é uma proteção estrutural que o Fargate não te dá. O item [INFRA-01](#infra-01--auto-scaling-group-sem-teto-máximo) trata exatamente disso.

**A boa notícia dos subdomínios.** Como `app.seudominio.com` e `api.seudominio.com` são o mesmo *site registrável*, os cookies `SameSite=lax` que a API já emite continuam sendo enviados normalmente nas chamadas do front — e continuam **não** sendo enviados em requisições vindas de um site terceiro. Ou seja: a proteção CSRF que você já tem funciona nesse arranjo, sem precisar de `SameSite=none`. É a configuração mais segura das três que discutimos.

---

## 2. O que já está bem resolvido

Antes da lista de problemas, é justo registrar o que **não** precisa mudar — e é bastante coisa. Isso importa porque define onde vale gastar esforço.

- **Refresh token opaco, rotativo, com detecção de reuso e revogação por família** (`authService.ts`). É o padrão recomendado pela OWASP, e a maioria dos projetos nesse estágio não tem. Só o hash SHA-256 vai pro banco, nunca o valor puro.
- **Senhas com bcrypt**, nunca em texto plano, e o registro nunca devolve o hash (`toAuthUser` faz o *picking* explícito dos campos).
- **Mensagem de erro única no login** — "Credenciais inválidas" tanto pra usuário inexistente quanto pra senha errada. Evita enumeração via login.
- **Autorização checada no service, não no controller.** `loadUserResidenceContext`, `findResidenceForMember` e `loadOwnExpenseOrThrow` filtram por `userId`/`createdById` direto na query. Não encontrei nenhum IDOR: passar o id de uma despesa alheia devolve 404, não 403 — o que também não vaza a existência do recurso.
- **`markAsRead` filtra por `userId`** no `updateMany`, então não dá pra marcar notificação de outra pessoa.
- **Resposta indistinguível para código de residência inválido** (RN-050) + bloqueio de força bruta por usuário na tabela `JoinAttempt`, contado por usuário e não por residência alvo — o que evita que alguém bloqueie a casa dos outros de propósito.
- **Prisma com queries parametrizadas** em 100% do código. Não há `$queryRawUnsafe` nem concatenação de SQL: SQL injection não é um vetor aqui.
- **Zod validando todo corpo de requisição**, com whitelist de avatares e regex de formato em username e código de residência.
- **Dockerfile multi-stage, rodando como `USER node`**, com `prod-deps` separado. `.dockerignore` exclui `.env`, `.git` e `tests`. `.gitignore` exclui `.env`. Nenhum segredo está versionado (confirmei com `git ls-files`).
- **CI gera `JWT_SECRET` efêmero** por job, em vez de usar um segredo fixo.

O resultado disso é que **não há uma vulnerabilidade de lógica de aplicação grave** — nada de SQL injection, IDOR ou vazamento de hash. Os problemas reais estão em outro eixo: **ausência de controles de abuso e de exposição operacional**, que é exatamente o eixo que ameaça o seu cartão.

---

## 3. Tabela: problema → solução

Severidade: 🔴 crítico (não subir sem isso) · 🟠 alto (corrigir antes do domínio público) · 🟡 médio · ⚪ baixo

### Aplicação

✅ = já aplicado e verificado (ver o "como ficou" do item na seção 4) · 🚫 = avaliado e
**deliberadamente não aplicado** (a decisão e o porquê estão na seção 4) · sem marca = ainda pendente

| # | Problema | Onde | Sev | Solução |
| --- | --- | --- | :-: | --- |
| SEC-01 ✅ | **Nenhum rate limiting em nenhuma rota.** `/auth/login` aceita tentativas infinitas, e cada uma queima ~80 ms de CPU em `bcrypt.compare` | [src/app.ts](src/app.ts) | 🔴 | `express-rate-limit`: limitador global + limitador estrito nas rotas de `/auth` |
| SEC-02 ✅ | **`trust proxy` não configurado.** Atrás do ALB, `req.ip` é o IP privado do load balancer — qualquer rate limit por IP colocaria o mundo inteiro no mesmo balde | [src/app.ts](src/app.ts) | 🔴 | `app.set('trust proxy', 1)` antes de qualquer middleware |
| SEC-03 | **Segredos como variável de ambiente em texto plano.** `docker-compose.yml` usa `env_file: .env`; replicar isso no ECS deixa `JWT_SECRET` e `DATABASE_URL` legíveis na task definition | [docker-compose.yml](docker-compose.yml) | 🔴 | Usar o bloco `secrets:` da task definition, apontando pro SSM Parameter Store (SecureString) |
| SEC-04 ✅ | **Resposta 500 devolve a mensagem interna do erro** ao cliente. Um erro do Prisma expõe nome de tabela, coluna e constraint | [errorHandler.ts:17](src/middlewares/errorHandler.ts#L17) | 🟠 | Em produção, sempre `'Erro interno do servidor.'`; o detalhe só vai pro log |
| SEC-05 ✅ | **Sem cabeçalhos de segurança.** Sem HSTS, sem `X-Content-Type-Options`, e o `X-Powered-By: Express` entrega a stack | [src/app.ts](src/app.ts) | 🟠 | `helmet()` com HSTS habilitado (faz sentido assim que houver HTTPS) |
| SEC-06 ✅ | **Trocar a senha não derruba as sessões existentes.** Um refresh token roubado sobrevive à troca de senha por até 7 dias | [usersService.ts:60](src/services/users/usersService.ts#L60) | 🟠 | Revogar todos os `RefreshToken` do usuário e reemitir o par de tokens da sessão atual |
| SEC-07 ✅ | **Paginação e arrays sem teto.** `GET /notifications?limit=1000000` vira `take: 1000000`; `PATCH /notifications` com 100 mil ids vira um `IN (...)` gigante | [notificationsController.ts:26](src/controllers/notifications/notificationsController.ts#L26), [notificacoes.ts:8](src/schemas/notificacoes.ts#L8) | 🟠 | `limit` com teto de 100; array `ids` com `.max(200)` |
| SEC-08 ✅ | **Sem tratamento de `SIGTERM`.** Todo deploy do ECS mata requisições em voo e deixa conexões do Postgres penduradas | [server.ts:14](src/server.ts#L14) | 🟠 | `server.close()` + `prisma.$disconnect()` com timeout de guarda |
| SEC-09 ✅ | **Refresh tokens expirados nunca são apagados.** Cada refresh cria uma linha nova; ~96 linhas por usuário por dia com access token de 15 min | [schema.prisma](prisma/schema.prisma) | 🟡 | Limpeza periódica das linhas expiradas há mais de 30 dias |
| SEC-10 ✅ | **Nenhum evento de segurança é logado.** Login falho, reuso de refresh token detectado e bloqueio por rate limit passam invisíveis. Sem isso você não enxerga um ataque no CloudWatch | [logger.ts](src/utils/logger.ts), [app.ts:21](src/app.ts#L21) | 🟡 | Log estruturado (JSON) desses eventos + `morgan('combined')` em produção |
| SEC-11 ✅ | **Limite de corpo implícito.** `express.json()` usa o default de 100 kB — razoável, mas invisível e frágil a uma mudança futura | [app.ts:25](src/app.ts#L25) | 🟡 | `express.json({ limit: '32kb' })` — nenhum endpoint precisa de mais |
| SEC-12 ✅ | **JWT sem `issuer` e `audience`.** Um token assinado por outro sistema que compartilhe o segredo seria aceito | [authService.ts:158](src/services/auth/authService.ts#L158) | 🟡 | Adicionar `issuer`/`audience` na assinatura e exigi-los na verificação |
| SEC-13 | **Imagem base por tag mutável e sem scan.** `node:24-bookworm-slim` muda de conteúdo sem aviso | [Dockerfile](Dockerfile) | 🟡 | Pinar por digest + `scanOnPush` no ECR + step do Trivy no CI |
| SEC-14 | **Enumeração de usuários.** `/auth/register` responde 409 distinguindo email de username já usados; `/residences/:code/invites` responde 404 se o username não existe | [authService.ts:41](src/services/auth/authService.ts#L41) | 🟡 | Não dá pra eliminar sem estragar a UX — o que torna isso inexplorável é o rate limit do SEC-01 |
| SEC-15 🚫 | **bcrypt com cost 10.** Aceitável hoje, mas subir pra 12 dificulta 4× o crack offline | [authService.ts:12](src/services/auth/authService.ts#L12), [usersService.ts:6](src/services/users/usersService.ts#L6) | 🟡 | **Decidido em 18/08/2026: fica em 10.** Medição e justificativa na seção 4.6 |
| SEC-16 ✅ | **`failureRedirect` aponta pra uma rota da API que não existe.** Falha no login Google redireciona pra `/auth/login`, que responde 404 | [authRoutes.ts:22](src/routes/auth/authRoutes.ts#L22) | ⚪ | Redirecionar pra `${FRONTEND_URL}/login?error=oauth` |
| SEC-17 ✅ | **`/health` não distingue liveness de readiness.** Não toca o banco, então o ECS acha a task saudável com o Postgres fora do ar | [app.ts:43](src/app.ts#L43) | ⚪ | Manter `/health` barato pro ALB e adicionar `/ready` (com banco), não exposto publicamente |
| SEC-18 | **`uncaughtException` mata o processo.** Correto em princípio, mas com o ECS reiniciando significa que qualquer bug alcançável por requisição vira loop de restart | [server.ts:5](src/server.ts#L5) | ⚪ | Manter o comportamento; o rate limit do SEC-01 é o que fecha essa porta |
| SEC-19 | **`HEALTHCHECK` do Dockerfile é implícito.** Melhor declarar o health check explicitamente na task definition do que depender do que a imagem carrega | [Dockerfile](Dockerfile) | ⚪ | Declarar `healthCheck` na task definition; lembrar que o do target group do ALB é outro, separado |
| SEC-20 | **O CI publica no GHCR, não no ECR.** O pipeline atual não te leva ao destino que você quer | [ci.yml](.github/workflows/ci.yml) | ⚪ | Adicionar job de push pro ECR via OIDC (sem access key de longa duração) |

### Infraestrutura AWS — proteção direta da fatura

| # | Problema | Sev | Solução |
| --- | --- | :-: | --- |
| INFRA-01 | **Auto Scaling Group sem teto** transforma um flood em conta de EC2 | 🔴 | Fixar `MaxSize` do ASG e `maximumPercent` do serviço ECS em valores que você aceita pagar no pior dia do mês |
| INFRA-02 | **Sem alerta de gasto.** Você descobre o problema na fatura | 🔴 | AWS Budgets (grátis) com alerta em 50%, 80% e 100% do teto, por email |
| INFRA-03 | **Banco alcançável da internet** (vale pra RDS público ou pra container com a 5432 mapeada) | 🔴 | RDS em subnet privada, `PubliclyAccessible=false`, Security Group aceitando 5432 **só** do SG da aplicação |
| INFRA-04 | **Security Group da EC2 aberto** | 🟠 | Só o SG do ALB aceita 80/443 de `0.0.0.0/0`; o SG das instâncias aceita tráfego só do SG do ALB. Nada de SSH aberto — use SSM Session Manager |
| INFRA-05 | **Task role com privilégio amplo** | 🟠 | Separar *execution role* (puxa imagem do ECR + lê os segredos do SSM) de *task role* (só o que a aplicação precisa em runtime — que hoje é nada) |
| INFRA-06 | **ECR sem lifecycle policy** acumula imagem antiga e vira custo de storage silencioso | 🟡 | Lifecycle policy mantendo as últimas ~10 imagens; `scanOnPush` ligado |
| INFRA-07 | **Sem alarme de tráfego anômalo** | 🟡 | Alarme CloudWatch em `RequestCount` do target group e em `CPUUtilization` — é o seu detector de ataque de graça |
| INFRA-08 | **HTTP não redireciona pra HTTPS** | 🟡 | Listener 80 do ALB com regra de redirect 301 para 443; certificado via ACM (grátis) |

---

## 4. Detalhamento

### 4.1 Os dois itens que realmente importam

#### SEC-01 — Ausência total de rate limiting

Este é **o** problema desta revisão. Todos os outros são secundários em relação a ele.

**Por que é grave no seu caso.** `bcrypt.compare` com cost 10 leva algo em torno de 80–100 ms de CPU **pura**, e é síncrono no thread pool do Node. Um atacante com um script trivial mandando requisições em paralelo pra `POST /auth/login` satura a CPU da sua instância EC2 com um volume de tráfego irrisório — não precisa de botnet, um notebook basta. O efeito imediato é a API parar de responder pra todo mundo. E se houver Auto Scaling, o efeito secundário é a AWS subir instâncias novas pra atender o "pico de demanda", que é exatamente o cenário do seu cartão de crédito.

O mesmo vale, com variações, pra:
- `POST /auth/register` — `bcrypt.hash` (mesmo custo de CPU) + uma linha nova no banco por chamada. Enche o banco e a CPU ao mesmo tempo.
- `POST /auth/refresh` — cada chamada válida cria uma linha em `RefreshToken` (ver SEC-09).
- `POST /residences/join-requests` — tem o bloqueio da `JoinAttempt`, mas é por usuário autenticado; não impede um atacante de criar N contas.

**A mitigação que já existe** é pequena mas real: `loginSchema` valida o formato do username (mínimo 3 caracteres, regex `^[a-z0-9_]+$`) **antes** do controller, então tentativas com username malformado são rejeitadas com 400 sem tocar em bcrypt. Isso corta o lixo, não corta um ataque dirigido.

**Correção proposta.**

```bash
npm install express-rate-limit
```

Em `src/app.ts`, depois do `trust proxy` e antes das rotas:

```ts
import rateLimit from 'express-rate-limit';

// Teto global: protege a instância inteira. Generoso o bastante para o uso
// normal do front (que faz várias chamadas por tela) e apertado o bastante
// para que um script não consiga saturar a CPU da EC2.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Muitas requisições. Tente novamente em instantes.' },
});

// Rotas que gastam CPU em bcrypt ou criam registro no banco. Aqui o limite é
// por IP e bem mais duro: um humano legítimo não erra a senha 8 vezes em 15 min.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  skipSuccessfulRequests: true, // só conta o que falhou — login certo não gasta cota
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Muitas tentativas. Aguarde alguns minutos.' },
});

app.use(globalLimiter);
```

E em `src/routes/auth/authRoutes.ts`:

```ts
router.post('/register', authLimiter, validateBody(registerSchema), register);
router.post('/login', authLimiter, validateBody(loginSchema), login);
router.post('/refresh', refreshLimiter, refresh); // limite intermediário, ~30/15min
```

**Ponto de atenção sobre o store.** O `express-rate-limit` guarda a contagem em memória por padrão. Com **uma** task rodando, isso é perfeito. Com duas ou mais, cada uma tem seu próprio contador, e o limite efetivo vira N× o configurado. Enquanto você estiver com uma task só, memória basta. Quando escalar, a opção mais barata pro seu caso é usar o próprio Postgres como store (`rate-limit-postgresql`), evitando o custo de um ElastiCache.

#### SEC-02 — `trust proxy` não configurado

Este item é curto mas é **pré-requisito do SEC-01** — sem ele, o rate limiting não só não funciona como funciona errado.

No ECS/EC2 atrás de um ALB, toda requisição chega na sua aplicação vinda do IP privado do load balancer. O IP real do cliente vem no header `X-Forwarded-For`. Como o Express não confia nesse header por padrão, `req.ip` devolve o IP do ALB — o mesmo pra todos os usuários do mundo.

Consequência prática: com `authLimiter` de 8 tentativas, **o oitavo login falho de qualquer pessoa bloquearia todo mundo**. O limitador viraria uma ferramenta de negação de serviço contra os seus próprios usuários.

Além disso, o `express-rate-limit` v7 detecta essa situação e emite um erro de validação na inicialização, justamente porque é um erro de configuração comum e perigoso.

```ts
// src/app.ts — primeira linha depois do const app = express()
// 1 = confia em exatamente um proxy à frente (o ALB). Não usar `true`:
// confiar em qualquer número de proxies deixa o cliente forjar o X-Forwarded-For
// e burlar o rate limit trocando o header a cada requisição.
app.set('trust proxy', 1);
```

Esse `1` é importante. `app.set('trust proxy', true)` confia na cadeia inteira de `X-Forwarded-For`, e como qualquer cliente pode enviar esse header, o atacante simplesmente escreveria um IP diferente a cada requisição e o rate limit não valeria nada.

### 4.2 Exposição de informação

#### SEC-04 — Mensagem de erro interna vazando na resposta

```ts
// src/middlewares/errorHandler.ts:17
const message = err instanceof Error ? err.message : 'Erro interno do servidor.';
res.status(500).json({ message });
```

O caminho do `AppError` acima está correto — mensagens que você escreveu, pra situações que você previu. O problema é o fallback: qualquer erro **não previsto** tem sua mensagem entregue ao cliente.

O que vaza na prática: erros do Prisma trazem nome de model, campo e constraint (`Unique constraint failed on the fields: (\`email\`)`), erros de conexão trazem host e porta do banco, e um `TypeError` entrega nome de variável interna. É reconhecimento gratuito pra quem estiver sondando a API.

```ts
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }

  logError(err, `${req.method} ${req.originalUrl}`);

  // Erro não previsto: o detalhe fica no log (CloudWatch), o cliente recebe
  // sempre a mesma frase. Fora de produção a mensagem real ajuda a depurar.
  const message =
    env.NODE_ENV === 'production'
      ? 'Erro interno do servidor.'
      : err instanceof Error
        ? err.message
        : 'Erro interno do servidor.';

  res.status(500).json({ message });
}
```

#### SEC-05 — Cabeçalhos de segurança ausentes

Hoje a API responde com `X-Powered-By: Express` e sem nenhum cabeçalho defensivo. Com o domínio HTTPS entrando em cena, o mais relevante passa a ser o **HSTS**: sem ele, a primeira visita de um usuário a `api.seudominio.com` (ou uma tentativa de downgrade num Wi-Fi hostil) pode acontecer em HTTP, e o cookie de refresh — que tem `secure: true` — simplesmente não é enviado, além de a requisição em si trafegar aberta.

```bash
npm install helmet
```

```ts
import helmet from 'helmet';

app.use(
  helmet({
    // A API só devolve JSON, nunca HTML — CSP aqui não protege nada e só
    // complica. O CSP que importa é o do front-end (Next.js).
    contentSecurityPolicy: false,
    hsts: {
      maxAge: 15552000, // 180 dias
      includeSubDomains: true,
      preload: false,   // só ligue depois que TODO subdomínio estiver em HTTPS
    },
  }),
);
```

O `preload: false` é deliberado: entrar na lista de preload do HSTS é praticamente irreversível e vale pro domínio inteiro, incluindo subdomínios que você ainda não criou. Deixe pra depois que tudo estiver estável.

### 4.3 Ciclo de vida da sessão

#### SEC-06 — Troca de senha não revoga as sessões

O fluxo hoje (`usersService.ts:60`) troca o hash e devolve o usuário. A tabela `RefreshToken` não é tocada.

Cenário concreto: alguém captura o cookie `REFRESH` do seu usuário. O usuário desconfia e troca a senha — o gesto universal de "expulsar o invasor". Mas o refresh token roubado continua válido, continua rotacionando a cada 15 minutos, e o invasor mantém acesso por até 7 dias. A ação que o usuário acredita ter resolvido o problema não resolveu nada.

Vale notar que a infraestrutura pra corrigir isso **já existe** — `revokeTokenFamily` e o campo `familyId` estão implementados e testados. Falta só chamá-los.

```ts
// src/services/auth/authService.ts — nova função, ao lado de revokeRefreshToken
export async function revokeAllUserTokens(userId: number): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
```

E no controller, depois da troca bem-sucedida, revogar tudo e estabelecer uma sessão nova — assim quem trocou a senha continua logado e todos os outros dispositivos caem:

```ts
// src/controllers/users/usersController.ts — changePassword
const updated = await changeUserPassword(user.id, currentPassword, newPassword);
await revokeAllUserTokens(user.id);
await establishSession(res, updated); // reemite o par pro dispositivo atual
res.status(200).json({ user: updated });
```

`establishSession` hoje é privada do `authController`. A correção envolve exportá-la ou mover pra um módulo compartilhado — decisão de organização, não de segurança.

**Como ficou (aplicado em 18/08/2026).** Os helpers de cookie de sessão saíram do `authController`
para [src/lib/session.ts](src/lib/session.ts): `setAccessTokenCookie`, `setRefreshTokenCookie`,
`clearSessionCookies` e `establishSession`. A alternativa (exportar do `authController`) faria o
`usersController` importar outro controller, invertendo a direção normal das dependências —
e o que está sendo compartilhado é mecânica de transporte, não regra de negócio.

A ordem no controller não é cosmética: **revogar primeiro, emitir depois**. Invertida, o par novo
nasceria e seria revogado na mesma requisição, e quem trocou a senha cairia junto com o invasor —
o teste `reemite o par de tokens pro dispositivo que trocou a senha` existe pra travar isso, porque
o sintoma ("troquei a senha e fui deslogado") convida alguém a remover a revogação inteira.

#### SEC-09 — Refresh tokens expirados nunca são removidos

Cada chamada a `/auth/refresh` insere uma linha e revoga a anterior. Nada é apagado. Com access token de 15 minutos, um usuário ativo gera ~96 linhas por dia, ~35 mil por ano. Com o rate limit do SEC-01 isso é só crescimento previsível; **sem** ele, é um vetor de encher o disco do banco.

A `JoinAttempt` já resolve isso corretamente (`clearJoinAttempts` apaga as linhas). Falta o equivalente pro `RefreshToken`.

```ts
// Executado por um job periódico (ver nota abaixo)
export async function purgeExpiredRefreshTokens(): Promise<number> {
  // Mantém 30 dias de tokens já expirados/revogados: é a janela em que a
  // detecção de reuso ainda tem valor forense. Depois disso, é só peso morto.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const { count } = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });

  return count;
}
```

**Como agendar, sem custo:** um `setInterval` diário dentro do processo é a opção de esforço zero, mas roda N vezes com N tasks. A alternativa limpa e ainda grátis no seu setup é uma **ECS Scheduled Task** (EventBridge disparando uma task que roda o comando e sai) — é o mesmo padrão que o serviço `migrate` do `docker-compose.yml` já usa. Recomendo a segunda.

**Como ficou (aplicado em 18/08/2026).** O código entrega o executável, não o agendamento:

- `purgeExpiredRefreshTokens()` em [authService.ts](src/services/auth/authService.ts), com a janela
  em `REFRESH_TOKEN_RETENTION_DAYS = 30`;
- [src/scripts/purgeTokens.ts](src/scripts/purgeTokens.ts) → `dist/scripts/purgeTokens.js`: roda,
  loga quantas linhas removeu e sai. Disponível como `npm run purge:tokens`;
- [src/utils/tokenPurge.ts](src/utils/tokenPurge.ts) guarda o comportamento do invólucro (código de
  saída, desconexão, log) com dependências injetadas — mesma razão de `utils/shutdown.ts` existir
  separado de `server.ts`: importar o entrypoint num teste executaria a purga e mataria o processo
  do Jest.

O código de saída importa: **falha sai com 1**, inclusive quando só a desconexão falha. É o que faz
a execução aparecer como falhada no ECS — uma limpeza que quebra em silêncio é pior que nenhuma.

Falta só o agendamento no console: uma **ECS Scheduled Task** (EventBridge, `rate(1 day)`) usando a
mesma imagem de runtime, com `command` sobrescrito para `["node", "dist/scripts/purgeTokens.js"]`.

Verificado à mão contra o banco de dev: duas linhas com 40 dias inseridas, `npm run purge:tokens`
respondendo `2 linha(s) removida(s)` e saindo com código 0.

### 4.4 Trabalho não limitado

#### SEC-07 — Paginação e arrays sem teto

```ts
// src/controllers/notifications/notificationsController.ts:24-30
const parsedLimit = Number(limit);
if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
  throw new AppError(400, 'Limite inválido.');
}
result.limit = parsedLimit;
```

A validação garante que é inteiro positivo. Não garante que é razoável. `GET /notifications?limit=5000000` vira `take: 5000000` direto no Postgres — uma requisição autenticada, aparentemente legítima, que trava uma conexão do banco e estoura a memória do Node ao serializar o JSON.

O mesmo padrão em `markNotificationsReadSchema`:

```ts
ids: z.array(z.number().int().positive()).optional(),
```

Sem `.max()`, um array de 100 mil ids gera um `WHERE id IN (...)` com 100 mil parâmetros. O corpo cabe folgado no limite de 100 kB do `express.json()`.

```ts
// notificationsController.ts
const MAX_PAGE_SIZE = 100;

if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_PAGE_SIZE) {
  throw new AppError(400, `Limite inválido. Use um valor entre 1 e ${MAX_PAGE_SIZE}.`);
}
```

```ts
// schemas/notificacoes.ts
ids: z.array(z.number().int().positive()).max(200, 'No máximo 200 notificações por vez').optional(),
```

Vale uma varredura no mesmo padrão em `parseCompetencyQuery` (expenses e reports): o `month` é validado entre 1 e 12, mas o `year` aceita qualquer inteiro — `?year=999999999` passa. O impacto é bem menor (a query continua indexada e devolve vazio), mas é a mesma classe de descuido e o conserto é uma linha.

#### SEC-11 — Limite de corpo implícito

`express.json()` já aplica 100 kB por padrão, então **não há vulnerabilidade aberta hoje** — é um item de robustez. O maior corpo legítimo desta API é um `PATCH /notifications` com uma lista de ids; nada chega perto de 32 kB. Tornar explícito documenta a intenção e evita que alguém suba o limite sem perceber o que está liberando:

```ts
app.use(express.json({ limit: '32kb' }));
```

### 4.5 Operação no ECS

#### SEC-08 — Sem graceful shutdown

`src/server.ts` trata `uncaughtException` e `unhandledRejection`, mas não `SIGTERM`.

O ECS **sempre** manda `SIGTERM` antes de matar um container: em todo deploy, em todo scale-in, em toda substituição de task não saudável. Sem handler, o Node encerra na hora — requisições em voo morrem com erro no navegador do usuário, e as conexões do pool do Prisma ficam penduradas no Postgres até o timeout. Num deploy que substitui várias tasks, isso vira um punhado de conexões zumbis exatamente no momento em que o banco está mais ocupado.

```ts
// src/server.ts
const server = app.listen(env.PORT, () => {
  console.log(`API rodando na porta ${env.PORT}`);
});

// O ECS manda SIGTERM e espera stopTimeout (30s por padrão) antes do SIGKILL.
// A janela abaixo é deliberadamente menor, pra encerrar por vontade própria.
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} recebido — encerrando com elegância.`);

  const forceExit = setTimeout(() => {
    console.error('Shutdown demorou demais. Encerrando à força.');
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  server.close(async () => {
    await prisma.$disconnect();
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

Combine isso com um **deregistration delay** de ~30s no target group do ALB, pra que o load balancer pare de mandar tráfego novo antes de o container começar a se despedir.

#### SEC-17 — `/health` não distingue liveness de readiness

São duas perguntas diferentes, e confundi-las faz o orquestrador tomar a decisão errada:

| Sonda | Pergunta | Se a resposta for "não" |
| --- | --- | --- |
| Liveness (`/health`) | O processo está vivo? | Reiniciar a task resolve |
| Readiness (`/ready`) | Dá pra atender requisição agora? | Tirar do balanceamento resolve — reiniciar **não** |

O caso concreto que isso evita: o Postgres cai. Se `/health` consultasse o banco, ele começaria a
falhar, o ECS mataria e recriaria a task, a task nova também não acharia o banco, e você teria um
loop de restart enquanto o problema está em outro lugar — com o agravante de que cada restart perde
as requisições em voo que o SEC-08 tinha acabado de proteger.

**Como ficou (aplicado em 18/08/2026).** `/health` continua exatamente como estava: barato, sem
banco, declarado antes do rate limiting pro health check do ALB nunca tomar 429. O novo `/ready`
([src/utils/readiness.ts](src/utils/readiness.ts), montado em [app.ts](src/app.ts)) faz um
`SELECT 1` e responde:

- **200** `{ status: 'ready' }` quando o banco responde;
- **503** `{ status: 'unavailable' }` quando não — 503 e não 500 de propósito, porque é o status que
  significa "estou de pé, mas não me mande tráfego agora". Um 500 seria lido como bug da aplicação.

A mensagem do erro nunca vai na resposta, só no log: é o mesmo raciocínio do SEC-04, e `/ready` é
justamente o tipo de endpoint que um scanner encontra primeiro.

Uma diferença de posicionamento que vale registrar: `/ready` fica **depois** do limitador global,
ao contrário do `/health`. Ele custa um round trip no banco, então não pode ficar aberto pra ser
martelado. O probe do container chega pela loopback, sem `X-Forwarded-For`, que é um balde de rate
limit separado do de qualquer cliente vindo pelo ALB — duas chamadas por minuto não chegam perto do
teto de 120. Ainda assim, **o que impede exposição pública de verdade é o ALB não rotear `/ready`
pro target group**; o limitador é só a segunda camada.

**O que falta, no console:** apontar o `healthCheck` da task definition pro `/ready` (é o SEC-19) e
deixar o health check do target group do ALB no `/health`. São dois health checks diferentes e é
proposital: o do ALB decide balanceamento, o da task decide restart.

#### SEC-10 — Nenhum evento de segurança é logado

Hoje, se alguém passar a madrugada tentando senhas na sua API, você não tem como saber. O `logError` só é chamado no `errorHandler` para erros **não previstos** — e um login falho é um `AppError`, ou seja, sai pelo caminho que não loga nada.

Três eventos merecem log explícito, e o segundo é o mais importante de todos:

1. **Login falho** — com IP e username tentado. É o que revela força bruta.
2. **Reuso de refresh token detectado** (`rotateRefreshToken`, quando cai no `existing.revokedAt`) — isso é um sinal de **roubo de token confirmado**. É o alerta mais valioso que esta aplicação pode emitir, e hoje ele é silencioso.
3. **Rate limit atingido** — via o `handler` do `express-rate-limit`.

Além disso, `morgan('dev')` (`app.ts:21`) é o formato errado pra produção: colorido com códigos ANSI, sem timestamp e sem IP. No CloudWatch vira ruído ilegível.

```ts
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
```

Com o log estruturado em JSON no CloudWatch, você cria um **metric filter** (grátis) contando ocorrências de login falho e um **alarme** que te manda email quando passar de X por minuto. É o seu sistema de detecção de intrusão de custo zero — e a única forma de descobrir um ataque antes da fatura.

**Como ficou (aplicado em 18/08/2026).** `logSecurityEvent` em [logger.ts](src/utils/logger.ts) emite
uma linha por evento, sempre no mesmo formato:

```json
{"level":"security","event":"refresh_token_reuse","timestamp":"2026-08-18T13:49:01.358Z","ip":"203.0.113.44","userId":1847,"familyId":"ac51d50a-...","tokenHashPrefix":"38f3f1ce1ba9"}
```

Os três eventos e onde cada um mora:

| Evento | Onde | Campos |
| --- | --- | --- |
| `refresh_token_reuse` | `rotateRefreshToken`, no ramo do `existing.revokedAt` | `ip`, `userId`, `familyId`, `tokenHashPrefix` |
| `login_failed` | `loginWithCredentials`, nos dois ramos de falha | `ip`, `username`, `reason`, `userId` (quando o usuário existe) |
| `rate_limit_exceeded` | opção `handler` do `buildLimiter` | `ip`, `limiter`, `method`, `path`, `limit` |

**A decisão de desenho que este item exigia** era o IP: ele só existe no `req`, e a camada de serviço
não recebe `req`. Empurrar o objeto inteiro para dentro dos services acoplaria regra de negócio ao
Express. A saída foi um valor simples — `SecurityContext { ip?: string }` — que o controller monta e
o service só repassa (`securityContext(req)` no `authController`).

Com isso o log ficou no **service**, e não no controller, por um motivo que vale registrar: só lá
dentro se sabe *qual* ramo falhou. A resposta HTTP continua indistinguível entre "usuário não existe"
e "senha errada" (é o que impede enumeração), mas o log distingue `user_not_found` de
`invalid_password` — muitos do primeiro no mesmo IP é varredura de usernames; muitos do segundo no
mesmo username é força bruta de senha. São ataques diferentes, e a distinção não sobrevive a subir a
decisão para o controller.

O `rate_limit_exceeded` carrega o **nome do limitador** (`buildLimiter` passou a receber `name`)
porque "429 em `/auth/login`" pode ser tanto o `loginLimiter` quanto o teto global, e o número
significa coisas bem diferentes em cada caso. O `handler` customizado só registra o evento: status,
mensagem e `Retry-After` continuam idênticos — o header é setado pela própria biblioteca antes de o
handler rodar.

**O que nunca entra no log:** a senha tentada e o valor do refresh token. Do token vai só o prefixo
do hash (12 caracteres), que serve pra correlacionar a linha no banco e não serve pra reusar a
credencial. Há teste dedicado pra cada uma dessas duas regras.

**Silencioso em `NODE_ENV=test`**, pela mesma razão do `morgan` em `app.ts`: a suíte erra senha e
estoura limite dezenas de vezes de propósito, e cada evento viraria um bloco de console no relatório
do Jest. Os testes que precisam observar o log mutam `env.NODE_ENV` para `'production'` — o que
exercita o caminho real de produção, não uma simulação dele.

**Próximo passo, no console (grátis):** um metric filter por evento — `{ $.event = "login_failed" }`,
`{ $.event = "refresh_token_reuse" }` — e um alarme em cima de cada um. O do `refresh_token_reuse`
merece limiar 1: qualquer ocorrência é roubo de token confirmado, não ruído.

### 4.6 Itens menores, correções rápidas

**SEC-12 — JWT sem `issuer`/`audience`.** Baixo risco hoje (só esta aplicação usa o segredo), mas é uma linha em cada lado e previne confusão futura se você adicionar outro serviço:

```ts
// signToken
jwt.sign(payload, env.JWT_SECRET, {
  algorithm: 'HS256',
  expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  issuer: 'sistema-controle-despesas-api',
  audience: 'sistema-controle-despesas-web',
});

// verifyToken — precisa exigir os dois, senão adicioná-los não serve de nada
jwt.verify(token, env.JWT_SECRET, {
  algorithms: ['HS256'],
  issuer: 'sistema-controle-despesas-api',
  audience: 'sistema-controle-despesas-web',
});
```

Note que `algorithms: ['HS256']` já está corretamente fixado na verificação — isso fecha a família de ataques de confusão de algoritmo (`alg: none`, troca pra RS256). Bom trabalho aí.

**Aplicado em 18/08/2026**, com os valores acima fixados em `JWT_ISSUER`/`JWT_AUDIENCE` no
`authService`. **Consequência no deploy:** todo access token emitido *antes* desta subida passa a ser
rejeitado, porque não carrega os dois claims. Isso se resolve sozinho e sem ninguém perceber — o
refresh token é opaco (não é JWT, não passa por `verifyToken`) e continua válido, então o front
renova o par em no máximo 15 minutos, que é o `JWT_EXPIRES_IN`. Não é preciso coordenar nada com o
front nem invalidar sessões; o pior caso para um usuário é um 401 seguido do refresh automático.

**SEC-15 — bcrypt cost. 🚫 Decidido em 18/08/2026: fica em 10.** Não é pendência, é escolha — e o
raciocínio fica registrado aqui pra ninguém refazer a conta daqui a seis meses.

10 está dentro do recomendado pela OWASP. Subir pra 12 quadruplica o custo de um ataque offline caso
o banco vaze — mas **também quadruplica o custo de CPU de cada tentativa de login**. A proposta
original era subir depois do SEC-01 (antes dele, pioraria o DoS por CPU em 4×). Com o rate limit já
no lugar, o item destravou e foi então avaliado com número em vez de intuição.

**Medição** (`bcrypt.compare`, máquina de desenvolvimento; numa `t3.small`/`t4g.small` espere de
1,5× a 2,5× disso):

| cost | hash | compare |
| :-: | --: | --: |
| 10 | 61 ms | 56 ms |
| 11 | 111 ms | 108 ms |
| 12 | 218 ms | 219 ms |

**O caminho de ataque que decide a questão** não é o da força bruta. Login falho é capado em 8 por
IP a cada 15 min, e username inexistente nem chega no bcrypt (`loginWithCredentials` sai antes),
então saturar 2 vCPU por ali exige escala de botnet nos dois costs — ~1800 IPs a cost 10, ~500 a
cost 12.

O caminho que importa é o **login bem-sucedido**: `loginLimiter` usa `skipSuccessfulRequests: true`,
de propósito (SEC-01), então sucesso não gasta cota e o único teto é o global de 120/min por IP.
Com uma única conta válida — inclusive uma que o próprio atacante cadastre:

| | CPU por IP, por minuto | IPs pra saturar 2 vCPU |
| --- | --- | :-: |
| cost 10 | ~14 s (0,24 vCPU) | ~8 |
| cost 12 | ~54 s (0,90 vCPU) | **~3** |

**E o ganho é menor do que o "4×" sugere**, por três motivos que se somam:

1. Só existe se o banco de hashes vazar — cenário que o RDS privado (INFRA-03/04) e os segredos no
   SSM (SEC-03) atacam de forma mais direta e mais barata.
2. O cost é multiplicador linear contra uma grandeza exponencial: +2 de cost equivale a **2 bits**
   de entropia de senha. Subir o mínimo de senha de 8 para 12 caracteres vale mais que os 4× e custa
   zero de CPU.
3. **Trocar a constante não re-hasheia ninguém.** O cost fica gravado dentro do hash, então todo
   usuário existente permaneceria em 10 de qualquer forma. Alcançar a base exigiria re-hash no login
   bem-sucedido (`bcrypt.getRounds(hash) < SALT_ROUNDS` → re-hash), que esta revisão não previu.

**Se um dia isso for revisitado**, o momento é junto de uma instância maior, e o item cresce: cost
11 em vez de 12, re-hash no login, e `SALT_ROUNDS` unificado — hoje ele está declarado em **dois**
lugares (`authService.ts:12` para o registro e `usersService.ts:6` para a troca de senha), e mudar
um só faria senha trocada nascer mais fraca que senha de cadastro, sem sintoma nenhum.

**SEC-14 — Enumeração de usuários.** `/auth/register` distingue "email já existe" de "username já em uso", e `/residences/:code/invites` responde 404 quando o username não existe. As duas coisas são necessárias pra UX — o usuário precisa saber qual campo corrigir. O que torna isso inexplorável não é mudar a mensagem, é o rate limit: com 8 tentativas por 15 minutos, enumerar uma base de usuários leva anos. É por isso que este item está aqui embaixo e não no topo.

**SEC-16 — `failureRedirect`.** Aponta pra `/auth/login`, que na API só existe como POST. Uma falha no login Google devolve 404 pro navegador do usuário. Deve apontar pro front: `${env.FRONTEND_URL}/login?error=oauth`.

**SEC-13 — Imagem base e scan.** `node:24-bookworm-slim` é uma tag móvel: o conteúdo muda sem aviso, então dois builds do mesmo commit podem gerar imagens diferentes. Pinar por digest (`node:24-bookworm-slim@sha256:...`) torna o build reproduzível e impede que uma imagem base comprometida entre silenciosamente. No ECR, ligue `scanOnPush` (o basic scanning é grátis) e adicione um step do Trivy no CI falhando em CVE HIGH/CRITICAL.

---

## 5. Camada AWS — o que protege o cartão

Esta seção é específica pro **ECS/EC2 sem WAF**, conforme suas respostas.

### INFRA-01 — Auto Scaling Group sem teto máximo

**O item mais importante desta seção.** No ECS/EC2, sua conta de compute é o número de instâncias EC2 ligadas. Sem autoscaling, esse número é fixo e um ataque não pode aumentá-lo — ele só deixa a API lenta. **Com** autoscaling e sem teto, um flood vira instâncias novas subindo a noite inteira.

Se você configurar autoscaling, fixe:
- `MaxSize` do Auto Scaling Group num número que você aceita pagar por 30 dias seguidos.
- `maximumPercent` / contagem máxima de tasks do serviço ECS coerente com isso.

Se **não** configurar autoscaling (perfeitamente razoável pra este projeto), seu teto de compute já é fixo por construção — e essa é a proteção mais forte que existe contra DDoS financeiro.

### INFRA-02 — AWS Budgets

Grátis, dois minutos pra configurar, e é a única coisa que te avisa antes da fatura:

- Budget mensal no valor que você espera gastar.
- Alertas em 50%, 80% e 100% do **valor real**, e mais um em 100% do **valor previsto** (esse dispara mais cedo, no meio do mês, quando a projeção sobe).
- Email no seu endereço pessoal.

### INFRA-03 / INFRA-04 — Rede

Você ainda não decidiu o banco. Recomendo **RDS PostgreSQL** (db.t4g.micro está no free tier no primeiro ano) pelos backups automáticos e pelo isolamento de rede. Se preferir o container Postgres na mesma instância, é mais barato, mas backup e volume passam a ser problema seu, e a porta 5432 **nunca** pode ser mapeada pra fora do host.

Nos dois casos:

```
Internet
   ↓ (443 apenas)
[ SG-alb ]      inbound: 443 e 80 de 0.0.0.0/0
   ↓
[ SG-app ]      inbound: porta 3001 APENAS de SG-alb
   ↓
[ SG-db ]       inbound: 5432 APENAS de SG-app
```

Regras que valem a pena repetir: o banco nunca tem IP público (`PubliclyAccessible = false`), nenhum Security Group libera 22 de `0.0.0.0/0` (use **SSM Session Manager** — acesso a shell sem porta aberta e sem chave SSH pra perder), e a EC2 fica em subnet privada com NAT ou, pra economizar o NAT Gateway (~US$ 32/mês, que costuma ser a maior surpresa da fatura), em subnet pública com o Security Group fechado.

### INFRA-05 — IAM

Duas roles distintas, ambas com o mínimo:

- **Task execution role** — puxar a imagem do ECR, escrever logs no CloudWatch, ler os parâmetros do SSM referenciados no bloco `secrets`.
- **Task role** — o que a aplicação usa em runtime. Hoje ela não chama nenhuma API da AWS, então essa role pode ficar **vazia**. Não dê `AmazonS3FullAccess` "por precaução".

Pro CI empurrar imagem pro ECR, use **OIDC do GitHub Actions** assumindo uma role, em vez de gravar `AWS_ACCESS_KEY_ID`/`SECRET` como secret do repositório. Credencial de longa duração em CI é uma das formas mais comuns de conta AWS ser sequestrada — e o efeito típico é mineração de cripto na sua fatura, que é exatamente o cenário que te preocupa.

### INFRA-06 / INFRA-07 / INFRA-08

- **ECR:** lifecycle policy mantendo as últimas ~10 imagens (o CI publica uma por commit na `main`; sem policy isso cresce pra sempre) e `scanOnPush` habilitado.
- **CloudWatch:** alarme em `RequestCount` do target group e em `CPUUtilization` das instâncias. Um pico de `RequestCount` com CPU alta e nenhum usuário novo é a assinatura do SEC-01 sendo explorado.
- **ACM + ALB:** certificado gratuito via ACM, com renovação automática. Listener 80 apenas com regra de redirect 301 pra 443 — nunca servindo a aplicação.

### Sobre o WAF, já que você optou por não usá-lo agora

A decisão é defensável e eu concordo com ela pra este estágio. Vale saber o que ela deixa de fora, pra você poder rever depois:

- **Você fica protegido** contra força bruta e enumeração — pelo rate limit da aplicação (SEC-01), desde que ele seja implementado.
- **Você fica protegido** contra ataques volumétricos de camada 3/4 (SYN flood, UDP flood) — o **AWS Shield Standard** cobre isso automaticamente, de graça, em todo ALB.
- **Você fica exposto** a floods de camada 7 vindos de muitos IPs distintos. O rate limit por IP não pega isso, e sem WAF o tráfego chega até o seu container. Com ECS/EC2 sem autoscaling, o dano é indisponibilidade — não uma fatura inesperada. **É por isso que o INFRA-01 vale mais que o WAF no seu caso.**

O gatilho pra reconsiderar: se você um dia migrar pro Fargate, ligar autoscaling, ou o tráfego legítimo crescer a ponto de a indisponibilidade custar caro.

---

## 6. Ordem de execução sugerida

**Antes de subir a imagem pro ECR** — ✅ **concluído em 17/08/2026**:

1. ✅ SEC-02 — `trust proxy` fixado em `1`
2. ✅ SEC-01 — rate limiting (`express-rate-limit`), em `src/middlewares/rateLimit.ts`
3. ✅ SEC-04 — erro interno não vaza mais em produção
4. ✅ SEC-05 — `helmet` com HSTS
5. ✅ SEC-07 — tetos de paginação e de array de ids
6. ✅ SEC-08 — graceful shutdown com `SIGTERM`/`SIGINT`
7. ✅ SEC-11 — limite de corpo explícito em 32kb

Levados junto por estarem nos mesmos arquivos: ✅ SEC-16 (`failureRedirect` do Google agora aponta
pro front) e a metade fácil do SEC-10 (`morgan` em formato `combined` quando em produção — a outra
metade, o log estruturado de eventos de segurança, veio no bloco 2 abaixo).

Verificação: 209 testes passando (45 novos, ver seção 7), e o container de produção exercitado de verdade —
9ª tentativa de login recebendo 429 com `Retry-After`, erro interno respondendo
`"Erro interno do servidor."` com o `PrismaClientKnownRequestError` só no log, e `docker stop`
encerrando em 0,6s com código 0 em vez de levar SIGKILL aos 30s.

**Bloco 2 — o que dependia só de código** — ✅ **concluído em 18/08/2026**:

8. ✅ SEC-06 — troca de senha revoga todos os refresh tokens e reemite o par pro dispositivo atual
9. ✅ SEC-10 — log estruturado dos três eventos de segurança (a metade que faltava)
10. ✅ SEC-12 — `issuer`/`audience` assinados **e exigidos** na verificação
11. ✅ SEC-09 — purga dos refresh tokens, entregue como executável (`npm run purge:tokens`)
12. ✅ SEC-17 — `/ready` tocando o banco, com `/health` seguindo barato e sem banco

Verificação: 252 testes passando (43 novos, ver seção 7), 18 regressões introduzidas de propósito e
todas derrubando a suíte, `npm run build` limpo, e o entrypoint da purga exercitado contra o banco de
dev (2 linhas antigas removidas, saída com código 0).

Nenhum destes quatro precisa de console AWS pra funcionar. Dois deixam uma ponta lá, e só isso:
o SEC-09 precisa da Scheduled Task pra rodar sozinho, e o SEC-10 precisa dos metric filters
pra virar alarme.

Isto **não** esgota o código: junto da esteira sobraram o SEC-13 (Dockerfile) e o SEC-20 (job de
push pro ECR).

E o SEC-15, que também era código, foi avaliado e fechado por decisão — ver a seção 4.6.

**Antes de apontar o domínio pro ambiente** (infra):

12. INFRA-02 — AWS Budgets *(console, 2 min)*
13. INFRA-01 — teto do ASG / sem autoscaling *(console)*
14. INFRA-03/04 — Security Groups e banco privado
15. SEC-03 — segredos no SSM Parameter Store
16. INFRA-08 — ACM + redirect 80→443

**Nas semanas seguintes:**

17. SEC-10 (console) — metric filters + alarmes em cima dos eventos que a aplicação já emite
18. SEC-09 (console) — ECS Scheduled Task chamando `dist/scripts/purgeTokens.js`
19. INFRA-05 — OIDC no CI + roles mínimas · SEC-20 — push pro ECR
20. SEC-13, SEC-19 — o resto

🚫 **SEC-15 saiu da fila em 18/08/2026 por decisão, não por esquecimento:** o cost do bcrypt fica em
10. A medição que sustenta isso está na seção 4.6.

Os sete primeiros itens somam algo em torno de **60 linhas de código e duas dependências novas**. É pouco trabalho pro tanto de risco que fecham. O bloco 2 não trouxe dependência nenhuma.

---

## 7. Cobertura de testes das correções

252 testes no total (88 novos: 45 no bloco 1, 43 no bloco 2). Os das correções de segurança:

| Arquivo | Testes | Cobre |
| --- | :-: | --- |
| [tests/integration/authRateLimit.test.ts](tests/integration/authRateLimit.test.ts) | 8 | Os limitadores **reais** montados nas **rotas reais**: login bloqueia na 9ª falha, sucesso não gasta cota, registro bloqueia na 11ª e conta sucessos, refresh tem limite próprio, `/health` nunca é bloqueado, limitador global protege as demais rotas |
| [tests/integration/security.test.ts](tests/integration/security.test.ts) | 16 | Headers do helmet, limite de corpo (413) e JSON malformado (400), tetos de paginação, CORS que não reflete a origem do solicitante, cookies `HttpOnly`/`SameSite=Lax`/`Secure` |
| [tests/integration/rateLimit.test.ts](tests/integration/rateLimit.test.ts) | 7 | O comportamento do limitador em si: contagem, headers `draft-7`, `skipSuccessfulRequests` nos dois sentidos, baldes separados por IP real |
| [tests/unit/shutdown.test.ts](tests/unit/shutdown.test.ts) | 7 | Encerramento: ordem (servidor antes do banco), idempotência, falha no close, falha no disconnect, estouro do tempo limite |
| [tests/unit/errorHandler.test.ts](tests/unit/errorHandler.test.ts) | 9 | Produção não vaza a mensagem interna mas o log mantém o detalhe; ramos de 413 e 400 |
| [tests/unit/notificacoes.schemas.test.ts](tests/unit/notificacoes.schemas.test.ts) | 7 | Teto de 200 ids |
| [tests/integration/passwordChange.test.ts](tests/integration/passwordChange.test.ts) | 6 | **SEC-06**: outro dispositivo perde o refresh token, o token anterior do próprio dispositivo também morre, sobra exatamente 1 linha ativa no banco, o par é reemitido pra quem trocou, a sessão dele segue renovando e chamando rota autenticada, e uma troca **falhada** não revoga nada |
| [tests/integration/securityEvents.test.ts](tests/integration/securityEvents.test.ts) | 9 | **SEC-10** pelo HTTP: login falho registra IP real e username, `user_not_found` distinto de `invalid_password`, login bem-sucedido não registra nada, reuso de refresh token registra `userId`/`familyId`, rotação legítima não registra, bloqueio registra o limitador que barrou — e as duas regras de sigilo: nunca a senha tentada, nunca o token cru |
| [tests/integration/refreshTokenPurge.test.ts](tests/integration/refreshTokenPurge.test.ts) | 7 | **SEC-09** contra o banco real: apaga expirado e revogado além da janela, **preserva** token ativo, revogado ontem (é ele que detecta reuso) e expirado ontem, devolve a contagem, e é idempotente |
| [tests/unit/logger.test.ts](tests/unit/logger.test.ts) | 5 | **SEC-10** formato: uma linha, JSON válido, chaves `level`/`event`/`timestamp`, detalhes no mesmo nível (pra `$.ip` funcionar em qualquer evento), username hostil escapado em vez de forjar uma linha falsa, silêncio em `NODE_ENV=test` |
| [tests/unit/auth.service.test.ts](tests/unit/auth.service.test.ts) | +4 | **SEC-12**: token assinado com `iss`/`aud`, e rejeição de token bem assinado porém sem os claims, com outro issuer ou com outra audience |
| [tests/unit/readiness.test.ts](tests/unit/readiness.test.ts) | 5 | **SEC-17**: 200 com o banco de pé, **503** (não 500) com o banco fora, mensagem do erro no log mas nunca na resposta, e o erro não escapando pro `errorHandler` |
| [tests/integration/health.test.ts](tests/integration/health.test.ts) | +3 | **SEC-17** na fiação real: `/ready` consulta o banco de verdade, `/health` responde **sem** tocar nele (espionando `prisma.$queryRaw` nos dois casos) |
| [tests/unit/tokenPurge.test.ts](tests/unit/tokenPurge.test.ts) | 4 | **SEC-09** invólucro: loga a contagem, desconecta sempre, sai com 1 se a purga falhar e sai com 1 se só a desconexão falhar |

### Por que existem dois arquivos de rate limit

`rateLimit.test.ts` monta limitadores próprios e prova que a biblioteca se comporta como
esperado. Isso **não** prova que ela está ligada nas suas rotas — e a diferença não é teórica:
removendo o `loginLimiter` de `authRoutes.ts`, a suíte antiga continuava inteiramente verde.

`authRateLimit.test.ts` fecha esse buraco exercitando os limitadores reais. Para isso, os
limitadores expõem `setRateLimitersArmedInTests()`: eles ficam desarmados em `NODE_ENV=test`
(senão a suíte de integração, que dispara dezenas de requisições nas rotas de auth de propósito,
testaria o limitador em vez do endpoint), e esse gancho os rearma só onde é a intenção. O gancho é
inerte fora de test — em produção `env.NODE_ENV === 'test'` já é falso e os limitadores estão
sempre armados.

### Validação por mutação

Testes que não falham quando a proteção some não valem nada. Quatro regressões plausíveis num
refactor foram introduzidas de propósito e todas derrubaram a suíte:

| Regressão simulada | Resultado |
| --- | --- |
| Remover `loginLimiter` da rota de login | 2 testes falham |
| Trocar `trust proxy` de `1` para `true` | 1 teste falha |
| Remover o limite explícito de corpo | 1 teste falha |
| Voltar a vazar o erro interno em produção | 1 teste falha |

O bloco 2 passou pelo mesmo crivo — 13 regressões, todas pegas:

| Regressão simulada | Item | Resultado |
| --- | :-: | --- |
| Não revogar as outras sessões na troca de senha | SEC-06 | 3 testes falham |
| Revogar mas não reemitir a sessão do dispositivo atual | SEC-06 | 3 testes falham |
| Inverter a ordem (emitir antes de revogar) | SEC-06 | 2 testes falham |
| Purgar só por `expiresAt`, ignorando os revogados | SEC-09 | 1 teste falha |
| Purgar sem janela de retenção (apagar todo revogado) | SEC-09 | 2 testes falham |
| Reuso de refresh token volta a ser silencioso | SEC-10 | 2 testes falham |
| Login falho volta a ser silencioso | SEC-10 | 1 teste falha |
| Rate limit volta ao handler padrão, sem log | SEC-10 | 1 teste falha |
| Logar o token cru em vez do prefixo do hash | SEC-10 | 1 teste falha |
| Perder o IP no caminho controller → service | SEC-10 | 2 testes falham |
| Assinar com `iss`/`aud` mas não exigir na verificação | SEC-12 | 3 testes falham |
| Parar de assinar com `iss`/`aud` | SEC-12 | 2 testes falham |
| Logger volta a ficar mudo mesmo fora de `test` | SEC-10 | 4 testes falham |
| `/ready` deixa de tocar o banco (vira um `/health` disfarçado) | SEC-17 | 1 teste falha |
| `/health` passa a consultar o banco | SEC-17 | 1 teste falha |
| Banco fora do ar responde 500 em vez de 503 | SEC-17 | 1 teste falha |
| Vazar a mensagem do erro do banco na resposta | SEC-17 | 2 testes falham |
| Deixar o erro escapar pro `errorHandler` | SEC-17 | 4 testes falham |

Duas dessas valem menção separada. A do **IP perdido entre controller e service** é a que justifica os
testes de segurança irem pelo HTTP em vez de chamarem o service direto: um teste unitário do
`loginWithCredentials` passaria feliz com `context` vazio, e o log chegaria ao CloudWatch sem o único
campo que permite identificar a origem do ataque. A do **"assinar mas não exigir"** (SEC-12) é a
metade que passa despercebida num refactor justamente porque o sistema continua funcionando
normalmente — e sem exigir, adicionar os claims não protege de nada.

### O que os testes não cobrem

- **SEC-08 fim a fim.** Os testes unitários cobrem a lógica de encerramento com dependências
  injetadas, mas a entrega real do `SIGTERM` só foi verificada manualmente no container
  (`docker stop` encerrando em 0,6s com código 0). Windows não entrega SIGTERM a um processo Node,
  então isso não é automatizável no ambiente de desenvolvimento.
- **HSTS de verdade.** O teste confere que o header sai; que o navegador o respeite depende do
  certificado e do domínio, que ainda não existem.
- **Os limites em números absolutos.** `LOGIN_LIMIT`, `REGISTER_LIMIT` etc. são importados pelos
  testes, então mudar o valor não quebra nada — de propósito. O que os testes travam é o
  *comportamento* (bloqueia depois do limite, seja ele qual for), não a política.
- **O agendamento da purga (SEC-09).** Os testes cobrem o recorte do `deleteMany` contra o banco real
  e o invólucro do executável (código de saída, desconexão, log). Que o EventBridge dispare a task
  todo dia só existe no console — enquanto a Scheduled Task não for criada, a purga é um comando que
  ninguém chama.
- **O alarme do CloudWatch (SEC-10).** A aplicação emite os eventos no formato que o metric filter
  consome, e o formato está travado por teste. Que exista um filtro e um alarme lendo esses eventos
  é configuração de console — sem isso, o log é uma caixa-preta que só serve depois do incidente,
  não durante.
- **O posicionamento do `/ready` depois do limitador global (SEC-17).** Nenhum teste trava a ordem
  de declaração no `app.ts`, então mover a rota pra cima do `globalLimiter` passaria silencioso. A
  contenção que importa é o ALB não rotear `/ready`, e essa não é testável daqui.
- **A janela de 30 dias em si.** `REFRESH_TOKEN_RETENTION_DAYS` é importado pelos testes, então
  mudar o número não quebra nada — igual aos limites de rate limit. O que está travado é o
  comportamento: preserva o que está dentro da janela, apaga o que está fora.

---

## 8. Decisões que ainda dependem de você

1. **Banco: RDS ou container?** Minha recomendação é RDS (`db.t4g.micro`, free tier no primeiro ano) — backup automático e isolamento de rede valem o preço depois do free tier. Se optar pelo container, precisamos definir estratégia de volume e backup, que hoje não existe.

2. **Vai ter autoscaling?** Se a resposta for não, seu teto de gasto já está fixado e o INFRA-01 vira só um "confirme que está desligado". Se for sim, precisamos definir o `MaxSize` juntos.

3. **Store do rate limit.** Memória (uma task) ou Postgres (várias tasks)? Recomendo começar em memória com uma task só, e migrar quando escalar.

4. ~~**Aplico as correções agora?**~~ Respondido em dois recortes: o bloco "antes do ECR" em
   17/08/2026 e o bloco que dependia só de código em 18/08/2026. O que resta na seção 6 depende de
   console AWS (INFRA-01..08, SEC-03, e as pontas de console do SEC-09 e do SEC-10) ou de esteira
   (SEC-13, SEC-20), fora o SEC-19, que é task definition. O SEC-17 entrou junto do bloco 2 e o
   SEC-15 foi fechado por decisão (item 5 abaixo).

5. ~~**Cost do bcrypt (SEC-15).**~~ **Decidido em 18/08/2026: fica em 10.** Com `skipSuccessfulRequests`
   no limitador de login, cost 12 faria 3 IPs com uma conta válida ocuparem ~90% de uma instância de
   2 vCPU, contra ~8 IPs no cost 10 — e o ganho seria condicional a um vazamento do banco e não
   alcançaria nenhum usuário existente (o cost fica gravado no hash). Medição completa na seção 4.6.

6. **Limiar dos alarmes do CloudWatch.** Sugiro `refresh_token_reuse >= 1` em qualquer janela (toda
   ocorrência é roubo confirmado) e `login_failed` em algo como 30 por 5 minutos — mas o segundo
   número depende do seu volume real de usuários, que hoje nenhum de nós sabe. Vale começar frouxo e
   apertar depois de uma semana observando.

5. **Trocar as chaves antes do deploy.** O `JWT_SECRET` do seu `.env` local foi usado em desenvolvimento e pode ter passado por logs, backups ou terminal. Gere segredos novos pra produção e guarde **só** no SSM Parameter Store:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
