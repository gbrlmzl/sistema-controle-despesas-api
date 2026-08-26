import 'dotenv/config';
import { z } from 'zod';

// Uma variável presente no .env mas deixada em branco (ex.: `GOOGLE_CLIENT_ID=`) chega
// aqui como string vazia, não como `undefined` — sem isso, o .refine() abaixo trataria
// "todas em branco" como "todas preenchidas".
function optionalString<T extends z.ZodType<string>>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
    // Origem do front-end: usada pro CORS (Access-Control-Allow-Origin não pode ser "*"
    // quando credentials:true) e pro redirect final do callback do Google OAuth.
    FRONTEND_URL: z.url().default('http://localhost:3000'),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET deve ter no mínimo 32 caracteres'),
    // Access token de vida curta (stateless) — se vazar, expira sozinho rápido.
    JWT_EXPIRES_IN: z.string().default('15m'),
    // Refresh token de vida mais longa, mas rotativo e revogável (guardado com
    // hash na tabela RefreshToken) — é o que sustenta a sessão de verdade.
    REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),

    // Login com Google é opcional: só exigido se as 3 variáveis abaixo forem
    // fornecidas juntas (ver .refine abaixo). Sem elas, a API funciona normalmente
    // só com login/registro por credenciais.
    GOOGLE_CLIENT_ID: optionalString(z.string()),
    GOOGLE_CLIENT_SECRET: optionalString(z.string()),
    GOOGLE_CALLBACK_URL: optionalString(z.url()),
    // Assina o cookie de "state" usado só durante o handshake do OAuth do Google
    // (proteção CSRF do passport-oauth2) — não guarda sessão de usuário nenhuma.
    COOKIE_SESSION_SECRET: optionalString(z.string().min(32)),

    // Desarma os rate limiters (SEC-01) para a suíte e2e do front, que precisa de ~19
    // cadastros por execução contra um teto de 10/hora por IP — sem isso, a suíte testa
    // o limitador em vez das telas. Só tem efeito em development: ver rateLimitDisabled
    // no fim deste arquivo.
    RATE_LIMIT_DISABLED: z.preprocess((v) => (v === '' ? undefined : v), z.stringbool().default(false)),

    // Recuperação de senha por email (ver docs/plano-recuperacao-de-senha.md).
    PASSWORD_RESET_TOKEN_EXPIRES_IN: z.string().default('30m'),
    // Caminho da tela de redefinição no front-end (o link = FRONTEND_URL + este caminho + ?token=)
    PASSWORD_RESET_PATH: z.string().startsWith('/').default('/change-password'),

    // SMTP também é um grupo opcional "tudo ou nada", no mesmo mecanismo do Google
    // acima. Sem as 5 variáveis, a API sobe normalmente e o "envio" só loga (ver
    // mailEnabled/src/lib/mailer.ts) — é o que mantém o CI verde sem segredo nenhum.
    SMTP_HOST: optionalString(z.string()),
    SMTP_USER: optionalString(z.email()),
    MAIL_FROM: optionalString(z.string()),
    SMTP_PASSWORD: optionalString(z.string()),
    // z.coerce.number() transforma '' em 0 — o mesmo preprocess do optionalString
    // acima intercepta a string vazia antes da coação, mas aqui não dá pra reusar o
    // helper (ele exige saída string; a saída aqui é number).
    SMTP_PORT: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  })
  .refine(
    (data) =>
      [data.GOOGLE_CLIENT_ID, data.GOOGLE_CLIENT_SECRET, data.GOOGLE_CALLBACK_URL, data.COOKIE_SESSION_SECRET].every(
        (v) => v !== undefined,
      ) ||
      [data.GOOGLE_CLIENT_ID, data.GOOGLE_CLIENT_SECRET, data.GOOGLE_CALLBACK_URL, data.COOKIE_SESSION_SECRET].every(
        (v) => v === undefined,
      ),
    {
      message:
        'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL e COOKIE_SESSION_SECRET devem ser todos fornecidos juntos, ou nenhum deles.',
      path: ['GOOGLE_CLIENT_ID'],
    },
  )
  .refine(
    (data) =>
      [data.SMTP_HOST, data.SMTP_USER, data.MAIL_FROM, data.SMTP_PASSWORD, data.SMTP_PORT].every(
        (v) => v !== undefined,
      ) ||
      [data.SMTP_HOST, data.SMTP_USER, data.MAIL_FROM, data.SMTP_PASSWORD, data.SMTP_PORT].every(
        (v) => v === undefined,
      ),
    {
      message: 'SMTP_HOST, SMTP_USER, SMTP_PORT, SMTP_PASSWORD e MAIL_FROM devem ser todos fornecidos juntos, ou nenhum deles.',
      path: ['SMTP_HOST'],
    },
  );

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:', z.treeifyError(parsed.error));
  throw new Error('Falha ao validar variáveis de ambiente.');
}

export const env = parsed.data;

export const googleAuthEnabled =
  env.GOOGLE_CLIENT_ID !== undefined &&
  env.GOOGLE_CLIENT_SECRET !== undefined &&
  env.GOOGLE_CALLBACK_URL !== undefined &&
  env.COOKIE_SESSION_SECRET !== undefined;

// Um interruptor de proteção de segurança nunca deve depender só de alguém não ter
// copiado a variável errada pro servidor: `RATE_LIMIT_DISABLED=true` em produção é
// ignorado aqui, de propósito. Em test também é ignorado, porque lá quem manda é o
// setRateLimitersArmedInTests() (ver src/middlewares/rateLimit.ts) — senão a variável
// no .env da máquina quebraria os testes que exercitam os limitadores de verdade.
export const rateLimitDisabled = env.RATE_LIMIT_DISABLED && env.NODE_ENV === 'development';

// D-08 -> Sem as 5 variáveis, a API sobe normalmente e o envio de email só é
// registrado em log (ver src/lib/mailer.ts) — nunca sai de verdade.
export const mailEnabled =
  env.SMTP_HOST !== undefined &&
  env.SMTP_USER !== undefined &&
  env.MAIL_FROM !== undefined &&
  env.SMTP_PASSWORD !== undefined &&
  env.SMTP_PORT !== undefined;
