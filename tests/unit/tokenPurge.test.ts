import { jest } from '@jest/globals';
import { runTokenPurge, type TokenPurgeDependencies } from '../../src/utils/tokenPurge.js';

// SEC-09 -> O que este arquivo cobre é o INVÓLUCRO da purga: código de saída,
// desconexão e log. A remoção das linhas em si é exercitada contra o banco de verdade
// em tests/integration/refreshTokenPurge.test.ts.
//
// Dependências injetadas pelo mesmo motivo de utils/shutdown.ts: o entrypoint real
// (src/scripts/purgeTokens.ts) roda no escopo do módulo e chama process.exit —
// importá-lo aqui mataria o processo do Jest.

function deps(overrides: Partial<TokenPurgeDependencies> = {}) {
  return {
    purge: jest.fn(async () => 0) as TokenPurgeDependencies['purge'],
    disconnect: jest.fn(async () => undefined) as TokenPurgeDependencies['disconnect'],
    log: jest.fn() as TokenPurgeDependencies['log'],
    logError: jest.fn() as TokenPurgeDependencies['logError'],
    ...overrides,
  };
}

describe('runTokenPurge (SEC-09)', () => {
  it('sai com 0 e loga quantas linhas removeu', async () => {
    const d = deps({ purge: jest.fn(async () => 42) as TokenPurgeDependencies['purge'] });

    await expect(runTokenPurge(d)).resolves.toBe(0);

    // O número precisa aparecer no log: é a única evidência de que a task rodou e
    // fez alguma coisa — o EventBridge só registra que o container saiu.
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('42'));
  });

  it('desconecta do banco mesmo no caminho feliz', async () => {
    // Sem desconectar, o pool do Prisma segura o event loop e a task fica pendurada
    // até o orquestrador matá-la — o oposto de "roda e sai".
    const d = deps();

    await runTokenPurge(d);

    expect(d.disconnect).toHaveBeenCalledTimes(1);
  });

  it('sai com 1 quando a purga falha, e ainda assim desconecta', async () => {
    const falha = new Error('banco fora do ar');
    const d = deps({ purge: jest.fn(async () => { throw falha; }) as TokenPurgeDependencies['purge'] });

    // Código de saída diferente de zero é o que faz a execução aparecer como falha no
    // ECS. Uma limpeza que quebra em silêncio é pior que nenhuma limpeza.
    await expect(runTokenPurge(d)).resolves.toBe(1);
    expect(d.logError).toHaveBeenCalledWith(falha, 'purgeTokens');
    expect(d.disconnect).toHaveBeenCalledTimes(1);
  });

  it('sai com 1 quando a desconexão falha, mesmo com a purga bem-sucedida', async () => {
    const falha = new Error('conexão já encerrada');
    const d = deps({
      purge: jest.fn(async () => 3) as TokenPurgeDependencies['purge'],
      disconnect: jest.fn(async () => { throw falha; }) as TokenPurgeDependencies['disconnect'],
    });

    await expect(runTokenPurge(d)).resolves.toBe(1);
    expect(d.logError).toHaveBeenCalledWith(falha, 'purgeTokens/disconnect');
  });
});
