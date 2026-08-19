import { jest } from '@jest/globals';
import { createShutdownHandler, type ShutdownDependencies } from '../../src/utils/shutdown.js';

// Fábrica de dependências controláveis: o `closeServer` só guarda o callback, pra que
// cada teste decida quando (e como) o servidor "termina" de fechar.
function makeDeps(overrides: Partial<ShutdownDependencies> = {}) {
  let closeCallback: ((err?: Error) => void) | undefined;

  const deps = {
    closeServer: jest.fn((cb: (err?: Error) => void) => {
      closeCallback = cb;
    }),
    disconnect: jest.fn(async () => undefined),
    exit: jest.fn((_code: number) => undefined),
    logError: jest.fn((_err: unknown, _context?: string) => undefined),
    log: jest.fn((_message: string) => undefined),
    ...overrides,
  } as unknown as ShutdownDependencies & {
    closeServer: jest.Mock;
    disconnect: jest.Mock;
    exit: jest.Mock;
    logError: jest.Mock;
    log: jest.Mock;
  };

  return {
    deps,
    // Simula o servidor terminando de fechar, com ou sem erro.
    finishClose: (err?: Error) => closeCallback?.(err),
  };
}

// O encerramento passa por uma Promise (prisma.$disconnect), então o exit só acontece
// depois que a microtask fila esvazia.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createShutdownHandler (SEC-08)', () => {
  it('fecha o servidor, desconecta do banco e sai com código 0', async () => {
    const { deps, finishClose } = makeDeps();
    const shutdown = createShutdownHandler(deps);

    shutdown('SIGTERM');

    expect(deps.closeServer).toHaveBeenCalledTimes(1);
    // O banco só é desconectado DEPOIS do servidor parar de aceitar conexões — o
    // contrário derrubaria o banco embaixo de requisições ainda em voo.
    expect(deps.disconnect).not.toHaveBeenCalled();

    finishClose();
    await flush();

    expect(deps.disconnect).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('anuncia no log qual sinal recebeu', () => {
    const { deps } = makeDeps();
    const shutdown = createShutdownHandler(deps);

    shutdown('SIGINT');

    expect(deps.log).toHaveBeenCalledWith('SIGINT recebido — encerrando com elegância.');
  });

  it('ignora um segundo sinal durante o encerramento', async () => {
    const { deps, finishClose } = makeDeps();
    const shutdown = createShutdownHandler(deps);

    // O orquestrador às vezes manda mais de um sinal. Reentrar aqui zeraria o timer de
    // guarda e chamaria server.close() duas vezes.
    shutdown('SIGTERM');
    shutdown('SIGTERM');
    shutdown('SIGINT');

    expect(deps.closeServer).toHaveBeenCalledTimes(1);

    finishClose();
    await flush();

    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('sai com código 1 e loga quando o servidor falha ao fechar', async () => {
    const { deps, finishClose } = makeDeps();
    const shutdown = createShutdownHandler(deps);

    shutdown('SIGTERM');
    finishClose(new Error('servidor já estava fechado'));
    await flush();

    expect(deps.logError).toHaveBeenCalledWith(expect.any(Error), 'shutdown/server.close');
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('ainda encerra se o disconnect do banco falhar', async () => {
    const { deps, finishClose } = makeDeps({
      disconnect: jest.fn(async () => {
        throw new Error('conexão já perdida');
      }) as unknown as ShutdownDependencies['disconnect'],
    });
    const shutdown = createShutdownHandler(deps);

    shutdown('SIGTERM');
    finishClose();
    await flush();

    // Falhar ao desconectar não pode travar o encerramento: o container precisa sair
    // antes do SIGKILL de qualquer forma.
    expect(deps.logError).toHaveBeenCalledWith(expect.any(Error), 'shutdown/prisma.$disconnect');
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('força a saída se o encerramento passar do tempo limite', () => {
    jest.useFakeTimers();

    try {
      // closeServer que nunca chama o callback: simula uma conexão keep-alive presa.
      const { deps } = makeDeps();
      const shutdown = createShutdownHandler({ ...deps, timeoutMs: 15_000 });

      shutdown('SIGTERM');
      expect(deps.exit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(15_000);

      // Perder o encerramento limpo é melhor que levar SIGKILL do orquestrador.
      expect(deps.logError).toHaveBeenCalledWith(expect.any(Error), 'shutdown');
      expect(deps.exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('não força a saída se o encerramento terminar antes do tempo limite', async () => {
    jest.useFakeTimers();

    try {
      const { deps, finishClose } = makeDeps();
      const shutdown = createShutdownHandler({ ...deps, timeoutMs: 15_000 });

      shutdown('SIGTERM');
      finishClose();
      await Promise.resolve().then(() => undefined);
      jest.advanceTimersByTime(60_000);

      // O timer de guarda precisa ter sido cancelado — senão o processo levaria um
      // exit(1) espúrio depois de já ter encerrado bem.
      expect(deps.exit).not.toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  // D-04 -> flushPendingWork espera os emails de recuperação de senha já disparados
  // (sem await) terminarem antes do servidor fechar.
  describe('flushPendingWork (D-04)', () => {
    it('aguarda flushPendingWork terminar antes de fechar o servidor', async () => {
      let resolveFlush: (() => void) | undefined;
      const flushPendingWork = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFlush = resolve;
          }),
      );

      const { deps, finishClose } = makeDeps({ flushPendingWork });
      const shutdown = createShutdownHandler(deps);

      shutdown('SIGTERM');
      await flush();

      // Ainda esperando o flush: o servidor não pode ter começado a fechar.
      expect(deps.closeServer).not.toHaveBeenCalled();

      resolveFlush?.();
      await flush();

      expect(deps.closeServer).toHaveBeenCalledTimes(1);
      finishClose();
      await flush();
      expect(deps.exit).toHaveBeenCalledWith(0);
    });

    it('não deixa um flushPendingWork travado impedir o encerramento (guarda própria)', async () => {
      jest.useFakeTimers();

      try {
        // Nunca resolve — simula um SMTP travado.
        const flushPendingWork = jest.fn(() => new Promise<void>(() => undefined));
        const { deps, finishClose } = makeDeps({ flushPendingWork });
        const shutdown = createShutdownHandler({ ...deps, flushTimeoutMs: 5_000, timeoutMs: 15_000 });

        shutdown('SIGTERM');
        expect(deps.closeServer).not.toHaveBeenCalled();

        // A guarda do flush (5s) vence bem antes da guarda geral (15s).
        jest.advanceTimersByTime(5_000);
        await Promise.resolve().then(() => Promise.resolve());

        expect(deps.closeServer).toHaveBeenCalledTimes(1);
        finishClose();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
