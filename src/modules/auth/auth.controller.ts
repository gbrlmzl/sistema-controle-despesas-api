import type { NextFunction, Request, Response } from 'express';
import ms from 'ms';
import { env } from '../../config/env.js';
import { AUTH_COOKIE_NAME, REFRESH_COOKIE_NAME } from '../../middlewares/auth.js';
import { AppError } from '../../utils/AppError.js';
import {
  issueRefreshToken,
  loginWithCredentials,
  registerUser,
  revokeRefreshToken,
  rotateRefreshToken,
  signToken,
  type AuthUser,
} from './auth.service.js';

const REFRESH_COOKIE_PATH = '/auth';

function setAccessTokenCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ms(env.JWT_EXPIRES_IN as ms.StringValue),
  });
}

function setRefreshTokenCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    // 'strict' (não 'lax'): o refresh token só sai em requisições same-site de
    // verdade — é o cookie de maior valor da API, não precisa sobreviver
    // navegação cross-site vinda de outro domínio.
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: ms(env.REFRESH_TOKEN_EXPIRES_IN as ms.StringValue),
  });
}

function clearSessionCookies(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME);
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
}

// Emite o par access+refresh token pro usuário autenticado e seta os dois
// cookies. Usado por register, login e o callback do Google — sempre o mesmo
// desfecho depois que a identidade já foi confirmada de alguma forma.
async function establishSession(res: Response, user: AuthUser): Promise<void> {
  const accessToken = signToken(user);
  const refreshToken = await issueRefreshToken(user.id);

  setAccessTokenCookie(res, accessToken);
  setRefreshTokenCookie(res, refreshToken.raw);
}

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await registerUser(req.body);
    await establishSession(res, user);
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = req.body as { email: string; password: string };
    const user = await loginWithCredentials(email, password);
    await establishSession(res, user);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

// Troca um refresh token válido (cookie, escopado a /auth) por um novo par de
// tokens. Ver auth.service.ts#rotateRefreshToken pra rotação + detecção de reuso.
export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof token !== 'string') {
      throw new AppError(401, 'Sessão inválida. Faça login novamente.');
    }

    const { user, refreshToken } = await rotateRefreshToken(token);
    const accessToken = signToken(user);

    setAccessTokenCookie(res, accessToken);
    setRefreshTokenCookie(res, refreshToken.raw);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof token === 'string') {
      await revokeRefreshToken(token);
    }

    clearSessionCookies(res);
    res.status(200).json({ message: 'Logout efetuado com sucesso.' });
  } catch (err) {
    next(err);
  }
}

// Chamado depois que passport.authenticate('google', { session: false }) já
// rodou o verify callback (findOrCreateGoogleUser) e populou req.user.
export async function googleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user as AuthUser;
    await establishSession(res, user);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}
