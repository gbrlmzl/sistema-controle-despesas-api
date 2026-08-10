import app from './app.js';
import { env } from './config/env.js';
import { logError } from './utils/logger.js';

process.on('uncaughtException', (err) => {
  logError(err, 'uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logError(reason, 'unhandledRejection');
});

app.listen(env.PORT, () => {
  console.log(`API rodando em http://localhost:${env.PORT}`);
});
