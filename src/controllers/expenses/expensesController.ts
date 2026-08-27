import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '../../services/auth/authService.js';
import { AppError } from '../../utils/AppError.js';
import { parsePeriodParam } from '../../utils/period.js';
import {
  closeMonth,
  createExpense,
  deleteExpense,
  editExpense,
  getResidenceCompetencies,
  getResidenceExpenses,
  getUserRecurringExpenses,
  reopenMonth,
  stopExpenseRecurrence,
  type Competency,
} from '../../services/expenses/expensesService.js';

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

function expenseIdParam(req: Request): string {
  const value = req.params.expenseId;
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(400, 'Identificador da despesa inválido.');
  }
  return value;
}

//O mês/ano é opcional: quando ausente, o próprio service assume a competência
//aberta da residência (RN-020).
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

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await getResidenceExpenses(codeParam(req), user.id, parseCompetencyQuery(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const expense = await createExpense(codeParam(req), user.id, req.body);
    res.status(201).json({ expense });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const expense = await editExpense(codeParam(req), user.id, expenseIdParam(req), req.body);
    res.status(200).json({ expense });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    await deleteExpense(codeParam(req), user.id, expenseIdParam(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function stopRecurrence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    await stopExpenseRecurrence(codeParam(req), user.id, expenseIdParam(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function listRecurring(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await getUserRecurringExpenses(codeParam(req), user.id, parseCompetencyQuery(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listCompetencies(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await getResidenceCompetencies(codeParam(req), user.id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function closeMonthHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await closeMonth(codeParam(req), user.id, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function reopenMonthHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    await reopenMonth(codeParam(req), user.id, parsePeriodParam(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
