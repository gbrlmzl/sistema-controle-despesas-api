import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../utils/AppError.js';

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const firstIssue = result.error.issues[0];
      next(new AppError(400, firstIssue?.message ?? 'Dados inválidos.'));
      return;
    }

    req.body = result.data;
    next();
  };
}
