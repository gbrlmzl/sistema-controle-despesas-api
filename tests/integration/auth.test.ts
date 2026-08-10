import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';
import { requireAuth } from '../../src/middlewares/auth.js';

const TEST_EMAIL_DOMAIN = 'auth-integration-test.example.com';

function uniqueEmail(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2)}@${TEST_EMAIL_DOMAIN}`;
}

function validRegisterBody(overrides: Partial<Record<string, string>> = {}) {
  const email = overrides.email ?? uniqueEmail();
  return {
    name: 'Usuário de Teste',
    username: `user${Date.now()}${Math.floor(Math.random() * 1000)}`,
    email,
    password: 'senhaForte1',
    confirmPassword: 'senhaForte1',
    ...overrides,
  };
}

function getSetCookie(response: request.Response, name: string): string | undefined {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${name}=`));
}

function cookieValue(setCookieHeader: string): string {
  return setCookieHeader.split(';')[0]!.split('=')[1]!;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('POST /auth/register', () => {
  it('cadastra um usuário novo e seta os cookies de sessão (access + refresh)', async () => {
    const body = validRegisterBody();

    const response = await request(app).post('/auth/register').send(body);

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ email: body.email, username: body.username });
    expect(response.body.user.password).toBeUndefined();
    expect(getSetCookie(response, 'JWT')).toBeDefined();
    expect(getSetCookie(response, 'refreshToken')).toBeDefined();
  });

  it('rejeita corpo inválido (senha curta) com 400', async () => {
    const response = await request(app)
      .post('/auth/register')
      .send(validRegisterBody({ password: '123', confirmPassword: '123' }));

    expect(response.status).toBe(400);
  });

  it('rejeita email duplicado com 409', async () => {
    const body = validRegisterBody();
    await request(app).post('/auth/register').send(body);

    const second = await request(app)
      .post('/auth/register')
      .send(validRegisterBody({ email: body.email }));

    expect(second.status).toBe(409);
  });
});

describe('POST /auth/login', () => {
  it('autentica com credenciais corretas e seta os cookies', async () => {
    const body = validRegisterBody();
    await request(app).post('/auth/register').send(body);

    const response = await request(app).post('/auth/login').send({ username: body.username, password: body.password });

    expect(response.status).toBe(200);
    expect(response.body.user.username).toBe(body.username);
    expect(getSetCookie(response, 'JWT')).toBeDefined();
    expect(getSetCookie(response, 'refreshToken')).toBeDefined();
  });

  it('rejeita senha errada com 401', async () => {
    const body = validRegisterBody();
    await request(app).post('/auth/register').send(body);

    const response = await request(app).post('/auth/login').send({ username: body.username, password: 'senhaErrada1' });

    expect(response.status).toBe(401);
  });

  it('rejeita username inexistente com 401', async () => {
    const response = await request(app)
      .post('/auth/login')
      .send({ username: `naoexiste${Date.now() % 100000}`, password: 'qualquerSenha1' });

    expect(response.status).toBe(401);
  });
});

describe('POST /auth/refresh (rotação + detecção de reuso)', () => {
  const agent = request.agent(app);
  let firstRefreshToken: string;
  let secondRefreshToken: string;

  it('registro inicial emite access + refresh token', async () => {
    const response = await agent.post('/auth/register').send(validRegisterBody());

    expect(response.status).toBe(201);
    const cookie = getSetCookie(response, 'refreshToken');
    expect(cookie).toBeDefined();
    firstRefreshToken = cookieValue(cookie!);
  });

  it('troca um refresh token válido por um par novo (rotação)', async () => {
    const response = await agent.post('/auth/refresh');

    expect(response.status).toBe(200);
    const cookie = getSetCookie(response, 'refreshToken');
    expect(cookie).toBeDefined();
    secondRefreshToken = cookieValue(cookie!);
    expect(secondRefreshToken).not.toBe(firstRefreshToken);
  });

  it('rejeita o token antigo já rotacionado (reuso) com 401', async () => {
    const response = await request(app).post('/auth/refresh').set('Cookie', [`refreshToken=${firstRefreshToken}`]);

    expect(response.status).toBe(401);
  });

  it('reuso detectado revoga a família inteira — o token mais novo também para de funcionar', async () => {
    const response = await request(app).post('/auth/refresh').set('Cookie', [`refreshToken=${secondRefreshToken}`]);

    expect(response.status).toBe(401);
  });

  it('rejeita requisição sem cookie de refresh', async () => {
    const response = await request(app).post('/auth/refresh');

    expect(response.status).toBe(401);
  });

  it('rejeita valor de cookie inválido/aleatório', async () => {
    const response = await request(app).post('/auth/refresh').set('Cookie', ['refreshToken=valor-que-nunca-existiu']);

    expect(response.status).toBe(401);
  });

  it('rejeita um refresh token expirado (mas ainda não revogado)', async () => {
    const registerResponse = await request(app).post('/auth/register').send(validRegisterBody());
    const refreshCookie = getSetCookie(registerResponse, 'refreshToken')!;
    const rawToken = cookieValue(refreshCookie);

    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await prisma.refreshToken.update({ where: { tokenHash }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await request(app).post('/auth/refresh').set('Cookie', [refreshCookie]);

    expect(response.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('limpa os dois cookies de sessão', async () => {
    const response = await request(app).post('/auth/logout');

    expect(response.status).toBe(200);
    expect(getSetCookie(response, 'JWT')).toMatch(/^JWT=;/);
    expect(getSetCookie(response, 'refreshToken')).toMatch(/^refreshToken=;/);
  });

  it('revoga o refresh token — não pode ser reaproveitado depois do logout', async () => {
    const registerResponse = await request(app).post('/auth/register').send(validRegisterBody());
    const refreshCookie = getSetCookie(registerResponse, 'refreshToken')!;
    const rawToken = cookieValue(refreshCookie);

    const logoutResponse = await request(app).post('/auth/logout').set('Cookie', [refreshCookie]);
    expect(logoutResponse.status).toBe(200);

    const refreshAttempt = await request(app).post('/auth/refresh').set('Cookie', [`refreshToken=${rawToken}`]);
    expect(refreshAttempt.status).toBe(401);
  });
});

describe('requireAuth (middleware)', () => {
  const protectedApp = express();
  protectedApp.use(express.json());
  protectedApp.use(cookieParser());
  protectedApp.get('/protected', requireAuth, (req, res) => {
    res.status(200).json({ user: req.user });
  });

  it('responde 401 sem cookie/token', async () => {
    const response = await request(protectedApp).get('/protected');
    expect(response.status).toBe(401);
  });

  it('responde 401 com token inválido', async () => {
    const response = await request(protectedApp).get('/protected').set('Cookie', ['JWT=lixo-invalido']);
    expect(response.status).toBe(401);
  });

  it('responde 200 e popula req.user com token válido (via cookie do registro)', async () => {
    const body = validRegisterBody();
    const registerResponse = await request(app).post('/auth/register').send(body);
    const jwtCookie = getSetCookie(registerResponse, 'JWT')!;

    const response = await request(protectedApp).get('/protected').set('Cookie', [jwtCookie]);

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe(body.email);
  });
});
