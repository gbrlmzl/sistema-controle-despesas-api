import type { Server } from 'node:http';
import app from './app.js';
import prisma from './config/prisma.js';
import { env } from './config/env.js';
import { logError } from './utils/logger.js';
import { createShutdownHandler } from './utils/shutdown.js';

process.on('uncaughtException', (err) => {
  logError(err, 'uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logError(reason, 'unhandledRejection');
});

const server: Server = app.listen(env.PORT, () => {
  console.log(`API rodando em http://localhost:${env.PORT}`);
});

// SEC-08 -> O orquestrador (ECS) sempre manda SIGTERM antes de matar o container: em
// todo deploy, todo scale-in e toda substituição de instância. Sem tratar o sinal, o
// Node encerra na hora — requisições em voo morrem com erro no navegador do usuário e
// as conexões do pool ficam penduradas no Postgres até o timeout do servidor.
//
// O comportamento em si mora em utils/shutdown.ts, com as dependências injetadas, pra
// poder ser testado sem subir servidor nem chamar process.exit de verdade.
const shutdown = createShutdownHandler({
  closeServer: (callback) => server.close(callback),
  disconnect: () => prisma.$disconnect(),
  exit: (code) => process.exit(code),
  logError,
  log: (message) => console.log(message),
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
