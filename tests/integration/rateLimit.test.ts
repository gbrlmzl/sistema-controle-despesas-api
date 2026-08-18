import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import app from '../../src/app.js';
import { buildLimiter } from '../../src/middlewares/rateLimit.js';

// Os limitadores reais ficam desarmados em NODE_ENV=test (senão a suíte de integração,
// que dispara dezenas de requisições nas mesmas rotas de propósito, testaria o
// limitador em vez do endpoint). Aqui eles são montados à mão com `skip: () => false`
// pra exercitar o comportamento de verdade.
function appWithLimiter(options: Parameters<typeof buildLimiter>[1]): Express {
  const testApp = express();
  // Mesmo valor de produção — é o que faz o limitador enxergar o IP real do cliente
  // em vez do IP do proxy (SEC-02).
  testApp.set('trust proxy', 1);
  testApp.use(buildLimiter('teste', { skip: () => false, ...options }));
  testApp.post('/recurso', (req: Request, res: Response) => {
    // Permite simular resposta de erro, pra exercitar skipSuccessfulRequests.
    const status = Number(req.query.status ?? 200);
    res.status(status).json({ ok: status < 400 });
  });
  return testApp;
}

describe('rate limiting (SEC-01)', () => {
  it('libera requisições até o limite e responde 429 depois disso', async () => {
    const limited = appWithLimiter({ windowMs: 60_000, limit: 3 });

    for (let i = 0; i < 3; i++) {
      const allowed = await request(limited).post('/recurso');
      expect(allowed.status).toBe(200);
    }

    const blocked = await request(limited).post('/recurso');
    expect(blocked.status).toBe(429);
  });

  it('responde o 429 em JSON, no mesmo formato de erro do resto da API', async () => {
    const limited = appWithLimiter({
      windowMs: 60_000,
      limit: 1,
      message: { message: 'Muitas tentativas.' },
    });

    await request(limited).post('/recurso');
    const blocked = await request(limited).post('/recurso');

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ message: 'Muitas tentativas.' });
  });

  // O formato draft-7 manda um header combinado (`RateLimit: limit=..., remaining=...`)
  // mais o `RateLimit-Policy`, em vez dos RateLimit-Limit/Remaining/Reset separados do
  // draft-6. É o que permite ao front saber quanto de cota resta sem ter que errar.
  it('expõe os headers padrão do draft-7 e não os legados X-RateLimit-*', async () => {
    const limited = appWithLimiter({ windowMs: 60_000, limit: 5 });

    const response = await request(limited).post('/recurso');

    expect(response.headers['ratelimit']).toBe('limit=5, remaining=4, reset=60');
    expect(response.headers['ratelimit-policy']).toBe('5;w=60');
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('com skipSuccessfulRequests, só as respostas de erro gastam cota', async () => {
    const limited = appWithLimiter({ windowMs: 60_000, limit: 2, skipSuccessfulRequests: true });

    // Dez sucessos seguidos não consomem nada — é o caso do usuário legítimo que
    // acerta a senha várias vezes.
    for (let i = 0; i < 10; i++) {
      const allowed = await request(limited).post('/recurso');
      expect(allowed.status).toBe(200);
    }

    // Já as falhas contam: duas passam, a terceira é barrada.
    expect((await request(limited).post('/recurso?status=401')).status).toBe(401);
    expect((await request(limited).post('/recurso?status=401')).status).toBe(401);
    expect((await request(limited).post('/recurso?status=401')).status).toBe(429);
  });

  it('sem skipSuccessfulRequests, o sucesso também gasta cota (caso do registro)', async () => {
    const limited = appWithLimiter({ windowMs: 60_000, limit: 2 });

    expect((await request(limited).post('/recurso')).status).toBe(200);
    expect((await request(limited).post('/recurso')).status).toBe(200);
    // Se o registro ignorasse sucessos, criar contas em massa passaria livre.
    expect((await request(limited).post('/recurso')).status).toBe(429);
  });

  // Este é o teste do SEC-02: prova que o limite é por cliente real e não por proxy.
  // Sem `trust proxy`, todos os X-Forwarded-For abaixo cairiam no mesmo balde e o
  // segundo IP já começaria bloqueado — o limitador viraria negação de serviço contra
  // os próprios usuários.
  it('conta por IP real do cliente (X-Forwarded-For), não pelo IP do proxy', async () => {
    const limited = appWithLimiter({ windowMs: 60_000, limit: 2 });

    await request(limited).post('/recurso').set('X-Forwarded-For', '203.0.113.10');
    await request(limited).post('/recurso').set('X-Forwarded-For', '203.0.113.10');

    const primeiroIpBloqueado = await request(limited).post('/recurso').set('X-Forwarded-For', '203.0.113.10');
    expect(primeiroIpBloqueado.status).toBe(429);

    // Outro cliente, atrás do mesmo proxy, começa com a cota cheia.
    const outroIp = await request(limited).post('/recurso').set('X-Forwarded-For', '198.51.100.7');
    expect(outroIp.status).toBe(200);
  });
});

describe('configuração do app (SEC-02)', () => {
  it('confia em exatamente um proxy à frente', () => {
    // `true` confiaria na cadeia inteira de X-Forwarded-For, e como qualquer cliente
    // pode enviar esse header, bastaria trocá-lo a cada requisição pra escapar do
    // limite. O valor precisa continuar sendo 1.
    expect(app.get('trust proxy')).toBe(1);
  });
});
