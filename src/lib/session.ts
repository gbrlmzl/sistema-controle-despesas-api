import type { Response } from 'express';
import ms from 'ms';
import { env } from '../config/env.js';
import { AUTH_COOKIE_NAME, REFRESH_COOKIE_NAME } from '../middlewares/auth.js';
import { issueRefreshToken, signToken, type AuthUser } from '../services/auth/authService.js';

// Os cookies de sessão nascem em mais de um controller: register/login/googleCallback
// (auth) e, desde o SEC-06, a troca de senha (users). Manter isso privado no
// authController obrigaria um controller a importar o outro — o que inverteria a
// direção normal das dependências. Como é mecânica de transporte (cookie + emissão do
// par de tokens) e não regra de negócio, o lugar dela é um módulo compartilhado.

// '/', não '/auth': o front-end (Next.js) chama esse endpoint via um rewrite
// same-origin ('/api/auth/refresh', ver next.config.ts), então o navegador só
// enxerga o path '/api/...' — nunca '/auth/...' de verdade — e um cookie
// restrito a '/auth' nunca seria anexado a essa chamada. O middleware de rota
// do front (src/proxy.ts) também precisa lê-lo em requisições de página
// ('/dashboard/*', '/login' etc.), que tampouco começam com '/auth'. HttpOnly
// já impede leitura via JS; Path aqui não adiciona proteção real, só quebrava
// o próprio mecanismo de refresh.
const REFRESH_COOKIE_PATH = '/';

export function setAccessTokenCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ms(env.JWT_EXPIRES_IN as ms.StringValue),
  });
}

export function setRefreshTokenCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    // 'lax', não 'strict': googleCallback também emite esse cookie, e o
    // navegador chega lá por um redirect de topo iniciado num site diferente
    // (accounts.google.com) — um Set-Cookie 'strict' nesse contexto é
    // descartado silenciosamente (confirmado: o JWT, que já é 'lax', sobrevive
    // ao mesmo redirect; só o refresh token com 'strict' sumia). 'lax' ainda
    // protege contra CSRF de verdade (POST/fetch/XHR cross-site continuam sem
    // enviar o cookie); só permite navegação de topo por GET, que é
    // exatamente o que esse redirect é.
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: ms(env.REFRESH_TOKEN_EXPIRES_IN as ms.StringValue),
  });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME);
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

// Emite o par access+refresh token pro usuário autenticado e seta os dois
// cookies. Usado por register, login e o callback do Google — sempre o mesmo
// desfecho depois que a identidade já foi confirmada de alguma forma — e também
// pela troca de senha, que revoga tudo e reabre a sessão do dispositivo atual.
export async function establishSession(res: Response, user: AuthUser): Promise<void> {
  const accessToken = signToken(user);
  const refreshToken = await issueRefreshToken(user.id);

  setAccessTokenCookie(res, accessToken);
  setRefreshTokenCookie(res, refreshToken.raw);
}
