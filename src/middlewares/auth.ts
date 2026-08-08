import type { NextFunction, Request, Response } from 'express';
import { getUserById, verifyToken } from '../services/auth/authService.js';
import { AppError } from '../utils/AppError.js';

export const AUTH_COOKIE_NAME = 'JWT';
// Cookie do refresh token — escopado a /auth via `path` (ver auth.controller.ts),
// então só é enviado nas próprias rotas de auth, nunca no resto da API.
export const REFRESH_COOKIE_NAME = 'refreshToken';

function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
  if (typeof cookieToken === 'string') {
    return cookieToken;
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }

  return null;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      throw new AppError(401, 'Não autenticado.');
    }

    const payload = verifyToken(token);
    const user = await getUserById(payload.sub);
    if (!user) {
      throw new AppError(401, 'Não autenticado.');
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
