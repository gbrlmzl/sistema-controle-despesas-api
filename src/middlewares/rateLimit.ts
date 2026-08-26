import rateLimit, { type Options } from 'express-rate-limit';
import { env, rateLimitDisabled } from '../config/env.js';
import { logSecurityEvent } from '../utils/logger.js';

// SEC-01 -> Limitadores de requisição. Sem eles, `POST /auth/login` aceita tentativas
// infinitas, e cada uma queima ~80ms de CPU em bcrypt.compare — um script simples
// satura a instância inteira com tráfego irrisório, sem precisar de botnet.
//
// Depende de `app.set('trust proxy', 1)` (SEC-02) estar configurado antes: atrás de um
// load balancer, sem isso, `req.ip` é o IP do proxy e todos os usuários caem no mesmo
// balde — o limitador viraria negação de serviço contra os próprios usuários.

// A suíte de integração dispara dezenas de requisições nas mesmas rotas de propósito
// (registrar, logar, errar a senha, repetir). Com o limitador armado, ela testaria o
// limitador em vez do endpoint. A cobertura do limitador em si vive em
// tests/integration/rateLimit.test.ts, que monta os seus próprios com limite baixo.
let armedInTests = false;

// Gancho para os testes que precisam exercitar os limitadores REAIS montados nas rotas
// reais (ver tests/integration/authRateLimit.test.ts). Sem ele, dá para provar que a
// biblioteca funciona, mas não que ela continua ligada em /auth/login — um refactor
// poderia desarmar a proteção sem nenhum teste acusar.
//
// É inerte fora de test: em produção `env.NODE_ENV === 'test'` já é falso, então os
// limitadores ficam armados independentemente deste valor.
export function setRateLimitersArmedInTests(armed: boolean): void {
  armedInTests = armed;
}

// Duas razões distintas para não contar uma requisição: a suíte de integração da
// própria API (acima) e a suíte e2e do front, que roda contra a API em development e
// precisa de mais cadastros por hora do que o REGISTER_LIMIT permite
// (RATE_LIMIT_DISABLED, ignorada em produção — ver src/config/env.ts).
const shouldSkip = (): boolean => rateLimitDisabled || (env.NODE_ENV === 'test' && !armedInTests);

// Exportada para os testes: como as opções são espalhadas por último, um teste
// consegue armar o limitador em ambiente de test passando `skip: () => false`.
//
// `name` identifica qual limitador barrou a requisição no log do SEC-10 — sem isso,
// "429 em /auth/login" pode ser tanto o loginLimiter quanto o teto global, e a resposta
// muda completamente o que o número significa.
export function buildLimiter(name: string, options: Partial<Options>) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: shouldSkip,
    // SEC-10 -> Substitui o handler padrão da biblioteca só pra registrar o evento; a
    // resposta continua idêntica (mesmo status, mesma mensagem configurada). O header
    // `Retry-After` é setado pela própria biblioteca antes de chegar aqui.
    handler: (req, res, _next, resolvedOptions) => {
      logSecurityEvent('rate_limit_exceeded', {
        ip: req.ip,
        limiter: name,
        method: req.method,
        path: req.originalUrl,
        limit: resolvedOptions.limit,
      });

      res.status(resolvedOptions.statusCode).send(resolvedOptions.message);
    },
    ...options,
  });
}

// Teto geral por IP. Serve de rede de proteção para a instância como um todo: mesmo
// uma rota barata, chamada rápido o bastante, ocupa o event loop. O valor é folgado
// para o uso real do front (uma tela de dashboard dispara várias chamadas de uma vez)
// e apertado o bastante para um script não conseguir saturar a máquina.
export const GLOBAL_LIMIT = 120;

export const globalLimiter = buildLimiter('global', {
  windowMs: 60 * 1000,
  limit: GLOBAL_LIMIT,
  message: { message: 'Muitas requisições. Tente novamente em instantes.' },
});

// Login: o alvo clássico de força bruta e o mais caro em CPU da API.
// `skipSuccessfulRequests` faz o limite contar só o que falhou — quem acerta a senha
// nunca gasta cota, então usuário legítimo não é penalizado por logar várias vezes.
export const LOGIN_LIMIT = 8;

export const loginLimiter = buildLimiter('login', {
  windowMs: 15 * 60 * 1000,
  limit: LOGIN_LIMIT,
  skipSuccessfulRequests: true,
  message: { message: 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.' },
});

// Registro: aqui o sucesso PRECISA contar (por isso, sem `skipSuccessfulRequests`).
// O risco não é adivinhar senha, é criar conta em massa — cada cadastro gasta
// bcrypt.hash e ocupa uma linha no banco. Limitar só o que falha deixaria a fazenda
// de contas passar livre.
export const REGISTER_LIMIT = 10;

export const registerLimiter = buildLimiter('register', {
  windowMs: 60 * 60 * 1000,
  limit: REGISTER_LIMIT,
  message: { message: 'Muitos cadastros a partir deste endereço. Tente novamente mais tarde.' },
});

// Refresh: o front chama sozinho a cada expiração do access token (15 min), e o
// usuário pode ter várias abas abertas — daí o limite bem mais generoso que o do
// login. Ainda assim limitado, porque cada chamada válida insere uma linha nova em
// RefreshToken (ver SEC-09).
export const REFRESH_LIMIT = 30;

export const refreshLimiter = buildLimiter('refresh', {
  windowMs: 15 * 60 * 1000,
  limit: REFRESH_LIMIT,
  message: { message: 'Muitas renovações de sessão. Aguarde alguns minutos.' },
});

// Recuperação de senha: cada requisição válida dispara um email real, então o custo
// aqui não é só CPU — é cota do Gmail e incômodo pra um terceiro que nem pediu nada.
//
// ⚠️ D-07 -> NUNCA `skipSuccessfulRequests` aqui. O endpoint responde 200 por design
// (D-03, anti-enumeração): toda requisição é "bem-sucedida" do ponto de vista do
// rate-limiter, então essa opção desarmaria o limitador por completo, em silêncio —
// não "padronize" com o loginLimiter.
export const FORGOT_PASSWORD_LIMIT = 5;

export const forgotPasswordLimiter = buildLimiter('forgot-password', {
  windowMs: 60 * 60 * 1000,
  limit: FORGOT_PASSWORD_LIMIT,
  message: { message: 'Muitos pedidos de redefinição de senha. Tente novamente mais tarde.' },
});

// Fecha a porta pra tentativa de adivinhar token (32 bytes, mas defesa em
// profundidade) e limita o gasto de bcrypt.hash por IP.
export const RESET_PASSWORD_LIMIT = 10;

export const resetPasswordLimiter = buildLimiter('reset-password', {
  windowMs: 60 * 60 * 1000,
  limit: RESET_PASSWORD_LIMIT,
  message: { message: 'Muitas tentativas de redefinição de senha. Tente novamente mais tarde.' },
});
