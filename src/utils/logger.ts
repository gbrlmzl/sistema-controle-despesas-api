const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export function logError(err: unknown, context?: string): void {
  const timestamp = new Date().toISOString();
  const label = context ? `${timestamp} - ${context}` : timestamp;
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);

  console.error(`${RED}[ERROR] ${label}\n${detail}${RESET}`);
}
