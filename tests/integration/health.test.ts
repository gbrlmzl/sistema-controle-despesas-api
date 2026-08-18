import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /health', () => {
  it('responde 200 com status ok', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

// SEC-17 -> Liveness e readiness são perguntas diferentes: /health responde "o processo
// está vivo?" (se não, reiniciar resolve) e /ready responde "dá pra atender agora?" (se
// não, tirar do balanceamento resolve). Trocar um pelo outro faz o ECS reiniciar tasks
// saudáveis em looping quando quem caiu foi o banco.
describe('GET /ready (SEC-17)', () => {
  it('responde 200 com status ready quando o banco responde', async () => {
    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });

  it('consulta o banco de verdade — é a única coisa que o distingue de /health', async () => {
    const querySpy = jest.spyOn(prisma, '$queryRaw');

    try {
      await request(app).get('/ready');
      expect(querySpy).toHaveBeenCalled();
    } finally {
      querySpy.mockRestore();
    }
  });
});

describe('GET /health não depende do banco (SEC-17)', () => {
  it('responde sem tocar no banco', async () => {
    // Este é o ponto do item: com o Postgres fora do ar, um /health que consultasse o
    // banco falharia e o ECS reiniciaria a task — sem que reiniciar resolvesse nada.
    const querySpy = jest.spyOn(prisma, '$queryRaw');

    try {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(querySpy).not.toHaveBeenCalled();
    } finally {
      querySpy.mockRestore();
    }
  });
});

describe('rota inexistente', () => {
  it('responde 404 com mensagem', async () => {
    const response = await request(app).get('/rota-que-nao-existe');

    expect(response.status).toBe(404);
    expect(response.body.message).toContain('Rota não encontrada');
  });
});
