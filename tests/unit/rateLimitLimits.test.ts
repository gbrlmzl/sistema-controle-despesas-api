import { env } from '../../src/config/env.js';
import { resolveLimit } from '../../src/middlewares/rateLimit.js';

// tests/integration/authRateLimit.test.ts prova que os limitadores estão montados nas
// rotas e barram na requisição certa. O que ele NÃO consegue provar é de onde veio o
// número: lá o ambiente é `test`, onde o override por variável de ambiente é ignorado
// de propósito. Este arquivo cobre exatamente essa decisão — que é o que separa
// "afrouxar um teto pro e2e orquestrado" de "desligar a proteção sem ninguém ver".
//
// O ambiente é mutado para 'production' e restaurado no finally, mesmo padrão de
// tests/unit/logger.test.ts.
function foraDeTest<T>(fn: () => T): T {
  const originalEnv = env.NODE_ENV;

  try {
    env.NODE_ENV = 'production';
    return fn();
  } finally {
    env.NODE_ENV = originalEnv;
  }
}

describe('resolveLimit (SEC-01)', () => {
  it('usa o padrão quando não há variável de ambiente', () => {
    expect(foraDeTest(() => resolveLimit('register', 10, undefined))).toBe(10);
  });

  it('usa o valor da variável de ambiente quando ela existe', () => {
    expect(foraDeTest(() => resolveLimit('register', 10, 500))).toBe(500);
  });

  it('afrouxa, mas continua sendo um teto — nunca vira "sem limite"', () => {
    // O contraste com rateLimitDisabled: ali o middleware não roda; aqui ele roda
    // sempre, só com outro número. Um override absurdo continua devolvendo um finito.
    expect(foraDeTest(() => resolveLimit('global', 120, 5000))).toBe(5000);
    expect(Number.isFinite(foraDeTest(() => resolveLimit('global', 120, 5000)))).toBe(true);
  });

  it('ignora o override em NODE_ENV=test, pro .env da máquina não mexer no que a suíte afirma', () => {
    // Sem isto, um RATE_LIMIT_REGISTER=500 no .env de quem roda os testes faria o
    // authRateLimit.test.ts disparar 500 cadastros num caso que promete parar em 10.
    expect(env.NODE_ENV).toBe('test');
    expect(resolveLimit('register', 10, 500)).toBe(10);
  });
});
