import { randomUUID } from 'node:crypto';
import prisma from '../../src/config/prisma.js';
import {
  purgeExpiredRefreshTokens,
  REFRESH_TOKEN_RETENTION_DAYS,
} from '../../src/services/auth/authService.js';

// SEC-09 -> A purga roda contra o banco de verdade porque o que precisa ser provado é o
// recorte do deleteMany: o que ele apaga e, principalmente, o que ele NÃO apaga. Um
// filtro errado aqui apaga sessão de usuário ativo (todo mundo deslogado) ou apaga a
// linha revogada que sustenta a detecção de reuso (roubo de token deixa de ser visto).

const TEST_EMAIL_DOMAIN = 'purge-integration-test.example.com';

const DIA_MS = 24 * 60 * 60 * 1000;
const dias = (n: number) => n * DIA_MS;

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function criarUsuario(): Promise<number> {
  const user = await prisma.user.create({
    data: {
      name: 'Usuário Purga',
      username: `u${uniqueSuffix()}`.slice(0, 20),
      email: `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
      password: null,
      profilePic: null,
    },
  });

  return user.id;
}

// Escreve a linha direto no banco pra poder posicioná-la no tempo — as datas em jogo
// (30 dias) não são alcançáveis por um teste que passe pelo fluxo normal de emissão.
async function criarToken(
  userId: number,
  { expiresAt, revokedAt = null }: { expiresAt: Date; revokedAt?: Date | null },
): Promise<number> {
  const token = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: `hash-${uniqueSuffix()}-${randomUUID()}`,
      familyId: randomUUID(),
      expiresAt,
      revokedAt,
    },
  });

  return token.id;
}

const existe = async (id: number) => (await prisma.refreshToken.count({ where: { id } })) === 1;

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('purgeExpiredRefreshTokens (SEC-09)', () => {
  it('apaga token expirado há mais que a janela de retenção', async () => {
    const userId = await criarUsuario();
    const antigo = await criarToken(userId, { expiresAt: new Date(Date.now() - dias(REFRESH_TOKEN_RETENTION_DAYS + 1)) });

    await purgeExpiredRefreshTokens();

    expect(await existe(antigo)).toBe(false);
  });

  it('apaga token revogado há mais que a janela, mesmo com expiresAt no futuro', async () => {
    // É o caso do logout: a linha é revogada muito antes de expirar. Sem o ramo do
    // revokedAt no filtro, ela ficaria no banco pra sempre.
    const userId = await criarUsuario();
    const revogadoAntigo = await criarToken(userId, {
      expiresAt: new Date(Date.now() + dias(7)),
      revokedAt: new Date(Date.now() - dias(REFRESH_TOKEN_RETENTION_DAYS + 1)),
    });

    await purgeExpiredRefreshTokens();

    expect(await existe(revogadoAntigo)).toBe(false);
  });

  it('preserva token ativo — apagá-lo deslogaria usuário legítimo', async () => {
    const userId = await criarUsuario();
    const ativo = await criarToken(userId, { expiresAt: new Date(Date.now() + dias(7)) });

    await purgeExpiredRefreshTokens();

    expect(await existe(ativo)).toBe(true);
  });

  it('preserva token revogado dentro da janela — é ele que detecta reuso', async () => {
    // Esta é a linha que faz rotateRefreshToken reconhecer um token roubado em vez de
    // responder "não existe". Apagá-la cedo demais apaga a detecção junto.
    const userId = await criarUsuario();
    const revogadoOntem = await criarToken(userId, {
      expiresAt: new Date(Date.now() + dias(6)),
      revokedAt: new Date(Date.now() - dias(1)),
    });

    await purgeExpiredRefreshTokens();

    expect(await existe(revogadoOntem)).toBe(true);
  });

  it('preserva token expirado ontem — ainda dentro da janela forense', async () => {
    const userId = await criarUsuario();
    const expiradoOntem = await criarToken(userId, { expiresAt: new Date(Date.now() - dias(1)) });

    await purgeExpiredRefreshTokens();

    expect(await existe(expiradoOntem)).toBe(true);
  });

  it('devolve quantas linhas removeu', async () => {
    const userId = await criarUsuario();
    const alvos = [
      await criarToken(userId, { expiresAt: new Date(Date.now() - dias(REFRESH_TOKEN_RETENTION_DAYS + 2)) }),
      await criarToken(userId, { expiresAt: new Date(Date.now() - dias(REFRESH_TOKEN_RETENTION_DAYS + 3)) }),
    ];
    await criarToken(userId, { expiresAt: new Date(Date.now() + dias(7)) });

    // O banco é compartilhado com os outros testes, então o número absoluto não é
    // previsível — o que dá pra afirmar é que as linhas alvo entraram na conta.
    const removidas = await purgeExpiredRefreshTokens();

    expect(removidas).toBeGreaterThanOrEqual(alvos.length);
    expect(await existe(alvos[0]!)).toBe(false);
    expect(await existe(alvos[1]!)).toBe(false);
  });

  it('é idempotente: rodar de novo não remove mais nada', async () => {
    const userId = await criarUsuario();
    await criarToken(userId, { expiresAt: new Date(Date.now() + dias(7)) });

    await purgeExpiredRefreshTokens();
    const segundaPassada = await purgeExpiredRefreshTokens();

    expect(segundaPassada).toBe(0);
  });
});
