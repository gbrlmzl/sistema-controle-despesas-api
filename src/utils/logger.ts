import { env } from '../config/env.js';

const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export function logError(err: unknown, context?: string): void {
  const timestamp = new Date().toISOString();
  const label = context ? `${timestamp} - ${context}` : timestamp;
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);

  console.error(`${RED}[ERROR] ${label}\n${detail}${RESET}`);
}

// SEC-10 -> Eventos de segurança em JSON de uma linha, no stderr.
//
// O formato importa mais que o conteúdo: uma linha, um objeto, chaves estáveis. É isso
// que permite criar um metric filter no CloudWatch (`{ $.event = "login_failed" }`) e
// pendurar um alarme nele — detecção de intrusão de custo zero. Texto livre, como o
// logError acima, não dá pra medir.
//
// Nada aqui pode carregar segredo: nunca a senha tentada, nunca o valor do refresh
// token. Só identificadores (username, userId, prefixo do hash) e o IP de origem.

export type SecurityEventName =
  // Roubo de refresh token CONFIRMADO — um token já revogado sendo reapresentado.
  // É o alerta mais valioso que esta aplicação emite.
  | 'refresh_token_reuse'
  // Sinal de força bruta quando repetido a partir do mesmo IP.
  | 'login_failed'
  | 'rate_limit_exceeded'
  // Reuso de um token de redefinição de senha já consumido — mesmo peso do
  // refresh_token_reuse: não é suspeita, é sinal de que o token vazou.
  | 'password_reset_token_reuse'
  // Teto por conta (D-07) estourado: o email não foi enviado, mas a resposta HTTP
  // continua 200 (D-03), então este é o único lugar onde o evento fica visível.
  | 'password_reset_throttled'
  // D-23 -> o objeto chegou no S3, mas o HeadObject ou os magic bytes não batem com
  // o Content-Type declarado na intenção de upload. Pode ser um cliente quebrado,
  // mas também é o sinal de alguém tentando subir um arquivo diferente do que a
  // política do presigned POST autorizou.
  | 'receipt_content_mismatch';

// O IP só existe no `req`, e a camada de serviço não recebe `req` — passar o objeto
// inteiro pra dentro dos services acoplaria regra de negócio ao Express. Este objeto
// simples é o meio-termo: o controller extrai o que interessa, o service só repassa.
export interface SecurityContext {
  ip?: string;
}

export function logSecurityEvent(event: SecurityEventName, details: Record<string, unknown> = {}): void {
  // Mesma razão do morgan em app.ts: a suíte de integração erra senha e estoura limite
  // dezenas de vezes de propósito, e cada evento vira um bloco de console no relatório
  // do Jest. Quem precisa observar o log de verdade muta env.NODE_ENV (ver
  // tests/integration/securityEvents.test.ts) — que é exatamente o comportamento de
  // produção sendo exercitado, não uma simulação dele.
  if (env.NODE_ENV === 'test') {
    return;
  }

  console.warn(
    JSON.stringify({
      level: 'security',
      event,
      timestamp: new Date().toISOString(),
      ...details,
    }),
  );
}
