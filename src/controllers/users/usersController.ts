import type { NextFunction, Request, Response } from 'express';
import { establishSession } from '../../lib/session.js';
import { revokeAllUserTokens, type AuthUser } from '../../services/auth/authService.js';
import {
  changeUserPassword,
  updateProfile as updateProfileService,
  userHasPassword,
} from '../../services/users/usersService.js';

function currentUser(req: Request): AuthUser {
  return req.user as AuthUser;
}

export async function getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const hasPassword = await userHasPassword(user.id);
    res.status(200).json({ user: { ...user, hasPassword } });
  } catch (err) {
    next(err);
  }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const { name, avatar } = req.body as { name?: string; avatar?: string };
    const updated = await updateProfileService(user.id, { name, avatar });
    res.status(200).json({ user: updated });
  } catch (err) {
    next(err);
  }
}

export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    const updated = await changeUserPassword(user.id, currentPassword, newPassword);

    // SEC-06 -> Trocar a senha é o gesto universal de "expulsar o invasor". Sem isto,
    // um refresh token roubado continuava rotacionando por até 7 dias e a ação que o
    // usuário acredita ter resolvido o problema não resolvia nada.
    //
    // A ordem importa: revogar tudo primeiro, emitir depois. Invertido, o par novo
    // nasceria e seria revogado na mesma requisição — o próprio usuário cairia.
    await revokeAllUserTokens(user.id);
    await establishSession(res, updated);

    res.status(200).json({ user: updated });
  } catch (err) {
    next(err);
  }
}
