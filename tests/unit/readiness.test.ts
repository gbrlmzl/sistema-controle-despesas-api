import { jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { createReadinessHandler, type ReadinessDependencies } from '../../src/utils/readiness.js';

// SEC-17 -> O desfecho que importa é o do banco fora do ar, e é justamente o que não dá
// pra exercitar numa integração sem derrubar o Postgres no meio da suíte. Com o ping
// injetado, os dois caminhos ficam cobertos aqui; a integração cobre a fiação real.

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
}

function deps(overrides: Partial<ReadinessDependencies> = {}): ReadinessDependencies {
  return {
    ping: jest.fn(async () => [{ '?column?': 1 }]) as ReadinessDependencies['ping'],
    logError: jest.fn() as ReadinessDependencies['logError'],
    ...overrides,
  };
}

const noop = jest.fn();

describe('createReadinessHandler (SEC-17)', () => {
  it('responde 200 quando o banco responde', async () => {
    const d = deps();
    const res = mockResponse();

    await createReadinessHandler(d)({} as Request, res, noop);

    expect(d.ping).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'ready' });
  });

  it('responde 503 — e não 500 — quando o banco não responde', async () => {
    // 503 é o status que diz "estou de pé, mas não me mande tráfego". É o que faz o
    // ALB tirar a task do balanceamento em vez de alguém tratá-la como bug da app.
    const d = deps({ ping: jest.fn(async () => { throw new Error('conexão recusada'); }) as ReadinessDependencies['ping'] });
    const res = mockResponse();

    await createReadinessHandler(d)({} as Request, res, noop);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: 'unavailable' });
  });

  it('não devolve a mensagem do erro do banco na resposta', async () => {
    // Mesmo raciocínio do SEC-04: o erro do Prisma entrega host, porta e nome do banco.
    // E /ready é o endpoint que um scanner encontra primeiro.
    const segredo = 'connect ECONNREFUSED db-interno.prod.local:5432';
    const d = deps({ ping: jest.fn(async () => { throw new Error(segredo); }) as ReadinessDependencies['ping'] });
    const res = mockResponse();

    await createReadinessHandler(d)({} as Request, res, noop);

    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain('db-interno');
    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain('5432');
  });

  it('registra a falha no log, com contexto', async () => {
    // Sem isto, a task sai do balanceamento e ninguém descobre por quê.
    const falha = new Error('conexão recusada');
    const d = deps({ ping: jest.fn(async () => { throw falha; }) as ReadinessDependencies['ping'] });

    await createReadinessHandler(d)({} as Request, mockResponse(), noop);

    expect(d.logError).toHaveBeenCalledWith(falha, 'GET /ready');
  });

  it('não deixa o erro escapar pro errorHandler', async () => {
    // Se o handler rejeitasse, o Express 5 mandaria pro errorHandler e a resposta viraria
    // 500 — que o ALB trata como "task quebrada", não como "task ocupada".
    const d = deps({ ping: jest.fn(async () => { throw new Error('qualquer'); }) as ReadinessDependencies['ping'] });

    await expect(createReadinessHandler(d)({} as Request, mockResponse(), noop)).resolves.toBeUndefined();
    expect(noop).not.toHaveBeenCalled();
  });
});
