// Entrypoint fino que só chama e sai — mesmo molde de scripts/testMail.ts. É o que a
// seção A.7 do plano usa para confirmar que a credencial e o bucket funcionam de
// verdade: grava um objeto de teste, faz headObject, lê os primeiros bytes, gera uma
// URL de leitura e apaga — imprimindo cada passo.
//
//   npm run storage:test

import { storage, putTestObject } from '../lib/storage.js';
import { storageEnabled } from '../config/env.js';
import { logError } from '../utils/logger.js';

if (!storageEnabled) {
  console.error('Storage não configurado — preencha S3_REGION e S3_BUCKET no .env antes de testar.');
  process.exit(1);
}

const key = `residences/_storage-test/${Date.now()}.txt`;
const body = Buffer.from('cronos storage:test');

try {
  await putTestObject(key, body, 'text/plain');
  console.log(`1/5 — objeto gravado: ${key}`);

  const info = await storage.headObject(key);
  if (!info) throw new Error('headObject devolveu null logo após a gravação.');
  console.log(`2/5 — headObject: ${info.sizeInBytes} bytes, Content-Type ${info.contentType}`);

  const firstBytes = await storage.readFirstBytes(key, 12);
  console.log(`3/5 — primeiros 12 bytes: ${firstBytes?.toString('utf-8')}`);

  const url = await storage.createDownloadUrl({
    key,
    expiresInSeconds: 300,
    contentType: 'text/plain',
    disposition: 'inline',
    fileName: 'teste.txt',
  });
  // Nunca logar a URL pré-assinada inteira (a assinatura é credencial) — só o host.
  console.log(`4/5 — URL de leitura gerada (host: ${new URL(url).host})`);

  await storage.deleteObject(key);
  console.log('5/5 — objeto apagado.');

  console.log('Storage configurado corretamente.');
  process.exit(0);
} catch (err) {
  logError(err, 'testStorage');
  console.error('Falha ao testar o storage.');
  process.exit(1);
}
