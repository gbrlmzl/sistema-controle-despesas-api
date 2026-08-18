import { jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { env } from '../../src/config/env.js';
import { errorHandler, notFoundHandler } from '../../src/middlewares/errorHandler.js';
import { AppError } from '../../src/utils/AppError.js';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockRequest(overrides: Partial<Request> = {}): Request {
  return { method: 'GET', originalUrl: '/qualquer', ...overrides } as Request;
}

describe('errorHandler', () => {
  it('AppError: responde com o statusCode e a mensagem do próprio erro', () => {
    const res = mockResponse();
    errorHandler(new AppError(409, 'Conflito.'), mockRequest(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'Conflito.' });
  });

  it('erro inesperado (não-AppError): responde 500 com a mensagem do erro e loga', () => {
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = mockResponse();

    errorHandler(new Error('Falha inesperada no banco.'), mockRequest(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Falha inesperada no banco.' });
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('valor lançado que não é Error: responde 500 com mensagem genérica', () => {
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = mockResponse();

    errorHandler('string qualquer', mockRequest(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Erro interno do servidor.' });

    logSpy.mockRestore();
  });
});

describe('notFoundHandler', () => {
  it('responde 404 com o método e o path da rota inexistente', () => {
    const res = mockResponse();
    notFoundHandler(mockRequest({ method: 'POST', originalUrl: '/rota-fantasma' }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Rota não encontrada: POST /rota-fantasma' });
  });
});

describe('errorHandler em produção (SEC-04)', () => {
  // O errorHandler decide o que expor lendo env.NODE_ENV em tempo de requisição, então
  // dá pra trocar o valor no objeto já validado e devolver depois. É mais direto que
  // mockar o módulo inteiro de config em ESM.
  const realNodeEnv = env.NODE_ENV;

  beforeEach(() => {
    env.NODE_ENV = 'production';
  });

  afterEach(() => {
    env.NODE_ENV = realNodeEnv;
  });

  it('não vaza a mensagem interna de um erro inesperado', () => {
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = mockResponse();

    // Uma mensagem de erro do Prisma entrega nome de tabela, coluna e constraint —
    // reconhecimento gratuito pra quem estiver sondando a API.
    errorHandler(
      new Error('Unique constraint failed on the fields: (`email`) in table `User`'),
      mockRequest(),
      res,
      jest.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Erro interno do servidor.' });

    logSpy.mockRestore();
  });

  it('continua registrando o detalhe real no log, mesmo escondendo do cliente', () => {
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = mockResponse();

    errorHandler(new Error('detalhe sensível do banco'), mockRequest(), res, jest.fn());

    const logged = logSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('detalhe sensível do banco');

    logSpy.mockRestore();
  });

  it('AppError continua expondo a própria mensagem — ela é escrita por nós', () => {
    const res = mockResponse();

    errorHandler(new AppError(409, 'Este usuário já existe!'), mockRequest(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ message: 'Este usuário já existe!' });
  });
});

describe('errorHandler com falha de corpo do cliente (SEC-04/SEC-11)', () => {
  it('corpo acima do limite vira 413, não 500', () => {
    const res = mockResponse();
    const tooLarge = Object.assign(new Error('request entity too large'), { type: 'entity.too.large' });

    errorHandler(tooLarge, mockRequest(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Corpo da requisição excede o tamanho máximo permitido.',
    });
  });

  it('JSON malformado vira 400 com mensagem própria, sem o texto cru do parser', () => {
    const res = mockResponse();
    const parseFailed = Object.assign(new Error('Unexpected token } in JSON at position 42'), {
      type: 'entity.parse.failed',
    });

    errorHandler(parseFailed, mockRequest(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Corpo da requisição não é um JSON válido.' });
  });
});
