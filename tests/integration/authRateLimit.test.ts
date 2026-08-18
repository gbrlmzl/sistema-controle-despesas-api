import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';
import {
  GLOBAL_LIMIT,
  LOGIN_LIMIT,
  REGISTER_LIMIT,
  setRateLimitersArmedInTests,
} from '../../src/middlewares/rateLimit.js';

// tests/integration/rateLimit.test.ts prova que a biblioteca de rate limiting se
// comporta como esperado, montando limitadores próprios. Este arquivo é o
// complemento necessário: exercita os limitadores REAIS, montados nas rotas REAIS.
//
// Sem ele, alguém poderia remover `loginLimiter` de authRoutes.ts num refactor e a
// suíte inteira continuaria verde — a proteção some e nada acusa.
//
// Cada cenário usa um X-Forwarded-For próprio, porque o contador é por IP e é
// compartilhado entre os testes deste arquivo (os stores vivem no módulo). IPs
// distintos evitam que um teste gaste a cota do outro, sem precisar resetar store.

const TEST_EMAIL_DOMAIN = 'ratelimit-integration-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function validRegisterBody() {
  return {
    name: 'Usuário Rate Limit',
    username: `u${uniqueSuffix()}`.slice(0, 20),
    email: `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
    password: 'senhaForte1',
    confirmPassword: 'senhaForte1',
  };
}

beforeAll(() => {
  setRateLimitersArmedInTests(true);
});

afterAll(async () => {
  // Desarma de novo pra não contaminar nada que rode depois no mesmo processo.
  setRateLimitersArmedInTests(false);
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('POST /auth/login está protegido de força bruta (SEC-01)', () => {
  it(`bloqueia a partir da tentativa ${LOGIN_LIMIT + 1} com senha errada`, async () => {
    const ip = '203.0.113.20';

    for (let i = 1; i <= LOGIN_LIMIT; i++) {
      const attempt = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ username: 'naoexiste', password: 'chuteErrado1' });

      expect(attempt.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ username: 'naoexiste', password: 'chuteErrado1' });

    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/muitas tentativas/i);
  });

  it('login bem-sucedido não gasta cota, mesmo repetido além do limite', async () => {
    const ip = '203.0.113.21';
    const body = validRegisterBody();
    await request(app).post('/auth/register').set('X-Forwarded-For', '203.0.113.99').send(body);

    // Mais logins de sucesso do que o limite permitiria se sucesso contasse.
    for (let i = 0; i <= LOGIN_LIMIT; i++) {
      const ok = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ username: body.username, password: body.password });

      expect(ok.status).toBe(200);
    }
  });

  it('conta por IP: um cliente bloqueado não bloqueia os outros', async () => {
    const atacante = '203.0.113.22';
    const inocente = '203.0.113.23';

    for (let i = 0; i <= LOGIN_LIMIT; i++) {
      await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', atacante)
        .send({ username: 'naoexiste', password: 'chuteErrado1' });
    }

    const bloqueado = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', atacante)
      .send({ username: 'naoexiste', password: 'chuteErrado1' });
    expect(bloqueado.status).toBe(429);

    // Se `trust proxy` não estivesse configurado (SEC-02), este aqui também levaria
    // 429 — os dois cairiam no balde do IP do proxy.
    const naoBloqueado = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-For', inocente)
      .send({ username: 'naoexiste', password: 'chuteErrado1' });
    expect(naoBloqueado.status).toBe(401);
  });
});

describe('POST /auth/register está protegido de criação em massa (SEC-01)', () => {
  it(`bloqueia a partir da tentativa ${REGISTER_LIMIT + 1}`, async () => {
    const ip = '203.0.113.30';

    // Corpo inválido é rejeitado no schema, sem tocar bcrypt nem banco — mas continua
    // consumindo cota, que é o comportamento desejado.
    for (let i = 1; i <= REGISTER_LIMIT; i++) {
      const attempt = await request(app)
        .post('/auth/register')
        .set('X-Forwarded-For', ip)
        .send({ name: 'x', username: 'ab', email: 'invalido', password: '1', confirmPassword: '1' });

      expect(attempt.status).toBe(400);
    }

    const blocked = await request(app)
      .post('/auth/register')
      .set('X-Forwarded-For', ip)
      .send(validRegisterBody());

    expect(blocked.status).toBe(429);
  });

  it('cadastro BEM-SUCEDIDO também gasta cota — senão a fazenda de contas passa livre', async () => {
    const ip = '203.0.113.31';

    const criado = await request(app).post('/auth/register').set('X-Forwarded-For', ip).send(validRegisterBody());
    expect(criado.status).toBe(201);

    // Se o sucesso não contasse, sobrariam REGISTER_LIMIT tentativas aqui e a última
    // não seria bloqueada.
    for (let i = 1; i < REGISTER_LIMIT; i++) {
      await request(app)
        .post('/auth/register')
        .set('X-Forwarded-For', ip)
        .send({ name: 'x', username: 'ab', email: 'invalido', password: '1', confirmPassword: '1' });
    }

    const blocked = await request(app).post('/auth/register').set('X-Forwarded-For', ip).send(validRegisterBody());
    expect(blocked.status).toBe(429);
  });
});

describe('POST /auth/refresh tem limite próprio, mais folgado que o do login', () => {
  it(`aceita mais que ${LOGIN_LIMIT} tentativas (o front renova sozinho, com várias abas)`, async () => {
    const ip = '203.0.113.40';

    // Um limite de login (8) aplicado aqui bloquearia na 9ª. O limite do refresh é 30.
    for (let i = 0; i <= LOGIN_LIMIT + 2; i++) {
      const attempt = await request(app).post('/auth/refresh').set('X-Forwarded-For', ip);

      // 401 = sem cookie de refresh, que é o esperado. O que importa é não ser 429.
      expect(attempt.status).toBe(401);
    }
  });
});

describe('/health não pode ser bloqueado por rate limit', () => {
  it(`responde 200 mesmo além do limite global de ${GLOBAL_LIMIT} requisições`, async () => {
    const ip = '203.0.113.50';

    // /health é declarado antes do limitador global de propósito: quem chama é o health
    // check do load balancer, e um 429 aqui derrubaria uma instância saudável do
    // balanceamento — transformando a proteção em causa de indisponibilidade.
    for (let i = 0; i < GLOBAL_LIMIT + 10; i++) {
      const response = await request(app).get('/health').set('X-Forwarded-For', ip);
      expect(response.status).toBe(200);
    }
  });
});

describe('limitador global protege as demais rotas', () => {
  it(`bloqueia a partir da requisição ${GLOBAL_LIMIT + 1} numa rota qualquer`, async () => {
    const ip = '203.0.113.60';

    for (let i = 0; i < GLOBAL_LIMIT; i++) {
      const response = await request(app).get('/rota-que-nao-existe').set('X-Forwarded-For', ip);
      expect(response.status).toBe(404);
    }

    const blocked = await request(app).get('/rota-que-nao-existe').set('X-Forwarded-For', ip);
    expect(blocked.status).toBe(429);
  });
});
