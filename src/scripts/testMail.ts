// Entrypoint fino que só chama e sai — mesmo molde de scripts/purgeTokens.ts. É o
// que a seção A.3 do plano usa pra confirmar que o SMTP do Gmail está funcionando:
//
//   npm run mail:test -- seu.email@gmail.com

import { sendEmail } from '../lib/mailer.js';
import { passwordResetEmail } from '../lib/emailTemplates.js';
import { logError } from '../utils/logger.js';
import { mailEnabled } from '../config/env.js';

const to = process.argv[2];

if (!to) {
  console.error('Uso: npm run mail:test -- destinatario@exemplo.com');
  process.exit(1);
}

if (!mailEnabled) {
  console.error('SMTP não configurado — preencha as 5 variáveis SMTP no .env antes de testar.');
  process.exit(1);
}

const email = passwordResetEmail({
  name: 'Teste',
  resetUrl: 'https://exemplo.com/change-password?token=teste-de-envio',
  expiresInMinutes: 30,
});

try {
  await sendEmail({ ...email, to });
  console.log(`Email de teste enviado com sucesso para ${to}.`);
  process.exit(0);
} catch (err) {
  logError(err, 'testMail');
  console.error('Falha ao enviar o email de teste.');
  process.exit(1);
}
