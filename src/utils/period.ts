import type { Request } from 'express';
import { AppError } from './AppError.js';
import type { Competency } from '../services/expenses/expensesService.js';

// :period identifica uma competência na URL, no formato AAAA-MM. Usado pelas rotas
// de fechamento de mês (expensesRoutes) e pelas de acerto (settlementsRoutes) --
// extraído para cá pra não duplicar o parser entre os dois controllers.
export function parsePeriodParam(req: Request): Competency {
  const raw = req.params.period;
  const match = /^(\d{4})-(\d{2})$/.exec(typeof raw === 'string' ? raw : '');

  if (!match) {
    throw new AppError(400, 'Período inválido. Use o formato AAAA-MM.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  if (month < 1 || month > 12) {
    throw new AppError(400, 'Período inválido. Use o formato AAAA-MM.');
  }

  return { month, year };
}
