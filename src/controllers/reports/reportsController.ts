import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '../../services/auth/authService.js';
import { AppError } from '../../utils/AppError.js';
import { getResidenceReport, type ReportTab } from '../../services/reports/reportsService.js';
import type { Competency } from '../../services/expenses/expensesService.js';

function currentUser(req: Request): AuthUser {
  return req.user as AuthUser;
}

function codeParam(req: Request): string {
  const value = req.params.code;
  if (typeof value !== 'string') {
    throw new AppError(400, 'Código inválido.');
  }
  return value;
}

//O mês/ano é opcional: quando ausente, o service assume a competência aberta (RN-020).
function parseCompetencyQuery(req: Request): Competency | null {
  const { month, year } = req.query;
  if (month === undefined && year === undefined) {
    return null;
  }

  const parsedMonth = Number(month);
  const parsedYear = Number(year);

  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12 || !Number.isInteger(parsedYear)) {
    throw new AppError(400, 'Informe mês e ano válidos.');
  }

  return { month: parsedMonth, year: parsedYear };
}

//CA-1 da US-024: a tela abre na aba da residência quando nada é informado.
function parseTabQuery(req: Request): ReportTab {
  return req.query.tab === 'personal' ? 'personal' : 'residence';
}

export async function getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const report = await getResidenceReport(codeParam(req), user.id, parseCompetencyQuery(req), parseTabQuery(req));
    res.status(200).json(report);
  } catch (err) {
    next(err);
  }
}
