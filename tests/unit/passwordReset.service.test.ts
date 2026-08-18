import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import prisma from '../../src/config/prisma.js';
import {
  PASSWORD_RESET_MAX_PER_HOUR,
  requestPasswordReset,
  resetPassword,
  verifyPasswordResetToken,
} from '../../src/services/auth/passwordResetService.js';
import { issueRefreshToken } from '../../src/services/auth/authService.js';
import type { OutgoingEmail, SendEmail } from '../../src/lib/mailer.js';

// Estes testes chamam o service direto (sem HTTP), mas ainda tocam o banco de teste
// de verdade: não há injeção de dependência para o Prisma neste projeto (só para
// efeitos colaterais como email/purga), então "unitário" aqui significa "sem passar
// pela camada Express", não "sem banco".

const TEST_EMAIL_DOMAIN = 'password-reset-service-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function fakeSendEmail(): jest.MockedFunction<SendEmail> {
  return jest.fn(async () => undefined) as unknown as jest.MockedFunction<SendEmail>;
}

function extractToken(email: OutgoingEmail): string {
  const match = email.text.match(/https?:\/\/\S+/);
  if (!match) {
    throw new Error('Link não encontrado no corpo do email de teste.');
  }
  return new URL(match[0]).searchParams.get('token')!;
}

async function createUser(password: string | null = 'senhaAntiga1') {
  return prisma.user.create({
    data: {
      name: 'Usuário Reset Senha',
      username: `u${uniqueSuffix()}`.slice(0, 20),
      email: `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
      password: password === null ? null : await bcrypt.hash(password, 10),
    },
  });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('requestPasswordReset', () => {
  it('email desconhecido não cria linha nem chama sendEmail', async () => {
    const sendEmail = fakeSendEmail();

    await requestPasswordReset(`naoexiste-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`, { sendEmail });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('conta só-Google recebe o template D-11 e não gera token', async () => {
    const user = await createUser(null);
    const sendEmail = fakeSendEmail();

    await requestPasswordReset(user.email, { sendEmail });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0].subject).toMatch(/google/i);

    const tokens = await prisma.passwordResetToken.count({ where: { userId: user.id } });
    expect(tokens).toBe(0);
  });

  it(`o ${PASSWORD_RESET_MAX_PER_HOUR + 1}º pedido em uma hora não envia`, async () => {
    const user = await createUser();
    const sendEmail = fakeSendEmail();

    for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR; i++) {
      await requestPasswordReset(user.email, { sendEmail });
    }
    expect(sendEmail).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_PER_HOUR);

    await requestPasswordReset(user.email, { sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_PER_HOUR);
  });

  it('o teto também vale para a conta só-Google, que não emite token (D-07)', async () => {
    const user = await createUser(null);
    const sendEmail = fakeSendEmail();

    for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR; i++) {
      await requestPasswordReset(user.email, { sendEmail });
    }
    expect(sendEmail).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_PER_HOUR);

    await requestPasswordReset(user.email, { sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(PASSWORD_RESET_MAX_PER_HOUR);
  });

  it('pedido novo invalida o anterior', async () => {
    const user = await createUser();
    const sendEmail = fakeSendEmail();

    await requestPasswordReset(user.email, { sendEmail });
    const primeiroToken = extractToken(sendEmail.mock.calls[0]![0]);

    await requestPasswordReset(user.email, { sendEmail });
    const segundoToken = extractToken(sendEmail.mock.calls[1]![0]);

    await expect(verifyPasswordResetToken(primeiroToken)).rejects.toThrow(
      'Link inválido ou expirado. Peça um novo.',
    );
    await expect(verifyPasswordResetToken(segundoToken)).resolves.toBeUndefined();
  });
});

describe('resetPassword', () => {
  it('token expirado e token já usado são recusados com a mesma mensagem', async () => {
    const user = await createUser();
    const sendEmail = fakeSendEmail();
    await requestPasswordReset(user.email, { sendEmail });
    const usedToken = extractToken(sendEmail.mock.calls[0]![0]);

    await resetPassword(usedToken, 'novaSenhaForte1');
    await expect(resetPassword(usedToken, 'outraSenhaForte1')).rejects.toThrow(
      'Link inválido ou expirado. Peça um novo.',
    );

    const sendEmail2 = fakeSendEmail();
    await requestPasswordReset(user.email, { sendEmail: sendEmail2 });
    const expiredToken = extractToken(sendEmail2.mock.calls[0]![0]);
    const expiredTokenHash = createHash('sha256').update(expiredToken).digest('hex');
    await prisma.passwordResetToken.update({
      where: { tokenHash: expiredTokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(resetPassword(expiredToken, 'outraSenhaForte1')).rejects.toThrow(
      'Link inválido ou expirado. Peça um novo.',
    );
  });

  it('redefine a senha e chama revokeAllUserTokens', async () => {
    const user = await createUser('senhaAntiga1');
    await issueRefreshToken(user.id);
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);

    const sendEmail = fakeSendEmail();
    await requestPasswordReset(user.email, { sendEmail });
    const token = extractToken(sendEmail.mock.calls[0]![0]);

    await resetPassword(token, 'senhaNovaForte1');

    const atualizado = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    await expect(bcrypt.compare('senhaNovaForte1', atualizado.password!)).resolves.toBe(true);
    await expect(bcrypt.compare('senhaAntiga1', atualizado.password!)).resolves.toBe(false);

    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });
});
