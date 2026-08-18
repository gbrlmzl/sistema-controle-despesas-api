import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';
import { AUTH_COOKIE_NAME, REFRESH_COOKIE_NAME } from '../../src/middlewares/auth.js';

// SEC-06 -> Trocar a senha é o gesto que o usuário faz quando desconfia que alguém
// entrou na conta dele. Antes desta correção o gesto não fazia nada contra o invasor: o
// refresh token roubado continuava rotacionando por até 7 dias.
//
// Os testes abaixo cobrem os dois lados do comportamento, que são igualmente
// obrigatórios: os OUTROS dispositivos caem, e o dispositivo que trocou a senha
// continua logado (senão a correção vira um bug de usabilidade e alguém a remove).

const TEST_EMAIL_DOMAIN = 'password-change-integration-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

interface Registered {
  agent: ReturnType<typeof request.agent>;
  id: number;
  username: string;
  password: string;
  refreshToken: string;
}

function getSetCookie(response: request.Response, name: string): string | undefined {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${name}=`));
}

function cookieValue(setCookieHeader: string): string {
  return setCookieHeader.split(';')[0]!.split('=')[1]!;
}

async function registerUser(): Promise<Registered> {
  const agent = request.agent(app);
  const username = `u${uniqueSuffix()}`.slice(0, 20);
  const password = 'senhaForte1';

  const response = await agent.post('/auth/register').send({
    name: 'Usuário Troca de Senha',
    username,
    email: `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
    password,
    confirmPassword: password,
  });

  return {
    agent,
    id: response.body.user.id,
    username,
    password,
    refreshToken: cookieValue(getSetCookie(response, REFRESH_COOKIE_NAME)!),
  };
}

// Um segundo login do mesmo usuário: é o "outro dispositivo" que precisa cair. Cada
// login abre uma família de rotação nova, então isto também prova que a revogação
// alcança famílias diferentes, e não só a linhagem de um token.
async function loginNoOutroDispositivo(user: Registered): Promise<string> {
  const response = await request(app)
    .post('/auth/login')
    .send({ username: user.username, password: user.password });

  expect(response.status).toBe(200);
  return cookieValue(getSetCookie(response, REFRESH_COOKIE_NAME)!);
}

function trocarSenha(user: Registered, novaSenha: string) {
  return user.agent.patch('/users/me/password').send({
    currentPassword: user.password,
    newPassword: novaSenha,
    confirmNewPassword: novaSenha,
  });
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('PATCH /users/me/password derruba as outras sessões (SEC-06)', () => {
  it('invalida o refresh token de outro dispositivo', async () => {
    const user = await registerUser();
    const outroDispositivo = await loginNoOutroDispositivo(user);

    // Antes da troca, o outro dispositivo renova normalmente.
    const antes = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE_NAME}=${outroDispositivo}`]);
    expect(antes.status).toBe(200);
    const rotacionado = cookieValue(getSetCookie(antes, REFRESH_COOKIE_NAME)!);

    expect((await trocarSenha(user, 'novaSenhaForte1')).status).toBe(200);

    // Depois da troca, o token mais recente daquele dispositivo morre.
    const depois = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE_NAME}=${rotacionado}`]);
    expect(depois.status).toBe(401);
  });

  it('invalida também o refresh token da sessão que originou a troca', async () => {
    // O token que o dispositivo tinha ANTES da troca não pode sobreviver: se ele
    // sobrevivesse, o invasor com uma cópia dele continuaria dentro.
    const user = await registerUser();
    const tokenAntigo = user.refreshToken;

    expect((await trocarSenha(user, 'novaSenhaForte1')).status).toBe(200);

    const response = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE_NAME}=${tokenAntigo}`]);
    expect(response.status).toBe(401);
  });

  it('revoga no banco todos os refresh tokens ativos do usuário', async () => {
    const user = await registerUser();
    await loginNoOutroDispositivo(user);
    await loginNoOutroDispositivo(user);

    const ativosAntes = await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
    expect(ativosAntes).toBe(3);

    expect((await trocarSenha(user, 'novaSenhaForte1')).status).toBe(200);

    // Sobra exatamente um ativo: o par reemitido pra quem trocou a senha.
    const ativosDepois = await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
    expect(ativosDepois).toBe(1);
  });

  it('reemite o par de tokens pro dispositivo que trocou a senha', async () => {
    const user = await registerUser();

    const response = await trocarSenha(user, 'novaSenhaForte1');

    expect(response.status).toBe(200);
    // Sem estes dois cookies novos, o usuário seria deslogado pela própria troca de
    // senha — e a primeira "correção" de alguém seria remover a revogação.
    expect(getSetCookie(response, AUTH_COOKIE_NAME)).toBeDefined();
    const novoRefresh = getSetCookie(response, REFRESH_COOKIE_NAME);
    expect(novoRefresh).toBeDefined();
    expect(cookieValue(novoRefresh!)).not.toBe(user.refreshToken);
  });

  it('o dispositivo que trocou a senha continua conseguindo renovar e usar a sessão', async () => {
    const user = await registerUser();

    expect((await trocarSenha(user, 'novaSenhaForte1')).status).toBe(200);

    // O agent guarda os cookies reemitidos: a sessão precisa seguir funcionando de
    // ponta a ponta, tanto pra renovar quanto pra chamar rota autenticada.
    const renovacao = await user.agent.post('/auth/refresh');
    expect(renovacao.status).toBe(200);

    const me = await user.agent.get('/users/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
  });

  it('não revoga nada quando a troca falha (senha atual errada)', async () => {
    const user = await registerUser();

    const response = await user.agent.patch('/users/me/password').send({
      currentPassword: 'senhaErrada1',
      newPassword: 'novaSenhaForte1',
      confirmNewPassword: 'novaSenhaForte1',
    });
    expect(response.status).toBe(401);

    // Errar a senha atual não pode derrubar as sessões de ninguém — senão vira um
    // jeito barato de deslogar o dono da conta.
    const ativos = await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
    expect(ativos).toBe(1);
  });
});
