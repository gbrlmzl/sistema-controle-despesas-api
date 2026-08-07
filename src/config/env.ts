import 'dotenv/config';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET deve ter no mínimo 32 caracteres'),
    // Access token de vida curta (stateless) — se vazar, expira sozinho rápido.
    JWT_EXPIRES_IN: z.string().default('15m'),
    // Refresh token de vida mais longa, mas rotativo e revogável (guardado com
    // hash na tabela RefreshToken) — é o que sustenta a sessão de verdade.
    REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),

    // Login com Google é opcional: só exigido se as 3 variáveis abaixo forem
    // fornecidas juntas (ver .refine abaixo). Sem elas, a API funciona normalmente
    // só com login/registro por credenciais.
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z.url().optional(),
    // Assina o cookie de "state" usado só durante o handshake do OAuth do Google
    // (proteção CSRF do passport-oauth2) — não guarda sessão de usuário nenhuma.
    COOKIE_SESSION_SECRET: z.string().min(32).optional(),
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
