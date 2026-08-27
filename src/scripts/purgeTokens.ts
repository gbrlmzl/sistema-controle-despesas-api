// SEC-09 -> Entrypoint da limpeza de refresh tokens: roda, loga quantas linhas removeu
// e sai. Executado como `npm run purge:tokens` (ou `node dist/scripts/purgeTokens.js`).
//
// Deliberadamente NÃO é um setInterval dentro do processo da API: com N tasks no ECS a
// purga rodaria N vezes, e ficaria acoplada ao ciclo de vida do servidor. O agendamento
// é uma ECS Scheduled Task (EventBridge), no mesmo padrão do serviço `migrate` do
// docker-compose.yml — uma execução, um código de saída, nenhum processo residente.

import prisma from '../config/prisma.js';
import { purgeExpiredRefreshTokens } from '../services/auth/authService.js';
import { purgeExpiredPasswordResetTokens } from '../services/auth/passwordResetService.js';
import { logError } from '../utils/logger.js';
import { runTokenPurge } from '../utils/tokenPurge.js';
import { purgeOrphanReceipts } from '../utils/receiptPurge.js';
import { storage } from '../lib/storage.js';
import { storageEnabled } from '../config/env.js';

let exitCode = await runTokenPurge({
  purgeRefreshTokens: purgeExpiredRefreshTokens,
  purgePasswordResetTokens: purgeExpiredPasswordResetTokens,
  // A desconexão de verdade fica para o fim do script (ver abaixo): a purga de
  // comprovantes órfãos, logo a seguir, ainda precisa do mesmo cliente Prisma.
  disconnect: async () => {},
  log: (message) => console.log(message),
  logError,
});

// D-26 -> só roda com storage ligado; sem S3_REGION/S3_BUCKET não há bucket
// nenhum de onde apagar objeto, e a linha PENDING fica esperando sem problema.
if (storageEnabled) {
  try {
    const result = await purgeOrphanReceipts({ prisma, storage });
    console.log(`Limpeza de comprovantes órfãos concluída: ${result.succeeded} removido(s), ${result.failed} falha(s).`);
    if (result.failed > 0) {
      exitCode = 1;
    }
  } catch (err) {
    logError(err, 'purgeTokens/orphanReceipts');
    exitCode = 1;
  }
}

try {
  await prisma.$disconnect();
} catch (err) {
  logError(err, 'purgeTokens/disconnect');
  exitCode = 1;
}

process.exit(exitCode);
