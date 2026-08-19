import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';
import { REFRESH_COOKIE_NAME } from '../../src/middlewares/auth.js';
import { setSendEmailForTests } from '../../src/lib/mailer.js';
import { flushPendingEmails, PASSWORD_RESET_REQUESTED_MESSAGE } from '../../src/services/auth/passwordResetService.js';
import type { OutgoingEmail, SendEmail } from '../../src/lib/mailer.js';

// Nenhum email real sai durante esta suíte (checklist de aceite do plano): o espião
// abaixo substitui o remetente SMTP de verdade por um jest.fn() antes de qualquer
// teste rodar, e nunca chega perto de nodemailer/Gmail.
const emailSpy = jest.fn(async () => undefined) as jest.MockedFunction<SendEmail>;

const TEST_EMAIL_DOMAIN = 'password-reset-integration-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function getSetCookie(response: request.Response, name: string): string | undefined {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${name}=`));
}

function cookieValue(setCookieHeader: string): string {
  return setCookieHeader.split(';')[0]!.split('=')[1]!;
}

function extractToken(email: OutgoingEmail): string {
  const match = email.text.match(/https?:\/\/\S+/);
  if (!match) {
    throw new Error('Link não encontrado no corpo do email de teste.');
  }
  return new URL(match[0]).searchParams.get('token')!;
}

interface Registered {
  agent: ReturnType<typeof request.agent>;
  id: number;
  username: string;
  email: string;
  password: string;
}

async function registerUser(): Promise<Registered> {
  const agent = request.agent(app);
  const username = `u${uniqueSuffix()}`.slice(0, 20);
  const email = `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`;
  const password = 'senhaForte1';

  const response = await agent.post('/auth/register').send({
    name: 'Usuário Reset Senha',
    username,
    email,
    password,
    confirmPassword: password,
  });

  return { agent, id: response.body.user.id, username, email, password };
}

async function forgotPassword(email: string) {
  const response = await request(app).post('/auth/forgot-password').send({ email });
  await flushPendingEmails();
  return response;
}

beforeAll(() => {
  setSendEmailForTests(emailSpy);
});

afterEach(() => {
  emailSpy.mockClear();
});

afterAll(async () => {
  setSendEmailForTests(null);
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('POST /auth/forgot-password (D-03, anti-enumeração)', () => {
  it('email cadastrado responde 200 com a mensagem exata da constante', async () => {
    const user = await registerUser();

    const response = await forgotPassword(user.email);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(PASSWORD_RESET_REQUESTED_MESSAGE);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it('email não cadastrado responde 200 com A MESMA mensagem, e nenhuma linha é criada', async () => {
    const emailInexistente = `naoexiste-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`;
    const tokensAntes = await prisma.passwordResetToken.count({});

    const response = await forgotPassword(emailInexistente);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(PASSWORD_RESET_REQUESTED_MESSAGE);
    expect(emailSpy).not.toHaveBeenCalled();
    expect(await prisma.passwordResetToken.count({})).toBe(tokensAntes);
  });

  it('email em formato inválido responde 400 (validação de formato, não de existência)', async () => {
    const response = await request(app).post('/auth/forgot-password').send({ email: 'abc' });

    expect(response.status).toBe(400);
  });
});

describe('Fluxo completo de redefinição', () => {
  it('pedir → capturar link → redefinir → senha antiga falha, nova funciona', async () => {
    const user = await registerUser();

    expect((await forgotPassword(user.email)).status).toBe(200);
    const token = extractToken(emailSpy.mock.calls[0]![0]);

    const reset = await request(app)
      .post('/auth/reset-password')
      .send({ token, newPassword: 'senhaNovaForte1', confirmNewPassword: 'senhaNovaForte1' });
    expect(reset.status).toBe(200);

    const loginAntiga = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: user.password });
    expect(loginAntiga.status).toBe(401);

    const loginNova = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: 'senhaNovaForte1' });
    expect(loginNova.status).toBe(200);
  });

  it('uso único: repetir a redefinição com o mesmo token retorna 400', async () => {
    const user = await registerUser();
    await forgotPassword(user.email);
    const token = extractToken(emailSpy.mock.calls[0]![0]);

    await request(app)
      .post('/auth/reset-password')
      .send({ token, newPassword: 'senhaNovaForte1', confirmNewPassword: 'senhaNovaForte1' });

    const segunda = await request(app)
      .post('/auth/reset-password')
      .send({ token, newPassword: 'outraSenhaForte1', confirmNewPassword: 'outraSenhaForte1' });
    expect(segunda.status).toBe(400);
  });

  it('expiração: token com expiresAt no passado é recusado', async () => {
    const user = await registerUser();
    await forgotPassword(user.email);
    const token = extractToken(emailSpy.mock.calls[0]![0]);

    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await request(app)
      .post('/auth/reset-password')
      .send({ token, newPassword: 'senhaNovaForte1', confirmNewPassword: 'senhaNovaForte1' });
    expect(response.status).toBe(400);
  });

  it('pedido novo invalida o anterior: token do primeiro email falha, do segundo funciona', async () => {
    const user = await registerUser();

    await forgotPassword(user.email);
    const primeiroToken = extractToken(emailSpy.mock.calls[0]![0]);

    await forgotPassword(user.email);
    const segundoToken = extractToken(emailSpy.mock.calls[1]![0]);

    const respostaPrimeiro = await request(app)
      .post('/auth/reset-password')
      .send({ token: primeiroToken, newPassword: 'senhaNovaForte1', confirmNewPassword: 'senhaNovaForte1' });
    expect(respostaPrimeiro.status).toBe(400);

    const respostaSegundo = await request(app)
      .post('/auth/reset-password')
      .send({ token: segundoToken, newPassword: 'senhaNovaForte1', confirmNewPassword: 'senhaNovaForte1' });
    expect(respostaSegundo.status).toBe(200);
  });

  it('D-06: derruba as sessões de outros dispositivos', async () => {
    const user = await registerUser();

    const outroDispositivo = await request(app)
      .post('/auth/login')
      .send({ username: user.username, password: user.password });
    expect(outroDispositivo.status).toBe(200);
    const refreshOutroDispositivo = cookieValue(getSetCookie(outroDispositivo, REFRESH_COOKIE_NAME)!);

    await forgotPassword(user.email);
    const token = extractToken(emailSpy.mock.calls[0]![0]);
    await request(app)
      .post('/auth/reset-password')
      .send({ token, newPassword: 'senhaNovaForte1', confirmNewPassword: 'senhaNovaForte1' });

    const refresh = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE_NAME}=${refreshOutroDispositivo}`]);
    expect(refresh.status).toBe(401);
  });

  it('D-06: a resposta do reset não traz Set-Cookie de sessão nenhum', async () => {
    const user = await registerUser();
    await forgotPassword(user.email);
    const token = extractToken(emailSpy.mock.calls[0]![0]);

    const response = await request(app)
      .post('/auth/reset-password')
      .send({ token, newPassword: 'senhaNovaForte1', confirmNewPassword: 'senhaNovaForte1' });

    const raw = (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    expect(raw.some((c) => c.startsWith('JWT=') || c.startsWith(`${REFRESH_COOKIE_NAME}=`))).toBe(false);
  });
});

describe('D-11: conta que só entra com Google', () => {
  async function createGoogleOnlyUser() {
    return prisma.user.create({
      data: {
        name: 'Usuário Google',
        username: `g${uniqueSuffix()}`.slice(0, 20),
        email: `google-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
        password: null,
      },
    });
  }

  it('responde 200 normal, não cria token, e o espião recebe o template de conta Google', async () => {
    const user = await createGoogleOnlyUser();

    const response = await forgotPassword(user.email);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(PASSWORD_RESET_REQUESTED_MESSAGE);

    const tokens = await prisma.passwordResetToken.count({ where: { userId: user.id } });
    expect(tokens).toBe(0);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0]![0].subject).toMatch(/google/i);
  });

  it('D-07 no ramo sem token: 4 pedidos seguidos continuam 200, mas só 3 emails saem', async () => {
    const user = await createGoogleOnlyUser();

    for (let i = 0; i < 4; i++) {
      const response = await forgotPassword(user.email);
      expect(response.status).toBe(200);
    }

    expect(emailSpy).toHaveBeenCalledTimes(3);
  });
});
