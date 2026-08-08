import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';
import { AVATARS } from '../../src/schemas/usuarios.js';

const TEST_EMAIL_DOMAIN = 'users-integration-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function uniqueEmail(): string {
  return `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`;
}

function uniqueUsername(): string {
  return `u${uniqueSuffix()}`.slice(0, 20);
}

interface RegisteredUser {
  agent: ReturnType<typeof request.agent>;
  id: number;
  name: string;
  username: string;
  email: string;
  password: string;
}

async function registerUser(name = 'Usuário de Teste'): Promise<RegisteredUser> {
  const agent = request.agent(app);
  const email = uniqueEmail();
  const username = uniqueUsername();
  const password = 'senhaForte1';

  const response = await agent.post('/auth/register').send({ name, username, email, password, confirmPassword: password });

  return { agent, id: response.body.user.id, name, username, email, password };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('PATCH /users/me (avatar)', () => {
  it('rejeita requisição sem autenticação', async () => {
    const response = await request(app).patch('/users/me').send({ avatar: AVATARS[0] });
    expect(response.status).toBe(401);
  });

  it('rejeita avatar fora da whitelist', async () => {
    const user = await registerUser('Avatar Inválido');
    const response = await user.agent.patch('/users/me').send({ avatar: '/avatars/nao-existe.svg' });
    expect(response.status).toBe(400);
  });

  it('troca o avatar do usuário autenticado', async () => {
    const user = await registerUser('Troca Avatar');
    const response = await user.agent.patch('/users/me').send({ avatar: AVATARS[3] });

    expect(response.status).toBe(200);
    expect(response.body.user.profilePic).toBe(AVATARS[3]);

    const persisted = await prisma.user.findUnique({ where: { id: user.id } });
    expect(persisted?.profilePic).toBe(AVATARS[3]);
  });
});

describe('PATCH /users/me/password', () => {
  it('rejeita requisição sem autenticação', async () => {
    const response = await request(app)
      .patch('/users/me/password')
      .send({ currentPassword: 'x', newPassword: 'novaSenha1', confirmNewPassword: 'novaSenha1' });
    expect(response.status).toBe(401);
  });

  it('rejeita quando a senha atual está incorreta', async () => {
    const user = await registerUser('Senha Errada');
    const response = await user.agent
      .patch('/users/me/password')
      .send({ currentPassword: 'senhaErrada1', newPassword: 'novaSenha1', confirmNewPassword: 'novaSenha1' });

    expect(response.status).toBe(401);
  });

  it('rejeita quando a confirmação não bate', async () => {
    const user = await registerUser('Confirmacao Errada');
    const response = await user.agent.patch('/users/me/password').send({
      currentPassword: user.password,
      newPassword: 'novaSenha1',
      confirmNewPassword: 'outraCoisa1',
    });

    expect(response.status).toBe(400);
  });

  it('troca a senha e permite login com a nova senha', async () => {
    const user = await registerUser('Troca Senha');
    const newPassword = 'novaSenhaForte1';

    const response = await user.agent.patch('/users/me/password').send({
      currentPassword: user.password,
      newPassword,
      confirmNewPassword: newPassword,
    });
    expect(response.status).toBe(200);

    const loginWithOldPassword = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: user.password });
    expect(loginWithOldPassword.status).toBe(401);

    const loginWithNewPassword = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: newPassword });
    expect(loginWithNewPassword.status).toBe(200);
  });
});
