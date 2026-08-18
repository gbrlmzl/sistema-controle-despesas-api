// SEC-09 -> Entrypoint da limpeza de refresh tokens: roda, loga quantas linhas removeu
// e sai. Executado como `npm run purge:tokens` (ou `node dist/scripts/purgeTokens.js`).
//
// Deliberadamente NÃO é um setInterval dentro do processo da API: com N tasks no ECS a
// purga rodaria N vezes, e ficaria acoplada ao ciclo de vida do servidor. O agendamento
// é uma ECS Scheduled Task (EventBridge), no mesmo padrão do serviço `migrate` do
// docker-compose.yml — uma execução, um código de saída, nenhum processo residente.

import prisma from '../config/prisma.js';
import { purgeExpiredRefreshTokens } from '../services/auth/authService.js';
import { logError } from '../utils/logger.js';
import { runTokenPurge } from '../utils/tokenPurge.js';

const exitCode = await runTokenPurge({
  purge: purgeExpiredRefreshTokens,
  disconnect: () => prisma.$disconnect(),
  log: (message) => console.log(message),
  logError,
});

process.exit(exitCode);
