import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError.js';
import { logError } from '../utils/logger.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ message: `Rota não encontrada: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }

  logError(err, `${req.method} ${req.originalUrl}`);

  const message = err instanceof Error ? err.message : 'Erro interno do servidor.';

  res.status(500).json({ message });
}
