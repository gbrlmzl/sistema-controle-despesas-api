import { jest } from '@jest/globals';
import type { Request, Response } from 'express';
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
