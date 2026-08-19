// SEC-08 -> A lógica de encerramento vive aqui, e não em server.ts, porque server.ts
// chama app.listen() no escopo do módulo: importá-lo num teste subiria um servidor de
// verdade. Com as dependências injetadas, o comportamento fica exercitável sem tocar em
// process.exit nem abrir porta.

export interface ShutdownDependencies {
  closeServer: (callback: (err?: Error) => void) => void;
  disconnect: () => Promise<void>;
  exit: (code: number) => void;
  logError: (err: unknown, context?: string) => void;
  log?: (message: string) => void;
  // Deliberadamente menor que o stopTimeout padrão do ECS (30s), pra que o processo
  // encerre por vontade própria em vez de levar SIGKILL no meio do caminho.
  timeoutMs?: number;
  // D-04 -> espera os emails de recuperação de senha já disparados (sem await, ver
  // passwordResetService.flushPendingEmails) terminarem antes de fechar o servidor.
  // Opcional: sem esta dependência, o encerramento segue exatamente como antes.
  flushPendingWork?: () => Promise<void>;
  // Guarda PRÓPRIA, menor que timeoutMs: um SMTP travado não pode consumir o
  // orçamento inteiro reservado pra fechar o servidor e desconectar do Prisma.
  flushTimeoutMs?: number;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
export const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

export function createShutdownHandler(deps: ShutdownDependencies): (signal: string) => void {
  let shuttingDown = false;

  return function shutdown(signal: string): void {
    // Um segundo sinal durante o encerramento não pode reiniciar o processo todo — o
    // orquestrador às vezes manda mais de um, e reentrar aqui zeraria o timer de guarda.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    deps.log?.(`${signal} recebido — encerrando com elegância.`);

    // Se alguma conexão travar (requisição longa, keep-alive preso), não dá pra esperar
    // pra sempre: perder o encerramento limpo é melhor que levar SIGKILL.
    const forceExit = setTimeout(() => {
      deps.logError(new Error('Encerramento excedeu o tempo limite.'), 'shutdown');
      deps.exit(1);
    }, deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);

    // Este timer sozinho não deve segurar o event loop se tudo já fechou.
    forceExit.unref?.();

    function closeAndExit(): void {
      deps.closeServer((err) => {
        if (err) {
          deps.logError(err, 'shutdown/server.close');
        }

        deps
          .disconnect()
          .catch((disconnectError: unknown) => deps.logError(disconnectError, 'shutdown/prisma.$disconnect'))
          .finally(() => {
            clearTimeout(forceExit);
            deps.exit(err ? 1 : 0);
          });
      });
    }

    // Sem flushPendingWork, o comportamento é idêntico ao de antes (síncrono). Com
    // ele, corre contra a própria guarda: se o SMTP travar, closeAndExit segue em
    // frente mesmo assim — perder um email em voo é melhor que atrasar o encerramento
    // inteiro por causa dele.
    if (deps.flushPendingWork) {
      const timeoutPromise = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, deps.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);
        t.unref?.();
      });

      Promise.race([deps.flushPendingWork(), timeoutPromise])
        .catch((flushError: unknown) => deps.logError(flushError, 'shutdown/flushPendingWork'))
        .finally(closeAndExit);
    } else {
      closeAndExit();
    }
  };
}
