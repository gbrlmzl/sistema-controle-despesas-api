import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/AppError.js';
import type { AuthUser } from '../auth/auth.service.js';
import { countUnread, listNotifications, markAllAsRead, markAsRead } from './notifications.service.js';

function currentUser(req: Request): AuthUser {
  return req.user as AuthUser;
}

//page/limit são opcionais: quando ausentes, o service usa a página 1 e o tamanho
//padrão (RN-040).
function parsePaginationQuery(req: Request): { page?: number; limit?: number } {
  const { page, limit } = req.query;
  const result: { page?: number; limit?: number } = {};

  if (page !== undefined) {
    const parsedPage = Number(page);
    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      throw new AppError(400, 'Página inválida.');
    }
    result.page = parsedPage;
  }

  if (limit !== undefined) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new AppError(400, 'Limite inválido.');
    }
    result.limit = parsedLimit;
  }

  return result;
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const [result, unread] = await Promise.all([
      listNotifications(user.id, parsePaginationQuery(req)),
      countUnread(user.id),
    ]);

    res.status(200).json({ ...result, unread });
  } catch (err) {
    next(err);
  }
}

export async function markRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const { all, ids } = req.body as { all?: boolean; ids?: number[] };

    if (all === true) {
      await markAllAsRead(user.id);
    } else {
      await markAsRead(user.id, ids ?? []);
    }

    const unread = await countUnread(user.id);
    res.status(200).json({ unread });
  } catch (err) {
    next(err);
  }
}
