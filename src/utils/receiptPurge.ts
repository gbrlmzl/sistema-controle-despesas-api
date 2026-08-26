// D-26 -> Uma regra de ciclo de vida do S3 não distingue "objeto confirmado" de
// "objeto abandonado" -- essa informação só existe no Postgres (o status do
// PaymentReceipt). Por isso a limpeza é do lado da aplicação, no molde de
// tokenPurge.ts: dependências injetadas, para o teste não precisar nem de banco
// nem de rede.

import type { StoragePort } from '../lib/storage.js';

export interface ReceiptPurgeClient {
  paymentReceipt: {
    findMany(args: {
      where: { status: 'PENDING'; createdAt: { lt: Date } };
      select: { id: true; storageKey: true };
    }): Promise<Array<{ id: string; storageKey: string }>>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

export interface ReceiptPurgeDependencies {
  prisma: ReceiptPurgeClient;
  storage: Pick<StoragePort, 'deleteObject'>;
  // D-23 -> um PaymentReceipt PENDING não conta para nada: se o passo 2 (upload
  // direto ao S3) ou 3 (/complete) nunca acontecer, a linha fica órfã para
  // sempre. 24h é folga suficiente para qualquer upload legítimo em andamento.
  olderThanHours?: number;
}

export interface ReceiptPurgeResult {
  succeeded: number;
  failed: number;
}

// Uma falha no S3 num item não pode abortar o lote inteiro -- os outros
// comprovantes órfãos continuam sendo tentados. Um objeto que já não existe no
// bucket (DeleteObject é idempotente) conta como sucesso, do mesmo jeito que um
// registro já removido.
export async function purgeOrphanReceipts(deps: ReceiptPurgeDependencies): Promise<ReceiptPurgeResult> {
  const olderThanHours = deps.olderThanHours ?? 24;
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

  const orphans = await deps.prisma.paymentReceipt.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
    select: { id: true, storageKey: true },
  });

  let succeeded = 0;
  let failed = 0;

  for (const orphan of orphans) {
    try {
      await deps.storage.deleteObject(orphan.storageKey);
      await deps.prisma.paymentReceipt.delete({ where: { id: orphan.id } });
      succeeded++;
    } catch {
      failed++;
    }
  }

  return { succeeded, failed };
}
