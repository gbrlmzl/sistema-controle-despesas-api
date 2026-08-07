import type { NextFunction, Request, Response } from 'express';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ message: `Rota não encontrada: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  console.error(err);

  const message = err instanceof Error ? err.message : 'Erro interno do servidor.';

  res.status(500).json({ message });
}
