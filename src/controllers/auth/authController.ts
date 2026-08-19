import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { clearSessionCookies, establishSession, setAccessTokenCookie, setRefreshTokenCookie } from '../../lib/session.js';
import { sendEmail } from '../../lib/mailer.js';
import { REFRESH_COOKIE_NAME } from '../../middlewares/auth.js';
import { AppError } from '../../utils/AppError.js';
import { logError } from '../../utils/logger.js';
import {
  loginWithCredentials,
  registerUser,
  revokeRefreshToken,
  rotateRefreshToken,
  signToken,
  type AuthUser,
} from '../../services/auth/authService.js';
import {
  PASSWORD_RESET_REQUESTED_MESSAGE,
  requestPasswordReset,
  resetPassword as resetPasswordService,
  verifyPasswordResetToken,
} from '../../services/auth/passwordResetService.js';

// SEC-10 -> O IP só existe no `req`. Em vez de empurrar o objeto inteiro pra dentro da
// camada de serviço (que não deve saber o que é Express), o controller extrai só o que
// o log precisa e passa como valor.
function securityContext(req: Request) {
  return { ip: req.ip };
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
    const { username, password } = req.body as { username: string; password: string };
    const user = await loginWithCredentials(username, password, securityContext(req));
    await establishSession(res, user);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

// Troca um refresh token válido (cookie) por um novo par de tokens. Ver
// auth.service.ts#rotateRefreshToken pra rotação + detecção de reuso.
export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof token !== 'string') {
      throw new AppError(401, 'Sessão inválida. Faça login novamente.');
    }

    const { user, refreshToken } = await rotateRefreshToken(token, securityContext(req));
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

// D-03/D-04 -> Responde 200 com a mesma mensagem em TODOS os caminhos: email
// existente, email inexistente, conta só-Google, e até uma falha inesperada do
// service (banco fora, por exemplo). Um 500 seletivo aqui seria mais um canal de
// enumeração — a única coisa que pode variar é o que sai no log, nunca a resposta.
export async function forgotPassword(req: Request, res: Response): Promise<void> {
  try {
    await requestPasswordReset(req.body.email as string, { sendEmail }, securityContext(req));
  } catch (err) {
    logError(err, 'POST /auth/forgot-password');
  }

  res.status(200).json({ message: PASSWORD_RESET_REQUESTED_MESSAGE });
}

export async function verifyResetPasswordToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await verifyPasswordResetToken(req.body.token as string);
    res.status(200).json({ valid: true });
  } catch (err) {
    next(err);
  }
}

// D-06 -> Sem cookie nenhum na resposta: derruba as sessões (dentro do service) e
// manda o usuário pra tela de login, em vez de reautenticar automaticamente.
export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, newPassword } = req.body as { token: string; newPassword: string };
    await resetPasswordService(token, newPassword, securityContext(req));
    res.status(200).json({ message: 'Senha redefinida com sucesso.' });
  } catch (err) {
    next(err);
  }
}

// Chamado depois que passport.authenticate('google', { session: false }) já
// rodou o verify callback (findOrCreateGoogleUser) e populou req.user. O navegador
// chegou aqui por navegação direta (redirect OAuth), não por fetch — por isso a
// resposta também precisa ser um redirect de volta pro front, não JSON.
export async function googleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user as AuthUser;
    await establishSession(res, user);
    res.redirect(env.FRONTEND_URL);
  } catch (err) {
    next(err);
  }
}
