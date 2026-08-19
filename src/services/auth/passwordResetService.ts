import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import ms from 'ms';
import prisma from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { logError, logSecurityEvent, type SecurityContext } from '../../utils/logger.js';
import { revokeAllUserTokens } from './authService.js';
import type { SendEmail, OutgoingEmail } from '../../lib/mailer.js';
import { passwordResetEmail, passwordResetGoogleAccountEmail } from '../../lib/emailTemplates.js';

const SALT_ROUNDS = 10; // SEC-15 -> decisão fechada do projeto; não mude.

export const PASSWORD_RESET_REQUESTED_MESSAGE =
  'Caso exista uma conta vinculada a esse email, ela receberá um email para criar uma nova senha.';

// D-07 -> Teto por conta. Cobre os dois ramos (com e sem emissão de token) porque
// conta os PasswordResetAttempt, não os PasswordResetToken — ver comentário do model.
export const PASSWORD_RESET_MAX_PER_HOUR = 3;

// SEC-09 -> Retenção folgada de propósito: o token vive só 30 minutos e o teto do
// D-07 só olha a última hora, mas uma linha recente ainda serve pra investigar um
// password_reset_token_reuse ou um password_reset_throttled no log.
export const PASSWORD_RESET_RETENTION_DAYS = 7;

const INVALID_TOKEN_MESSAGE = 'Link inválido ou expirado. Peça um novo.';

function hashResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

// D-04 -> Rastreador de envios pendentes. O 200 do controller sai ANTES do email de
// verdade — aguardar o SMTP aqui criaria um oráculo de tempo (conta que existe leva o
// round trip do envio; conta que não existe, quase zero) que anularia o D-03. O
// despacho nunca é `await`ado no fluxo principal; só fica registrado aqui, pra
// flushPendingEmails() (testes e o shutdown gracioso) poder esperar por ele depois.
const pendingEmails = new Set<Promise<void>>();

function dispatchEmail(sendEmail: SendEmail, email: OutgoingEmail): void {
  const promise = sendEmail(email)
    // Uma falha de SMTP não pode virar unhandledRejection solto — o handler global em
    // server.ts existe pra erro inesperado, não pra "Gmail recusou o envio".
    .catch((err: unknown) => logError(err, 'passwordReset/sendEmail'))
    .finally(() => pendingEmails.delete(promise));

  pendingEmails.add(promise);
}

export async function flushPendingEmails(): Promise<void> {
  await Promise.allSettled([...pendingEmails]);
}

async function countRecentAttempts(userId: number): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return prisma.passwordResetAttempt.count({ where: { userId, createdAt: { gte: oneHourAgo } } });
}

export async function requestPasswordReset(
  email: string,
  deps: { sendEmail: SendEmail },
  context: SecurityContext = {},
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();

  // O registro grava o email como foi digitado (registerSchema não normaliza), então
  // uma conta criada como "Fulano@Gmail.com" nunca seria achada por igualdade exata em
  // minúsculas — e por causa do D-03 o usuário veria o 200 de sempre e nunca receberia
  // o email. findFirst + mode:'insensitive' é o que resolve isso; findUnique não aceita
  // esse modo.
  const user = await prisma.user.findFirst({
    where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
  });

  // Sem erro, sem log, sem email: a inexistência da conta não pode ser observável.
  if (!user) {
    return;
  }

  // D-07 -> Esta checagem é normativa ANTES de qualquer ramo, inclusive o da conta
  // só-Google (D-11) logo abaixo, que sai sem emitir token nenhum. Checar depois
  // deixaria essa conta inteiramente fora do teto.
  const recentAttempts = await countRecentAttempts(user.id);
  if (recentAttempts >= PASSWORD_RESET_MAX_PER_HOUR) {
    logSecurityEvent('password_reset_throttled', { ip: context.ip, userId: user.id });
    return;
  }

  if (user.password === null) {
    // D-11 -> Conta só-Google: nunca cria senha local por este caminho, nunca emite
    // token. Ainda assim conta pro teto (por isso o PasswordResetAttempt aqui).
    await prisma.passwordResetAttempt.create({ data: { userId: user.id } });
    dispatchEmail(deps.sendEmail, { ...passwordResetGoogleAccountEmail({ name: user.name }), to: user.email });
    return;
  }

  // D-05 -> Pedir um link novo invalida os anteriores — quem clica duas vezes espera
  // que o mais recente seja o que funciona.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  const ttlMs = ms(env.PASSWORD_RESET_TOKEN_EXPIRES_IN as ms.StringValue);
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash, expiresAt } });
  await prisma.passwordResetAttempt.create({ data: { userId: user.id } });

  const resetUrl = `${env.FRONTEND_URL}${env.PASSWORD_RESET_PATH}?token=${encodeURIComponent(rawToken)}`;
  const expiresInMinutes = Math.round(ttlMs / 60_000);

  dispatchEmail(deps.sendEmail, {
    ...passwordResetEmail({ name: user.name, resetUrl, expiresInMinutes }),
    to: user.email,
  });
}

async function findValidTokenRecord(rawToken: string, context: SecurityContext) {
  const tokenHash = hashResetToken(rawToken);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  // A MESMA mensagem para "não existe", "já usado" e "expirado": diferenciar contaria
  // ao atacante se o token chegou a existir de verdade.
  if (!record) {
    throw new AppError(400, INVALID_TOKEN_MESSAGE);
  }

  if (record.usedAt !== null) {
    // Reuso de um token já consumido é sinal real, mesmo peso do refresh_token_reuse —
    // nunca o token em si no log, só o prefixo do hash.
    logSecurityEvent('password_reset_token_reuse', {
      ip: context.ip,
      userId: record.userId,
      tokenHashPrefix: tokenHash.slice(0, 12),
    });
    throw new AppError(400, INVALID_TOKEN_MESSAGE);
  }

  if (record.expiresAt < new Date()) {
    throw new AppError(400, INVALID_TOKEN_MESSAGE);
  }

  return record;
}

export async function verifyPasswordResetToken(rawToken: string): Promise<void> {
  await findValidTokenRecord(rawToken, {});
}

export async function resetPassword(
  rawToken: string,
  newPassword: string,
  context: SecurityContext = {},
): Promise<void> {
  const record = await findValidTokenRecord(rawToken, context);

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  // Sem transação, uma falha entre os dois updates deixaria o token vivo com a senha
  // já trocada (ou a senha trocada com o token ainda marcável como reuso) — nenhum dos
  // dois desfechos parciais é aceitável.
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { password: passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
  ]);

  // D-06 -> Derruba todas as sessões. Sem login automático: não chama
  // establishSession, não seta cookie nenhum — o usuário vai pra tela de login.
  await revokeAllUserTokens(record.userId);
}

export async function purgeExpiredPasswordResetTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - PASSWORD_RESET_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const [tokens, attempts] = await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    prisma.passwordResetAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);

  return tokens.count + attempts.count;
}
