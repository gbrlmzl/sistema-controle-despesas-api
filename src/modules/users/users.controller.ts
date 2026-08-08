import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '../auth/auth.service.js';
import { changeUserPassword, updateAvatar as updateAvatarService } from './users.service.js';

function currentUser(req: Request): AuthUser {
  return req.user as AuthUser;
}

export async function updateAvatar(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const updated = await updateAvatarService(user.id, req.body.avatar);
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
    res.status(200).json({ user: updated });
  } catch (err) {
    next(err);
  }
}
