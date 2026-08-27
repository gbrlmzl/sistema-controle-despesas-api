import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '../../services/auth/authService.js';
import { AppError } from '../../utils/AppError.js';
import { parsePeriodParam } from '../../utils/period.js';
import {
  getClosureSettlements,
  createReceiptIntent,
  completeReceipt,
  confirmReceived,
  getReceiptDownloadUrl,
  waiveSettlement,
} from '../../services/payments/settlementsService.js';

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

function settlementIdParam(req: Request): string {
  const value = req.params.settlementId;
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(400, 'Identificador do acerto inválido.');
  }
  return value;
}

function receiptIdParam(req: Request): string {
  const value = req.params.receiptId;
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(400, 'Identificador do comprovante inválido.');
  }
  return value;
}

export async function listSettlements(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await getClosureSettlements(codeParam(req), user.id, parsePeriodParam(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createIntent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await createReceiptIntent(codeParam(req), user.id, parsePeriodParam(req), settlementIdParam(req), req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function completeUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await completeReceipt(
      codeParam(req),
      user.id,
      parsePeriodParam(req),
      settlementIdParam(req),
      receiptIdParam(req),
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function confirmReceivedHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await confirmReceived(codeParam(req), user.id, parsePeriodParam(req), settlementIdParam(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function waive(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await waiveSettlement(
      codeParam(req),
      user.id,
      parsePeriodParam(req),
      settlementIdParam(req),
      req.body.reason,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function downloadUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await getReceiptDownloadUrl(codeParam(req), user.id, parsePeriodParam(req), receiptIdParam(req));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
