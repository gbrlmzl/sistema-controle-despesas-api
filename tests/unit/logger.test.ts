import { jest } from '@jest/globals';
import { env } from '../../src/config/env.js';
import { logSecurityEvent } from '../../src/utils/logger.js';

// SEC-10 -> O que estes testes travam é o FORMATO, porque é dele que depende o valor do
// item: uma linha, um objeto JSON, chaves estáveis. É isso que permite um metric filter
// no CloudWatch (`{ $.event = "login_failed" }`) e um alarme em cima dele. Texto livre
// não é mensurável, e um log que não vira métrica não avisa ninguém.
//
// O logger é silencioso em NODE_ENV=test (senão a suíte de integração, que erra senha
// dezenas de vezes de propósito, encheria o relatório do Jest). Mutar para 'production'
// é o que exercita o caminho real — mesmo padrão de tests/unit/errorHandler.test.ts.
function comLoggerAtivo<T>(fn: (warn: jest.Mock) => T): T {
  const originalEnv = env.NODE_ENV;
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    env.NODE_ENV = 'production';
    return fn(warn as unknown as jest.Mock);
  } finally {
    env.NODE_ENV = originalEnv;
    warn.mockRestore();
  }
}

function eventoEmitido(warn: jest.Mock): Record<string, unknown> {
  const [linha] = warn.mock.calls.at(-1) as [string];
  return JSON.parse(linha) as Record<string, unknown>;
}

describe('logSecurityEvent (SEC-10)', () => {
  it('emite uma única linha, e essa linha é um JSON válido', () => {
    comLoggerAtivo((warn) => {
      logSecurityEvent('login_failed', { ip: '203.0.113.9', username: 'alvo' });

      expect(warn).toHaveBeenCalledTimes(1);
      const [linha] = warn.mock.calls[0] as [string];

      // Quebra de linha no meio do evento partiria o registro em dois no CloudWatch, e
      // o metric filter não casaria com nenhum dos pedaços.
      expect(linha).not.toContain('\n');
      expect(() => JSON.parse(linha)).not.toThrow();
    });
  });

  it('carrega as chaves que o metric filter usa: level, event e timestamp', () => {
    comLoggerAtivo((warn) => {
      logSecurityEvent('refresh_token_reuse', {});
      const evento = eventoEmitido(warn);

      expect(evento.level).toBe('security');
      expect(evento.event).toBe('refresh_token_reuse');
      expect(typeof evento.timestamp).toBe('string');
      expect(new Date(evento.timestamp as string).toISOString()).toBe(evento.timestamp);
    });
  });

  it('repassa os detalhes do evento no mesmo nível do objeto', () => {
    comLoggerAtivo((warn) => {
      logSecurityEvent('rate_limit_exceeded', { ip: '198.51.100.4', limiter: 'login', limit: 8 });
      const evento = eventoEmitido(warn);

      // Aninhar os detalhes obrigaria o metric filter a saber o caminho completo;
      // no mesmo nível, `$.ip` funciona pra qualquer evento.
      expect(evento.ip).toBe('198.51.100.4');
      expect(evento.limiter).toBe('login');
      expect(evento.limit).toBe(8);
    });
  });

  it('escapa conteúdo controlado pelo atacante em vez de deixá-lo forjar uma linha', () => {
    comLoggerAtivo((warn) => {
      // O username vem do corpo da requisição. Se fosse concatenado em texto, isto
      // injetaria um evento falso no log — inclusive um que baixaria a contagem do
      // alarme. Como o registro é JSON.stringify de um objeto, vira só uma string.
      logSecurityEvent('login_failed', { username: 'ze"}\n{"level":"security","event":"forjado' });
      const evento = eventoEmitido(warn);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(evento.event).toBe('login_failed');
      expect(evento.username).toContain('forjado');
    });
  });

  it('fica quieto em NODE_ENV=test, pra não poluir o relatório da suíte', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(env.NODE_ENV).toBe('test');
      logSecurityEvent('login_failed', { ip: '203.0.113.1' });

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
