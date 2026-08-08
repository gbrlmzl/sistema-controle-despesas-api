import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';

const TEST_EMAIL_DOMAIN = 'notifications-integration-test.example.com';

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
}

async function registerUser(name = 'Usuário de Teste'): Promise<RegisteredUser> {
  const agent = request.agent(app);
  const email = uniqueEmail();
  const username = uniqueUsername();

  const response = await agent
    .post('/auth/register')
    .send({ name, username, email, password: 'senhaForte1', confirmPassword: 'senhaForte1' });

  return { agent, id: response.body.user.id, name, username, email };
}

afterAll(async () => {
  await prisma.residence.deleteMany({ where: { owner: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('GET /notifications e PATCH /notifications', () => {
  let owner: RegisteredUser;
  let member: RegisteredUser;

  beforeAll(async () => {
    owner = await registerUser('Dono Notificações');
    member = await registerUser('Membro Notificações');

    const created = await owner.agent.post('/residences').send({ name: 'Casa Notificações' });
    const code = created.body.residence.code;

    //Gera uma notificação real (JOIN_REQUEST_RECEIVED) pro owner, via o fluxo já
    //testado na Fase 3 — evita popular o banco na mão pra este teste.
    await member.agent.post('/residences/join-requests').send({ code });
  });

  it('rejeita requisição sem autenticação', async () => {
    const response = await request(app).get('/notifications');
    expect(response.status).toBe(401);
  });

  it('lista as notificações do usuário autenticado, mais recente primeiro, com contagem de não lidas', async () => {
    const response = await owner.agent.get('/notifications');

    expect(response.status).toBe(200);
    expect(response.body.notifications.length).toBeGreaterThanOrEqual(1);
    expect(response.body.notifications[0]).toMatchObject({
      type: 'JOIN_REQUEST_RECEIVED',
      isRead: false,
    });
    expect(response.body.unread).toBeGreaterThanOrEqual(1);
    expect(response.body.total).toBeGreaterThanOrEqual(1);
    expect(response.body.page).toBe(1);
  });

  it('não vaza notificação de outro usuário', async () => {
    const response = await member.agent.get('/notifications');

    expect(response.status).toBe(200);
    expect(response.body.notifications).toHaveLength(0);
    expect(response.body.unread).toBe(0);
  });

  it('rejeita corpo inválido no PATCH (nem all, nem ids)', async () => {
    const response = await owner.agent.patch('/notifications').send({});
    expect(response.status).toBe(400);
  });

  it('marca notificações específicas como lidas por id', async () => {
    const before = await owner.agent.get('/notifications');
    const id = before.body.notifications[0].id;

    const response = await owner.agent.patch('/notifications').send({ ids: [id] });
    expect(response.status).toBe(200);
    expect(response.body.unread).toBe(0);

    const after = await owner.agent.get('/notifications');
    expect(after.body.notifications.find((n: { id: number }) => n.id === id)?.isRead).toBe(true);
  });

  it('marca todas como lidas com { all: true }', async () => {
    const code = (await owner.agent.post('/residences').send({ name: 'Casa Notificações 2' })).body.residence.code;
    await member.agent.post('/residences/join-requests').send({ code });

    const before = await owner.agent.get('/notifications');
    expect(before.body.unread).toBeGreaterThanOrEqual(1);

    const response = await owner.agent.patch('/notifications').send({ all: true });
    expect(response.status).toBe(200);
    expect(response.body.unread).toBe(0);
  });

  it('não marca como lida notificação de outro usuário', async () => {
    const code = (await owner.agent.post('/residences').send({ name: 'Casa Notificações 3' })).body.residence.code;
    await member.agent.post('/residences/join-requests').send({ code });

    const ownerNotifications = await owner.agent.get('/notifications');
    const unreadNotificationId = ownerNotifications.body.notifications.find(
      (n: { isRead: boolean }) => !n.isRead,
    ).id;

    await member.agent.patch('/notifications').send({ ids: [unreadNotificationId] });

    const stillUnread = await prisma.notification.findUnique({ where: { id: unreadNotificationId } });
    expect(stillUnread?.readAt).toBeNull();
  });
});
