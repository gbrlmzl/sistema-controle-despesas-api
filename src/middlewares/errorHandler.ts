import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { logError } from '../utils/logger.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ message: `Rota não encontrada: ${req.method} ${req.originalUrl}` });
}

// Erros do body-parser (JSON malformado, corpo acima do limite do SEC-11) não são
// AppError, mas também não são falha interna: são erro do cliente, e chegam aqui já
// com um `type` que identifica o caso. Sem este ramo eles cairiam no 500 genérico
// abaixo — respondendo o status errado e, antes do SEC-04, vazando o texto cru do
// parser ("Unexpected token } in JSON at position 42").
const CLIENT_BODY_FAILURES: Record<string, { statusCode: number; message: string }> = {
  'entity.too.large': { statusCode: 413, message: 'Corpo da requisição excede o tamanho máximo permitido.' },
  'entity.parse.failed': { statusCode: 400, message: 'Corpo da requisição não é um JSON válido.' },
};

function clientBodyFailure(err: unknown) {
  const type = (err as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? CLIENT_BODY_FAILURES[type] : undefined;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message });
    return;
  }

  const bodyFailure = clientBodyFailure(err);
  if (bodyFailure) {
    res.status(bodyFailure.statusCode).json({ message: bodyFailure.message });
    return;
  }

  logError(err, `${req.method} ${req.originalUrl}`);

  // SEC-04 -> Em produção o cliente nunca vê a mensagem interna. Um erro do Prisma
  // entrega nome de tabela, coluna e constraint; um erro de conexão entrega host e
  // porta do banco. O detalhe fica só no log (CloudWatch), onde é útil sem ser
  // reconhecimento gratuito pra quem estiver sondando a API.
  const message =
    env.NODE_ENV === 'production'
      ? 'Erro interno do servidor.'
      : err instanceof Error
        ? err.message
        : 'Erro interno do servidor.';

  res.status(500).json({ message });
}
