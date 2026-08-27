// Service dos acertos (Settlement) — mesmo formato de expensesService.ts: carrega
// contexto (loadUserResidenceContext, RN-010/080), valida a regra, age. Toda função
// pública começa carregando o contexto da residência, que é o que garante o 404 de
// não-membro sem escrever autorização nova em cada rota.

import { randomUUID } from 'node:crypto';
import prisma from '../../config/prisma.js';
import { env, storageEnabled } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { logSecurityEvent } from '../../utils/logger.js';
import { storage } from '../../lib/storage.js';
import { loadUserResidenceContext } from '../residences/residencesService.js';
import { createNotification, createNotifications } from '../notifications/notificationsService.js';
import type { Competency } from '../expenses/expensesService.js';

//D-27 -> extensão do objeto vem SEMPRE do Content-Type declarado, nunca do
//originalName (que é só metadado de exibição, e nunca confiável).
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

// --- Estado derivado (D-22/D-30) -> um único lugar, usado por toda função abaixo e
// por getCompetencySettlementSummary (Fase 6). Nunca reimplementar esta conta em
// outro arquivo. ---

interface SettlementStamps {
  paidAt: Date | null;
  confirmedAt: Date | null;
  waivedAt: Date | null;
}

//D-30 -> uma linha (par) está liquidada quando os DOIS carimbos existem, ou quando
//foi dispensada. Um só carimbo não basta -- não há ordem entre eles (RN-076).
export function isPairSettled(s: SettlementStamps): boolean {
  return s.waivedAt !== null || (s.paidAt !== null && s.confirmedAt !== null);
}

export type ClosureStatus = 'AWAITING_PAYMENT' | 'AWAITING_CONFIRMATION' | 'SETTLED';

export function closureStatus(settlements: SettlementStamps[]): ClosureStatus {
  if (settlements.every(isPairSettled)) return 'SETTLED'; //inclui a lista vazia (D-09/RN-073)
  //RN-071: falta ALGUM devedor anexar, em qualquer par -- não importa se o credor
  //daquele par já confirmou.
  if (settlements.some((s) => s.waivedAt === null && s.paidAt === null)) return 'AWAITING_PAYMENT';
  return 'AWAITING_CONFIRMATION';
}

export type SettlementLineStatus = 'PENDING' | 'AWAITING_CONFIRMATION' | 'SETTLED' | 'WAIVED';

//Status de UMA linha (não do fechamento inteiro). Não existe status onde só
//confirmedAt exista sem paidAt: o credor pode confirmar primeiro (RN-076), mas a
//leitura desse instante ainda é PENDING até o devedor anexar.
export function settlementLineStatus(s: SettlementStamps): SettlementLineStatus {
  if (s.waivedAt !== null) return 'WAIVED';
  if (s.paidAt !== null && s.confirmedAt !== null) return 'SETTLED';
  if (s.paidAt !== null) return 'AWAITING_CONFIRMATION';
  return 'PENDING';
}

function isReceiverReady(settlements: Array<SettlementStamps & { receiverId: number }>, receiverId: number): boolean {
  const mine = settlements.filter((s) => s.receiverId === receiverId);
  return mine.length > 0 && mine.every((s) => s.paidAt !== null || s.waivedAt !== null);
}

// --- Assinatura de arquivo (D-23/RN-081), tabela em 02-pesquisa-amazon-s3-boas-praticas.md §6 ---

function matchesSignature(contentType: string, bytes: Buffer): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return (
        bytes.length >= 8 &&
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).equals(bytes.subarray(0, 8))
      );
    case 'image/webp':
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    case 'application/pdf':
      return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    default:
      return false;
  }
}

// --- Carregamento compartilhado ---

async function loadClosure(residenceId: number, period: Competency) {
  return prisma.monthClosure.findUnique({
    where: { residenceId_year_month: { residenceId, year: period.year, month: period.month } },
    select: { id: true, month: true, year: true, closedAt: true, settledAt: true, closedBy: { select: { name: true } } },
  });
}

async function loadSettlement(closureId: number, settlementId: string) {
  return prisma.settlement.findFirst({ where: { id: settlementId, closureId } });
}

function settlementLink(code: string, competency: Competency): string {
  return `/app/residences/${code}/settlements?mes=${competency.month}&ano=${competency.year}`;
}

// D-32/RN-084 (SETTLEMENT_READY) e RN-073 (MONTH_SETTLED) nascem da MESMA
// comparação: estado antes x depois da escrita que cada ação faz. "Passou agora" é
// o ponto -- publicar pelo estado atual notificaria de novo a cada comprovante
// extra (D-11) ou a cada linha já resolvida. touchedReceiverId é null quando a
// escrita não pode ter mudado a prontidão de ninguém (confirmReceived só grava
// confirmedAt, que não entra em isReceiverReady).
async function applyTransitionSideEffects(params: {
  closureId: number;
  code: string;
  residenceId: number;
  competency: Competency;
  beforeSettlements: Array<SettlementStamps & { receiverId: number }>;
  touchedReceiverId: number | null;
}): Promise<ClosureStatus> {
  const afterSettlements = await prisma.settlement.findMany({ where: { closureId: params.closureId } });

  if (params.touchedReceiverId !== null) {
    const wasReady = isReceiverReady(params.beforeSettlements, params.touchedReceiverId);
    const isReady = isReceiverReady(afterSettlements, params.touchedReceiverId);
    if (!wasReady && isReady) {
      await createNotification({
        userId: params.touchedReceiverId,
        type: 'SETTLEMENT_READY',
        title: 'Confirme o recebimento',
        message: `Todos os pagadores que te devem na competência de ${params.competency.month}/${params.competency.year} já anexaram comprovante. Confirme o recebimento.`,
        linkTo: settlementLink(params.code, params.competency),
      });
    }
  }

  const statusBefore = closureStatus(params.beforeSettlements);
  const statusAfter = closureStatus(afterSettlements);

  if (statusBefore !== 'SETTLED' && statusAfter === 'SETTLED') {
    await prisma.monthClosure.update({ where: { id: params.closureId }, data: { settledAt: new Date() } });

    const members = await prisma.membership.findMany({
      where: { residenceId: params.residenceId },
      select: { userId: true },
    });

    await createNotifications(
      members.map((member) => ({
        userId: member.userId,
        type: 'MONTH_SETTLED' as const,
        title: 'Competência quitada',
        message: `A competência de ${params.competency.month}/${params.competency.year} está totalmente quitada.`,
        linkTo: settlementLink(params.code, params.competency),
      })),
    );
  }

  return statusAfter;
}

// --- 6.1 GET .../settlements ---

export async function getClosureSettlements(code: string, userId: number, period: Competency) {
  const context = await loadUserResidenceContext(code, userId); //RN-080

  const closure = await loadClosure(context.residence.id, period);
  if (!closure) {
    throw new AppError(404, 'Não há fechamento para esta competência.');
  }

  const settlements = await prisma.settlement.findMany({
    where: { closureId: closure.id },
    orderBy: { createdAt: 'asc' },
    include: {
      payer: { select: { id: true, name: true } },
      receiver: { select: { id: true, name: true } },
      //RN-079/D-11 -> só o que já é prova de verdade aparece na lista.
      receipts: {
        where: { status: 'STORED' },
        orderBy: { storedAt: 'asc' },
        select: {
          id: true,
          contentType: true,
          sizeInBytes: true,
          originalName: true,
          storedAt: true,
          uploadedBy: { select: { name: true } },
        },
      },
    },
  });

  return {
    competency: { month: closure.month, year: closure.year },
    closedAt: closure.closedAt,
    closedByName: closure.closedBy.name,
    status: closureStatus(settlements),
    settledAt: closure.settledAt,
    totals: {
      //"linha" aqui é um par (D-01/D-29); uma pessoa com 2 dívidas conta em 2 linhas.
      payerSide: { lines: settlements.length, paid: settlements.filter((s) => s.paidAt !== null).length },
      receiverSide: { lines: settlements.length, confirmed: settlements.filter((s) => s.confirmedAt !== null).length },
    },
    canAct: !context.isArchived, //D-05
    canUpload: !context.isArchived && storageEnabled, //D-18
    settlements: settlements.map((s) => ({
      id: s.id,
      payer: { userId: s.payer.id, name: s.payer.name },
      receiver: { userId: s.receiver.id, name: s.receiver.name },
      amountInCents: s.amountInCents,
      isMinePaying: s.payerId === userId,
      isMineReceiving: s.receiverId === userId,
      status: settlementLineStatus(s),
      paidAt: s.paidAt,
      confirmedAt: s.confirmedAt,
      waivedAt: s.waivedAt,
      waiveReason: s.waiveReason,
      receipts: s.receipts.map((r) => ({
        id: r.id,
        contentType: r.contentType,
        sizeInBytes: r.sizeInBytes,
        originalName: r.originalName,
        uploadedAt: r.storedAt,
        uploadedByName: r.uploadedBy.name,
      })),
    })),
  };
}

// --- 6.2 POST .../receipts (abre a intenção de upload) ---

export interface ReceiptIntentInput {
  contentType: string;
  sizeInBytes: number;
  originalName?: string;
}

export async function createReceiptIntent(
  code: string,
  userId: number,
  period: Competency,
  settlementId: string,
  input: ReceiptIntentInput,
) {
  const context = await loadUserResidenceContext(code, userId);

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada e não aceita anexo de comprovante.'); //RN-078
  }

  const closure = await loadClosure(context.residence.id, period);
  if (!closure) {
    throw new AppError(409, 'Esta competência ainda não foi fechada.'); //RN-069
  }

  const settlement = await loadSettlement(closure.id, settlementId);
  if (!settlement) {
    throw new AppError(404, 'Linha de acerto não encontrada nesta competência.');
  }

  if (settlement.payerId !== userId) {
    if (settlement.receiverId === userId) {
      //RN-075 -> esse lado liquida confirmando o recebimento, não anexando nada.
      throw new AppError(409, 'Você é o credor deste par; quem anexa comprovante é o devedor.');
    }
    throw new AppError(403, 'Você não é o devedor deste par de acerto.'); //RN-074
  }

  if (settlement.waivedAt !== null) {
    throw new AppError(409, 'Esta linha já foi dispensada e não aceita mais anexo.');
  }
  //settlement.paidAt !== null NÃO é erro: reenviar comprovante antes do /complete é
  //normal, e um segundo comprovante na mesma linha vira histórico (D-11).

  const receiptId = randomUUID();
  const extension = EXTENSION_BY_CONTENT_TYPE[input.contentType]; //validado pelo schema (Fase 5)
  const monthKey = String(period.month).padStart(2, '0');
  //D-27 -> chave hierárquica e legível, com dois UUIDs no fim.
  const storageKey = `residences/${context.residence.id}/${period.year}-${monthKey}/settlements/${settlementId}/${receiptId}.${extension}`;

  //Grava PENDING antes de assinar: se a assinatura falhar (linha abaixo), o
  //registro vira órfão e a purga (Fase 7) limpa depois. O contrário -- assinar e
  //só então gravar -- deixaria um objeto possível no bucket sem registro nenhum.
  await prisma.paymentReceipt.create({
    data: {
      id: receiptId,
      settlementId,
      storageKey,
      declaredContentType: input.contentType,
      originalName: input.originalName ?? null,
      uploadedById: userId,
    },
  });

  const upload = await storage.createUploadTicket({
    key: storageKey,
    contentType: input.contentType,
    maxSizeInBytes: env.RECEIPT_MAX_SIZE_BYTES,
    expiresInSeconds: env.RECEIPT_UPLOAD_URL_EXPIRES_IN,
  });

  return { receiptId, upload, expiresInSeconds: env.RECEIPT_UPLOAD_URL_EXPIRES_IN };
}

// --- 6.3 POST .../receipts/:receiptId/complete ---

export async function completeReceipt(
  code: string,
  userId: number,
  period: Competency,
  settlementId: string,
  receiptId: string,
) {
  const context = await loadUserResidenceContext(code, userId);

  const closure = await loadClosure(context.residence.id, period);
  if (!closure) {
    throw new AppError(404, 'Comprovante não encontrado.');
  }

  const receipt = await prisma.paymentReceipt.findFirst({
    where: { id: receiptId, settlementId, uploadedById: userId, settlement: { closureId: closure.id } },
    include: { settlement: true, uploadedBy: { select: { name: true } } },
  });
  if (!receipt) {
    throw new AppError(404, 'Comprovante não encontrado.');
  }

  //Idempotência: o front pode reenviar o /complete depois de um timeout de rede, e
  //um 409 aqui viraria um erro visível sem nada de errado ter acontecido.
  if (receipt.status === 'STORED') {
    const allSettlements = await prisma.settlement.findMany({ where: { closureId: closure.id } });
    return {
      receipt: {
        id: receipt.id,
        contentType: receipt.contentType,
        sizeInBytes: receipt.sizeInBytes,
        uploadedAt: receipt.storedAt,
        uploadedByName: receipt.uploadedBy.name,
      },
      settlement: {
        id: receipt.settlement.id,
        status: settlementLineStatus(receipt.settlement),
        paidAt: receipt.settlement.paidAt,
        confirmedAt: receipt.settlement.confirmedAt,
      },
      closureStatus: closureStatus(allSettlements),
    };
  }

  const info = await storage.headObject(receipt.storageKey);
  if (!info) {
    throw new AppError(404, 'O arquivo não foi encontrado no armazenamento.');
  }

  //Em qualquer divergência abaixo: NÃO apaga o objeto no caminho quente (a purga
  //da Fase 7 faz isso depois) e o registro fica em PENDING -- apagar dentro do
  //request transformaria um erro do usuário numa operação destrutiva.
  if (info.sizeInBytes > env.RECEIPT_MAX_SIZE_BYTES) {
    logSecurityEvent('receipt_content_mismatch', {
      receiptId,
      settlementId,
      reason: 'size',
      max: env.RECEIPT_MAX_SIZE_BYTES,
      actual: info.sizeInBytes,
    });
    throw new AppError(422, 'O arquivo enviado é maior do que o permitido.');
  }

  if (info.contentType !== receipt.declaredContentType) {
    logSecurityEvent('receipt_content_mismatch', {
      receiptId,
      settlementId,
      reason: 'content-type',
      declared: receipt.declaredContentType,
      actual: info.contentType,
    });
    throw new AppError(422, 'O tipo do arquivo enviado não confere com o declarado.');
  }

  const firstBytes = await storage.readFirstBytes(receipt.storageKey, 12);
  if (!firstBytes || !matchesSignature(receipt.declaredContentType, firstBytes)) {
    logSecurityEvent('receipt_content_mismatch', { receiptId, settlementId, reason: 'magic-bytes', declared: receipt.declaredContentType });
    throw new AppError(422, 'O conteúdo do arquivo não corresponde ao tipo declarado.');
  }

  const beforeSettlements = await prisma.settlement.findMany({ where: { closureId: closure.id } });

  const { updatedReceipt, updatedSettlement } = await prisma.$transaction(async (tx) => {
    const updatedReceipt = await tx.paymentReceipt.update({
      where: { id: receipt.id },
      data: { status: 'STORED', storedAt: new Date(), contentType: info.contentType, sizeInBytes: info.sizeInBytes },
    });
    const updatedSettlement = await tx.settlement.update({
      where: { id: receipt.settlementId },
      //D-11 -> só grava paidAt se ainda não existir; um segundo comprovante na
      //mesma linha (ex.: "anexei o errado") vira histórico, sem mexer no carimbo.
      data: receipt.settlement.paidAt === null ? { paidAt: new Date() } : {},
    });
    return { updatedReceipt, updatedSettlement };
  });

  const closureStatusAfter = await applyTransitionSideEffects({
    closureId: closure.id,
    code: context.residence.code,
    residenceId: context.residence.id,
    competency: period,
    beforeSettlements,
    touchedReceiverId: updatedSettlement.receiverId,
  });

  return {
    receipt: {
      id: updatedReceipt.id,
      contentType: updatedReceipt.contentType,
      sizeInBytes: updatedReceipt.sizeInBytes,
      uploadedAt: updatedReceipt.storedAt,
      uploadedByName: receipt.uploadedBy.name,
    },
    settlement: {
      id: updatedSettlement.id,
      status: settlementLineStatus(updatedSettlement),
      paidAt: updatedSettlement.paidAt,
      confirmedAt: updatedSettlement.confirmedAt,
    },
    closureStatus: closureStatusAfter,
  };
}

// --- 6.4 POST .../confirm ("Recebi o pagamento") ---

export async function confirmReceived(code: string, userId: number, period: Competency, settlementId: string) {
  const context = await loadUserResidenceContext(code, userId);

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada e não aceita confirmação de recebimento.'); //RN-078
  }

  const closure = await loadClosure(context.residence.id, period);
  if (!closure) {
    throw new AppError(409, 'Esta competência ainda não foi fechada.'); //RN-069
  }

  const settlement = await loadSettlement(closure.id, settlementId);
  if (!settlement) {
    throw new AppError(404, 'Linha de acerto não encontrada nesta competência.');
  }

  if (settlement.receiverId !== userId) {
    if (settlement.payerId === userId) {
      //RN-074 -> esse lado liquida anexando comprovante, não confirmando.
      throw new AppError(409, 'Você é o devedor deste par; esse lado liquida anexando comprovante.');
    }
    throw new AppError(403, 'Você não é o credor deste par de acerto.'); //RN-075
  }

  if (isPairSettled(settlement)) {
    throw new AppError(409, 'Esta linha já foi liquidada ou dispensada.');
  }
  //RN-076 -> sem checagem de ordem: o devedor pode ainda não ter anexado nada.

  const beforeSettlements = await prisma.settlement.findMany({ where: { closureId: closure.id } });

  //Esta ação NUNCA toca o S3 -- funciona igual com storageEnabled === false (D-18).
  const updated = await prisma.settlement.update({
    where: { id: settlement.id },
    data: { confirmedAt: new Date() },
  });

  const closureStatusAfter = await applyTransitionSideEffects({
    closureId: closure.id,
    code: context.residence.code,
    residenceId: context.residence.id,
    competency: period,
    beforeSettlements,
    //confirmar só grava confirmedAt, que não entra em isReceiverReady -- não pode
    //ter mudado a prontidão de nenhum credor.
    touchedReceiverId: null,
  });

  return {
    settlement: {
      id: updated.id,
      status: settlementLineStatus(updated),
      paidAt: updated.paidAt,
      confirmedAt: updated.confirmedAt,
    },
    closureStatus: closureStatusAfter,
  };
}

// --- 6.5 GET .../receipts/:receiptId/url ---

export async function getReceiptDownloadUrl(code: string, userId: number, period: Competency, receiptId: string) {
  const context = await loadUserResidenceContext(code, userId); //RN-080: qualquer membro

  const receipt = await prisma.paymentReceipt.findFirst({
    where: {
      id: receiptId,
      status: 'STORED',
      settlement: { closure: { residenceId: context.residence.id, year: period.year, month: period.month } },
    },
    select: { storageKey: true, contentType: true, originalName: true },
  });
  if (!receipt) {
    throw new AppError(404, 'Comprovante não encontrado.');
  }

  const contentType = receipt.contentType ?? 'application/octet-stream';
  //PDF sai attachment, os três tipos de imagem saem inline (D-25).
  const disposition = contentType === 'application/pdf' ? 'attachment' : 'inline';
  const fileName = receipt.originalName ?? `comprovante.${EXTENSION_BY_CONTENT_TYPE[contentType] ?? 'bin'}`;

  const url = await storage.createDownloadUrl({
    key: receipt.storageKey,
    expiresInSeconds: env.RECEIPT_DOWNLOAD_URL_EXPIRES_IN,
    contentType,
    disposition,
    fileName,
  });

  return { url, expiresInSeconds: env.RECEIPT_DOWNLOAD_URL_EXPIRES_IN };
}

// --- 6.6 POST .../waive (dispensa do owner) ---

export async function waiveSettlement(
  code: string,
  userId: number,
  period: Competency,
  settlementId: string,
  reason: string,
) {
  const context = await loadUserResidenceContext(code, userId);

  if (!context.isOwner) {
    throw new AppError(403, 'Apenas o criador da residência pode dispensar um acerto.');
  }
  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada e não aceita dispensa.'); //RN-078
  }

  const closure = await loadClosure(context.residence.id, period);
  if (!closure) {
    throw new AppError(404, 'Competência não encontrada.');
  }

  const settlement = await loadSettlement(closure.id, settlementId);
  if (!settlement) {
    throw new AppError(404, 'Linha de acerto não encontrada nesta competência.');
  }

  if (isPairSettled(settlement)) {
    throw new AppError(409, 'Esta linha já foi liquidada ou dispensada.');
  }

  const beforeSettlements = await prisma.settlement.findMany({ where: { closureId: closure.id } });

  const updated = await prisma.settlement.update({
    where: { id: settlement.id },
    //RN-082 -> dispensa a linha INTEIRA, os dois lados de uma vez, independente de
    //qual dos dois carimbos faltava.
    data: { waivedAt: new Date(), waivedById: userId, waiveReason: reason },
  });

  const closureStatusAfter = await applyTransitionSideEffects({
    closureId: closure.id,
    code: context.residence.code,
    residenceId: context.residence.id,
    competency: period,
    beforeSettlements,
    touchedReceiverId: updated.receiverId,
  });

  //D-07/RN-082 -> notifica os DOIS lados do par: a dispensa muda a pendência dos
  //dois, mesmo que só um deles estivesse travado.
  await createNotifications([
    {
      userId: updated.payerId,
      type: 'SETTLEMENT_WAIVED',
      title: 'Acerto dispensado',
      message: `O acerto de ${period.month}/${period.year} em que você era o devedor foi dispensado pelo administrador. Motivo: ${reason}`,
      linkTo: settlementLink(code, period),
    },
    {
      userId: updated.receiverId,
      type: 'SETTLEMENT_WAIVED',
      title: 'Acerto dispensado',
      message: `O acerto de ${period.month}/${period.year} em que você era o credor foi dispensado pelo administrador. Motivo: ${reason}`,
      linkTo: settlementLink(code, period),
    },
  ]);

  return {
    settlement: {
      id: updated.id,
      status: settlementLineStatus(updated),
      waivedAt: updated.waivedAt,
      waiveReason: updated.waiveReason,
    },
    closureStatus: closureStatusAfter,
  };
}

// --- 6.7: bloco `settlement` embutido em GET .../expenses (Fase 6) ---

export interface CompetencySettlementSummary {
  status: ClosureStatus;
  totals: {
    payerSide: { lines: number; paid: number };
    receiverSide: { lines: number; confirmed: number };
  };
  mine: Array<{
    id: string;
    role: 'PAYER' | 'RECEIVER';
    counterpartyName: string;
    amountInCents: number;
    status: SettlementLineStatus;
  }>;
}

//Usada por listExpensesForCompetency (Fase 6). Não repete a checagem de Membership
//-- o chamador já resolveu o contexto. Uma consulta agregada só, nunca uma
//varredura de comprovantes.
export async function getCompetencySettlementSummary(
  residenceId: number,
  month: number,
  year: number,
  userId: number,
): Promise<CompetencySettlementSummary | null> {
  const closure = await prisma.monthClosure.findUnique({
    where: { residenceId_year_month: { residenceId, year, month } },
    select: { id: true },
  });
  if (!closure) return null; //competência aberta

  const settlements = await prisma.settlement.findMany({
    where: { closureId: closure.id },
    select: {
      id: true,
      payerId: true,
      receiverId: true,
      amountInCents: true,
      paidAt: true,
      confirmedAt: true,
      waivedAt: true,
      payer: { select: { name: true } },
      receiver: { select: { name: true } },
    },
  });

  //D-09 -> fechamento legado, sem nenhuma linha: lido como "nada a acertar", igual
  //a uma competência aberta -- sem isso, o campo pareceria um bug.
  if (settlements.length === 0) return null;

  return {
    status: closureStatus(settlements),
    totals: {
      payerSide: { lines: settlements.length, paid: settlements.filter((s) => s.paidAt !== null).length },
      receiverSide: { lines: settlements.length, confirmed: settlements.filter((s) => s.confirmedAt !== null).length },
    },
    mine: settlements
      .filter((s) => s.payerId === userId || s.receiverId === userId)
      .map((s) => {
        const role: 'PAYER' | 'RECEIVER' = s.payerId === userId ? 'PAYER' : 'RECEIVER';
        return {
          id: s.id,
          role,
          counterpartyName: role === 'PAYER' ? s.receiver.name : s.payer.name,
          amountInCents: s.amountInCents,
          status: settlementLineStatus(s),
        };
      }),
  };
}
