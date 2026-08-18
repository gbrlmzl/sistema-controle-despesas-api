import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../../src/app.js';
import { env } from '../../src/config/env.js';
import prisma from '../../src/config/prisma.js';
import { REFRESH_COOKIE_NAME } from '../../src/middlewares/auth.js';
import { LOGIN_LIMIT } from '../../src/middlewares/rateLimit.js';

// SEC-10 -> Os três eventos que fazem um ataque aparecer no CloudWatch. Os testes vão
// pelo HTTP de propósito: o que precisa ser provado não é que logSecurityEvent formata
// JSON (isso é tests/unit/logger.test.ts), é que a chamada está LIGADA no caminho real
// e que o IP chega até ela — o dado que só existe no `req` e que a camada de serviço
// não recebe.
//
// O logger é silencioso em NODE_ENV=test, então cada asserção roda com env.NODE_ENV
// mutado para 'production' e restaurado no finally (mesmo padrão de
// tests/unit/errorHandler.test.ts). Efeito colateral documentado: isso ARMA os
// limitadores de requisição — por isso cada cenário usa um X-Forwarded-For próprio,
// pra não gastar a cota dos outros.

const TEST_EMAIL_DOMAIN = 'security-events-integration-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

interface EventoDeSeguranca {
  level: string;
  event: string;
  [key: string]: unknown;
}

// Roda o corpo com o logger ativo e devolve os eventos emitidos, já parseados.
//
// As linhas são acumuladas dentro da própria implementação do mock, e não lidas de
// `warn.mock.calls` depois: mockRestore() limpa o histórico junto com a restauração, e
// a lista voltaria vazia — o que deixaria os testes negativos verdes por acidente.
async function eventosDe(fn: () => Promise<void>): Promise<EventoDeSeguranca[]> {
  const originalEnv = env.NODE_ENV;
  const linhas: string[] = [];
  const warn = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string') {
      linhas.push(args[0]);
    }
  });

  try {
    env.NODE_ENV = 'production';
    await fn();
  } finally {
    env.NODE_ENV = originalEnv;
    warn.mockRestore();
  }

  return linhas.map((linha) => JSON.parse(linha) as EventoDeSeguranca);
}

const doTipo = (eventos: EventoDeSeguranca[], nome: string) => eventos.filter((e) => e.event === nome);

function getSetCookie(response: request.Response, name: string): string | undefined {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${name}=`));
}

function cookieValue(setCookieHeader: string): string {
  return setCookieHeader.split(';')[0]!.split('=')[1]!;
}

interface Registered {
  id: number;
  username: string;
  password: string;
  refreshToken: string;
}

// O cadastro acontece com o logger silencioso (NODE_ENV=test) de propósito: só a ação
// sob teste deve aparecer na lista de eventos.
async function registerUser(): Promise<Registered> {
  const username = `u${uniqueSuffix()}`.slice(0, 20);
  const password = 'senhaForte1';

  const response = await request(app).post('/auth/register').send({
    name: 'Usuário de Eventos',
    username,
    email: `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`,
    password,
    confirmPassword: password,
  });

  return {
    id: response.body.user.id,
    username,
    password,
    refreshToken: cookieValue(getSetCookie(response, REFRESH_COOKIE_NAME)!),
  };
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('login falho é registrado (SEC-10)', () => {
  it('registra o IP e o username tentado quando a senha está errada', async () => {
    const user = await registerUser();
    const ip = '203.0.113.40';

    const eventos = await eventosDe(async () => {
      const response = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ username: user.username, password: 'senhaErrada1' });

      expect(response.status).toBe(401);
    });

    const [falha] = doTipo(eventos, 'login_failed');
    expect(falha).toBeDefined();
    // O IP é o do cliente real, não o do proxy — é o SEC-02 chegando até o log. Sem
    // isso o evento não serve pra nada: todo ataque apareceria vindo do balanceador.
    expect(falha!.ip).toBe(ip);
    expect(falha!.username).toBe(user.username);
    expect(falha!.reason).toBe('invalid_password');
    expect(falha!.userId).toBe(user.id);
  });

  it('distingue username inexistente de senha errada — são ataques diferentes', async () => {
    // Varredura de usernames e força bruta de senha se parecem na resposta HTTP (as
    // duas dão 401 com a mesma mensagem, e isso é intencional). No log elas precisam
    // ser distinguíveis, senão não dá pra saber o que está acontecendo.
    const eventos = await eventosDe(async () => {
      const response = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', '203.0.113.41')
        .send({ username: 'naoexisteninguem', password: 'chuteQualquer1' });

      expect(response.status).toBe(401);
    });

    const [falha] = doTipo(eventos, 'login_failed');
    expect(falha!.reason).toBe('user_not_found');
    expect(falha!.userId).toBeUndefined();
  });

  it('nunca registra a senha tentada', async () => {
    const user = await registerUser();
    const senhaTentada = 'senhaSecretaDoAtacante1';

    const eventos = await eventosDe(async () => {
      await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', '203.0.113.42')
        .send({ username: user.username, password: senhaTentada });
    });

    // Log de segurança que vaza senha vira o próprio incidente: um dump de tentativas
    // de login é um dicionário de senhas reais de usuários reais.
    expect(JSON.stringify(eventos)).not.toContain(senhaTentada);
  });

  it('não registra nada quando o login dá certo', async () => {
    const user = await registerUser();

    const eventos = await eventosDe(async () => {
      const response = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', '203.0.113.43')
        .send({ username: user.username, password: user.password });

      expect(response.status).toBe(200);
    });

    // Um alarme que dispara com uso normal é desligado na primeira semana.
    expect(doTipo(eventos, 'login_failed')).toHaveLength(0);
  });
});

describe('reuso de refresh token é registrado (SEC-10)', () => {
  it('registra o evento quando um token já revogado é reapresentado', async () => {
    const user = await registerUser();
    const ip = '203.0.113.44';

    // Rotaciona uma vez: o token original passa a estar revogado. Reapresentá-lo é,
    // por definição, alguém usando uma cópia — é roubo confirmado, não suspeita.
    const rotacao = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE_NAME}=${user.refreshToken}`]);
    expect(rotacao.status).toBe(200);

    const eventos = await eventosDe(async () => {
      const reuso = await request(app)
        .post('/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${user.refreshToken}`]);

      expect(reuso.status).toBe(401);
    });

    const [evento] = doTipo(eventos, 'refresh_token_reuse');
    expect(evento).toBeDefined();
    expect(evento!.ip).toBe(ip);
    expect(evento!.userId).toBe(user.id);
    // O familyId é o que permite achar no banco todas as linhas derrubadas junto.
    expect(typeof evento!.familyId).toBe('string');
  });

  it('registra só um prefixo do hash, nunca o valor do token', async () => {
    const user = await registerUser();

    const rotacao = await request(app)
      .post('/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE_NAME}=${user.refreshToken}`]);
    expect(rotacao.status).toBe(200);

    const eventos = await eventosDe(async () => {
      await request(app)
        .post('/auth/refresh')
        .set('X-Forwarded-For', '203.0.113.45')
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${user.refreshToken}`]);
    });

    const [evento] = doTipo(eventos, 'refresh_token_reuse');
    // Quem lê o log precisa correlacionar a linha do banco, não reusar a credencial.
    // O token cru no log seria uma sessão válida em texto puro no CloudWatch.
    expect(JSON.stringify(evento)).not.toContain(user.refreshToken);
    expect(String(evento!.tokenHashPrefix)).toHaveLength(12);
  });

  it('não registra reuso numa rotação legítima', async () => {
    const user = await registerUser();

    const eventos = await eventosDe(async () => {
      const response = await request(app)
        .post('/auth/refresh')
        .set('X-Forwarded-For', '203.0.113.46')
        .set('Cookie', [`${REFRESH_COOKIE_NAME}=${user.refreshToken}`]);

      expect(response.status).toBe(200);
    });

    expect(doTipo(eventos, 'refresh_token_reuse')).toHaveLength(0);
  });
});

describe('bloqueio por rate limit é registrado (SEC-10)', () => {
  it('registra o evento com o limitador que barrou, o IP e a rota', async () => {
    const ip = '203.0.113.47';

    const eventos = await eventosDe(async () => {
      // Mutar NODE_ENV pra 'production' arma os limitadores reais; a tentativa
      // seguinte ao limite é a que deve ser barrada.
      for (let i = 0; i < LOGIN_LIMIT; i++) {
        const tentativa = await request(app)
          .post('/auth/login')
          .set('X-Forwarded-For', ip)
          .send({ username: 'naoexisteninguem', password: 'chuteErrado1' });
        expect(tentativa.status).toBe(401);
      }

      const bloqueada = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ username: 'naoexisteninguem', password: 'chuteErrado1' });

      expect(bloqueada.status).toBe(429);
      // A resposta continua a mesma de antes do log — o handler customizado não pode
      // ter mudado o contrato do endpoint.
      expect(bloqueada.body.message).toContain('Muitas tentativas de login');
      expect(bloqueada.headers['retry-after']).toBeDefined();
    });

    const [bloqueio] = doTipo(eventos, 'rate_limit_exceeded');
    expect(bloqueio).toBeDefined();
    expect(bloqueio!.ip).toBe(ip);
    // Sem o nome, "429 em /auth/login" pode ser o limitador de login ou o teto global —
    // e o número significa coisas bem diferentes em cada caso.
    expect(bloqueio!.limiter).toBe('login');
    expect(bloqueio!.method).toBe('POST');
    expect(bloqueio!.path).toBe('/auth/login');
  });

  it('não registra bloqueio enquanto o tráfego está dentro do limite', async () => {
    const ip = '203.0.113.48';

    const eventos = await eventosDe(async () => {
      const response = await request(app)
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ username: 'naoexisteninguem', password: 'chuteErrado1' });

      expect(response.status).toBe(401);
    });

    expect(doTipo(eventos, 'rate_limit_exceeded')).toHaveLength(0);
  });
});
