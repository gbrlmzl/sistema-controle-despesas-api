import request from 'supertest';
import app from '../../src/app.js';
import { env } from '../../src/config/env.js';
import prisma from '../../src/config/prisma.js';

const TEST_EMAIL_DOMAIN = 'security-integration-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function registerUser() {
  const agent = request.agent(app);
  const username = `u${uniqueSuffix()}`.slice(0, 20);

  await agent.post('/auth/register').send({
    name: 'Usuário de Segurança',
    username,
    email: `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
    password: 'senhaForte1',
    confirmPassword: 'senhaForte1',
  });

  return agent;
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('cabeçalhos de segurança (SEC-05)', () => {
  it('não entrega a stack no X-Powered-By', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('manda HSTS incluindo subdomínios, mas sem preload', async () => {
    const response = await request(app).get('/health');

    // preload é praticamente irreversível e vale pro domínio inteiro — fica de fora
    // até todo o ambiente estar estável em HTTPS.
    expect(response.headers['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
  });

  it('manda nosniff, para o navegador não adivinhar o content-type', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('limite de corpo da requisição (SEC-11)', () => {
  it('recusa corpo acima de 32kb com 413, não com 500', async () => {
    // ~64kb de JSON válido: passa do limite sem depender de nenhuma rota específica,
    // porque o express.json() roda antes do roteamento.
    const payload = { username: 'a'.repeat(64 * 1024), password: 'x' };

    const response = await request(app).post('/auth/login').send(payload);

    expect(response.status).toBe(413);
    expect(response.body.message).toBe('Corpo da requisição excede o tamanho máximo permitido.');
  });

  it('aceita normalmente um corpo dentro do limite', async () => {
    // Mesma rota, corpo pequeno: 401 (credenciais inválidas) prova que a requisição
    // chegou ao controller em vez de morrer no parser.
    const response = await request(app)
      .post('/auth/login')
      .send({ username: 'naoexiste123', password: 'senhaQualquer1' });

    expect(response.status).toBe(401);
  });

  it('recusa JSON malformado com 400 e mensagem própria, sem o texto cru do parser', async () => {
    const response = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"username": "alguem",}');

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Corpo da requisição não é um JSON válido.');
    // O texto do parser ("Unexpected token...") não pode vazar.
    expect(response.body.message).not.toContain('Unexpected');
  });
});

describe('teto de paginação em /notifications (SEC-07)', () => {
  it('recusa limit acima do teto de 100', async () => {
    const agent = await registerUser();

    // Sem teto, isso viraria take: 1000000 direto no Postgres.
    const response = await agent.get('/notifications?limit=1000000');

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Limite inválido. Informe um valor entre 1 e 100.');
  });

  it('aceita limit dentro do teto', async () => {
    const agent = await registerUser();

    const response = await agent.get('/notifications?limit=100');

    expect(response.status).toBe(200);
  });

  it('recusa lista de ids acima de 200 no PATCH', async () => {
    const agent = await registerUser();

    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const response = await agent.patch('/notifications').send({ ids });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Informe no máximo 200 notificações por vez');
  });

  it('aceita lista de ids dentro do teto', async () => {
    const agent = await registerUser();

    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const response = await agent.patch('/notifications').send({ ids });

    expect(response.status).toBe(200);
  });
});

function setCookie(response: request.Response, name: string): string | undefined {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((cookie) => cookie.startsWith(`${name}=`));
}

describe('CORS', () => {
  it('não reflete a origem que o cliente mandou', async () => {
    // Esta é a falha crítica clássica em API com credentials: ecoar o Origin recebido
    // faz qualquer site conseguir ler resposta autenticada do usuário. O valor tem que
    // ser sempre o front configurado, aconteça o que acontecer.
    const response = await request(app).get('/notifications').set('Origin', 'https://site-malicioso.example');

    expect(response.headers['access-control-allow-origin']).not.toBe('https://site-malicioso.example');
    expect(response.headers['access-control-allow-origin']).toBe(env.FRONTEND_URL);
  });

  it('libera credenciais apenas junto de uma origem específica', async () => {
    const response = await request(app).get('/notifications').set('Origin', env.FRONTEND_URL);

    expect(response.headers['access-control-allow-credentials']).toBe('true');
    // Origem específica + credentials é a combinação segura; '*' com credentials é
    // inclusive rejeitado pelos navegadores.
    expect(response.headers['access-control-allow-origin']).toBe(env.FRONTEND_URL);
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('responde o preflight sem vazar a origem do solicitante', async () => {
    const response = await request(app)
      .options('/auth/login')
      .set('Origin', 'https://site-malicioso.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBe(env.FRONTEND_URL);
  });
});

describe('atributos de segurança dos cookies de sessão', () => {
  it('emite JWT e REFRESH como HttpOnly e SameSite=Lax', async () => {
    const response = await request(app).post('/auth/register').send({
      name: 'Usuário Cookie',
      username: `u${uniqueSuffix()}`.slice(0, 20),
      email: `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
      password: 'senhaForte1',
      confirmPassword: 'senhaForte1',
    });

    expect(response.status).toBe(201);

    const access = setCookie(response, 'JWT');
    const refresh = setCookie(response, 'REFRESH');

    // HttpOnly é o que impede JavaScript de ler o token — a defesa contra XSS roubar
    // a sessão.
    expect(access).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/HttpOnly/i);

    // SameSite=Lax é o que segura CSRF: POST/fetch vindos de outro site não levam o
    // cookie junto.
    expect(access).toMatch(/SameSite=Lax/i);
    expect(refresh).toMatch(/SameSite=Lax/i);
  });

  it('em produção, os dois cookies ganham a flag Secure', async () => {
    // A flag Secure é decidida em tempo de requisição lendo env.NODE_ENV, então dá pra
    // trocar o valor no objeto já validado e devolver depois.
    const realNodeEnv = env.NODE_ENV;
    env.NODE_ENV = 'production';

    try {
      const response = await request(app)
        // NODE_ENV != 'test' também arma os limitadores, então este cenário usa um IP
        // próprio pra não gastar cota dos outros testes.
        .post('/auth/register')
        .set('X-Forwarded-For', '198.51.100.77')
        .send({
          name: 'Usuário Cookie Seguro',
          username: `u${uniqueSuffix()}`.slice(0, 20),
          email: `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
          password: 'senhaForte1',
          confirmPassword: 'senhaForte1',
        });

      expect(response.status).toBe(201);
      // Sem Secure, o cookie viajaria também em HTTP — e um downgrade num Wi-Fi hostil
      // entregaria a sessão em texto claro.
      expect(setCookie(response, 'JWT')).toMatch(/Secure/i);
      expect(setCookie(response, 'REFRESH')).toMatch(/Secure/i);
    } finally {
      env.NODE_ENV = realNodeEnv;
    }
  });

  it('o refresh token vale para todo o site, não só para /auth', async () => {
    const response = await request(app).post('/auth/register').send({
      name: 'Usuário Path',
      username: `u${uniqueSuffix()}`.slice(0, 20),
      email: `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
      password: 'senhaForte1',
      confirmPassword: 'senhaForte1',
    });

    // Path=/ é deliberado: o front chama o refresh por um rewrite same-origin
    // ('/api/auth/refresh'), então um cookie preso a '/auth' nunca seria anexado.
    // HttpOnly é que protege o valor; Path aqui não acrescentaria segurança.
    expect(setCookie(response, 'REFRESH')).toMatch(/Path=\//i);
  });
});
