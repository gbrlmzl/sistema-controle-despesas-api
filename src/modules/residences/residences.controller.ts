import type { NextFunction, Request, Response } from 'express';
import type { AuthUser } from '../auth/auth.service.js';
import { AppError } from '../../utils/AppError.js';
import {
  cancelInvite,
  cancelJoinRequest,
  createResidence,
  findResidenceForMember,
  inviteUser,
  leaveResidence,
  listReceivedInvites,
  listPendingJoinRequests,
  listResidencesForUser,
  listSentInvites,
  listSentJoinRequests,
  regenerateResidenceCode,
  removeMember,
  requestToJoinResidence,
  respondToInvite,
  respondToJoinRequest,
  transferOwnership,
  updateResidence,
} from './residences.service.js';

function currentUser(req: Request): AuthUser {
  return req.user as AuthUser;
}

export async function listResidences(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);

    //Além das residências (RN-007), a tela também mostra as pendências de acesso do
    //usuário: convites que ele recebeu (US-008) e solicitações que ele enviou (US-022).
    const [residences, receivedInvites, sentJoinRequests] = await Promise.all([
      listResidencesForUser(user.id),
      listReceivedInvites(user.id),
      listSentJoinRequests(user.id),
    ]);

    res.status(200).json({ residences, receivedInvites, sentJoinRequests });
  } catch (err) {
    next(err);
  }
}

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const residence = await createResidence(user.id, req.body);
    res.status(201).json({ residence });
  } catch (err) {
    next(err);
  }
}

export async function createJoinRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await requestToJoinResidence(user.id, user.name, req.body.code);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

function parseId(req: Request, param: string): number {
  const value = Number(req.params[param]);
  if (!Number.isInteger(value)) {
    throw new AppError(400, 'Identificador inválido.');
  }
  return value;
}

function codeParam(req: Request): string {
  const value = req.params.code;
  if (typeof value !== 'string') {
    throw new AppError(400, 'Código inválido.');
  }
  return value;
}

export async function removeJoinRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await cancelJoinRequest(user.id, parseId(req, 'id'));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function respondInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const accept = req.body.status === 'accepted';
    const result = await respondToInvite(user.id, parseId(req, 'id'), accept);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function respondJoinRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const accept = req.body.status === 'accepted';
    const result = await respondToJoinRequest(user.id, parseId(req, 'id'), accept);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function removeInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await cancelInvite(user.id, parseId(req, 'id'));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getResidence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const residence = await findResidenceForMember(codeParam(req), user.id);
    if (!residence) {
      throw new AppError(404, 'Residência não encontrada');
    }

    //A mesma tela também mostra as pendências que só o owner administra (US-009,
    //US-022 CA-1): convites enviados e solicitações recebidas.
    const [sentInvites, pendingJoinRequests] = residence.isOwner
      ? await Promise.all([listSentInvites(residence.id), listPendingJoinRequests(residence.id)])
      : [[], []];

    res.status(200).json({ residence, sentInvites, pendingJoinRequests });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const residence = await updateResidence(codeParam(req), user.id, req.body);
    res.status(200).json({ residence });
  } catch (err) {
    next(err);
  }
}

export async function regenerateCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await regenerateResidenceCode(codeParam(req), user.id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function leave(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    await leaveResidence(codeParam(req), user.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function removeMemberHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    await removeMember(codeParam(req), user.id, parseId(req, 'userId'));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function transferOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    await transferOwnership(codeParam(req), user.id, req.body.userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function invite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    const result = await inviteUser(codeParam(req), user.id, req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}
