import type { Request, RequestHandler, Response } from 'express';

// SEC-17 -> Liveness e readiness respondem perguntas diferentes, e confundi-las é o que
// faz um orquestrador tomar a decisão errada:
//
// - **Liveness** (`/health`): "o processo está vivo?" Se a resposta for não, reiniciar
//   resolve. Por isso ele não pode tocar o banco — com o Postgres fora do ar, um
//   /health que consulta o banco falharia, e o ECS ficaria reiniciando tasks
//   perfeitamente saudáveis em looping enquanto o problema está em outro lugar.
// - **Readiness** (`/ready`): "dá pra atender requisição agora?" Aqui o banco entra,
//   porque uma task sem banco não consegue servir praticamente nenhuma rota — mas a
//   reação certa é tirar do balanceamento, não reiniciar.
//
// O handler mora aqui, e não inline no app.ts, pelo mesmo motivo de utils/shutdown.ts:
// com o ping injetado, os dois desfechos (banco respondendo e banco fora) ficam
// exercitáveis sem precisar derrubar o Postgres no meio da suíte.

export interface ReadinessDependencies {
  // Um round trip barato até o banco. Não é `prisma.$connect()`: o pool pode estar
  // "conectado" e o servidor ainda assim recusar query.
  ping: () => Promise<unknown>;
  logError: (err: unknown, context?: string) => void;
}

export function createReadinessHandler(deps: ReadinessDependencies): RequestHandler {
  return async function ready(_req: Request, res: Response): Promise<void> {
    try {
      await deps.ping();
      res.status(200).json({ status: 'ready' });
    } catch (err) {
      // O detalhe vai pro log, nunca pra resposta: a mensagem crua do Prisma entrega
      // host, porta e nome do banco — o mesmo raciocínio do SEC-04.
      deps.logError(err, 'GET /ready');

      // 503, não 500: é o status que diz "estou de pé, mas não me mande tráfego
      // agora". É o que o target group do ALB precisa ver pra tirar esta task do
      // balanceamento sem que ninguém a mate.
      res.status(503).json({ status: 'unavailable' });
    }
  };
}
