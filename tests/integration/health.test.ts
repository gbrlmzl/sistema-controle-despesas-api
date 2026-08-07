import request from 'supertest';
import app from '../../src/app.js';

describe('GET /health', () => {
  it('responde 200 com status ok', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('rota inexistente', () => {
  it('responde 404 com mensagem', async () => {
    const response = await request(app).get('/rota-que-nao-existe');

    expect(response.status).toBe(404);
    expect(response.body.message).toContain('Rota não encontrada');
  });
});
