// SEC-09 -> A lógica de execução da purga vive aqui, e não em scripts/purgeTokens.ts,
// pelo mesmo motivo de utils/shutdown.ts: o script é um entrypoint que roda no escopo
// do módulo e chama process.exit — importá-lo num teste executaria a purga de verdade e
// mataria o processo do Jest. Com as dependências injetadas, o comportamento fica
// exercitável sem tocar no banco nem no processo.

export interface TokenPurgeDependencies {
  purgeRefreshTokens: () => Promise<number>;
  // Recuperação de senha (docs/plano-recuperacao-de-senha.md, Fase 6): mesma task de
  // purga, mesmo entrypoint — só mais uma tabela morta pra varrer.
  purgePasswordResetTokens: () => Promise<number>;
  disconnect: () => Promise<void>;
  log: (message: string) => void;
  logError: (err: unknown, context?: string) => void;
}

// Devolve o código de saída em vez de chamar process.exit: quem decide morrer é o
// entrypoint. Uma falha precisa sair diferente de zero pro EventBridge/ECS registrar a
// execução como falha — uma limpeza que nunca roda e nunca reclama é pior que nenhuma.
//
// As duas purgas são independentes: uma falhar não deve impedir a outra de rodar, mas
// qualquer falha marca a execução inteira como exitCode 1.
export async function runTokenPurge(deps: TokenPurgeDependencies): Promise<number> {
  let exitCode = 0;

  try {
    const removed = await deps.purgeRefreshTokens();
    deps.log(`Limpeza de refresh tokens concluída: ${removed} linha(s) removida(s).`);
  } catch (err) {
    deps.logError(err, 'purgeTokens/refreshTokens');
    exitCode = 1;
  }

  try {
    const removed = await deps.purgePasswordResetTokens();
    deps.log(`Limpeza de tokens de redefinição de senha concluída: ${removed} linha(s) removida(s).`);
  } catch (err) {
    deps.logError(err, 'purgeTokens/passwordResetTokens');
    exitCode = 1;
  }

  // Sem desconectar, o pool do Prisma segura o event loop e a task fica pendurada até o
  // orquestrador matá-la — o oposto de "roda e sai".
  try {
    await deps.disconnect();
  } catch (err) {
    deps.logError(err, 'purgeTokens/disconnect');
    exitCode = 1;
  }

  return exitCode;
}
