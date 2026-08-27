import { jest } from '@jest/globals';
import { purgeOrphanReceipts, type ReceiptPurgeClient } from '../../src/utils/receiptPurge.js';
import type { StoragePort } from '../../src/lib/storage.js';

// D-26 -> mesmo espírito de tests/unit/tokenPurge.test.ts: dependências injetadas,
// nenhum banco e nenhuma rede de verdade. O RECORTE do que é considerado órfão
// (status PENDING + createdAt antigo) é conferido em receiptPurge.test.ts,
// enquanto o efeito de ponta a ponta (linha some do banco) fica para a suíte de
// integração — aqui o que importa é: uma falha no S3 não pode abortar o lote.

function orphan(id: string, storageKey: string): { id: string; storageKey: string } {
  return { id, storageKey };
}

function fakePrisma(found: Array<{ id: string; storageKey: string }>): ReceiptPurgeClient & {
  deletedIds: string[];
} {
  const deletedIds: string[] = [];
  return {
    deletedIds,
    paymentReceipt: {
      findMany: jest.fn(async () => found) as ReceiptPurgeClient['paymentReceipt']['findMany'],
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        deletedIds.push(where.id);
        return {};
      }) as ReceiptPurgeClient['paymentReceipt']['delete'],
    },
  };
}

function fakeStorage(failingKeys: Set<string> = new Set()): Pick<StoragePort, 'deleteObject'> {
  return {
    deleteObject: jest.fn(async (key: string) => {
      if (failingKeys.has(key)) {
        throw new Error(`falha simulada ao apagar ${key}`);
      }
    }) as StoragePort['deleteObject'],
  };
}

describe('purgeOrphanReceipts (D-26)', () => {
  it('apaga do storage e do banco cada comprovante órfão encontrado', async () => {
    const found = [orphan('r1', 'residences/1/2026-08/settlements/s1/r1.jpg'), orphan('r2', 'residences/1/2026-08/settlements/s2/r2.png')];
    const prisma = fakePrisma(found);
    const storage = fakeStorage();

    const result = await purgeOrphanReceipts({ prisma, storage });

    expect(result).toEqual({ succeeded: 2, failed: 0 });
    expect(prisma.deletedIds).toEqual(['r1', 'r2']);
    expect(storage.deleteObject).toHaveBeenCalledWith(found[0]!.storageKey);
    expect(storage.deleteObject).toHaveBeenCalledWith(found[1]!.storageKey);
  });

  it('busca só PENDING mais antigo que o corte (padrão 24h)', async () => {
    const prisma = fakePrisma([]);
    const storage = fakeStorage();

    await purgeOrphanReceipts({ prisma, storage });

    const call = (prisma.paymentReceipt.findMany as jest.Mock).mock.calls[0]![0] as {
      where: { status: string; createdAt: { lt: Date } };
    };
    expect(call.where.status).toBe('PENDING');

    const hoursSinceCutoff = (Date.now() - call.where.createdAt.lt.getTime()) / (60 * 60 * 1000);
    expect(hoursSinceCutoff).toBeCloseTo(24, 1);
  });

  it('respeita um olderThanHours customizado', async () => {
    const prisma = fakePrisma([]);
    const storage = fakeStorage();

    await purgeOrphanReceipts({ prisma, storage, olderThanHours: 1 });

    const call = (prisma.paymentReceipt.findMany as jest.Mock).mock.calls[0]![0] as {
      where: { createdAt: { lt: Date } };
    };
    const hoursSinceCutoff = (Date.now() - call.where.createdAt.lt.getTime()) / (60 * 60 * 1000);
    expect(hoursSinceCutoff).toBeCloseTo(1, 1);
  });

  it('uma falha do S3 num item não aborta o lote: os outros continuam sendo tentados e removidos', async () => {
    const found = [orphan('r1', 'key-que-falha'), orphan('r2', 'key-ok-1'), orphan('r3', 'key-ok-2')];
    const prisma = fakePrisma(found);
    const storage = fakeStorage(new Set(['key-que-falha']));

    const result = await purgeOrphanReceipts({ prisma, storage });

    expect(result).toEqual({ succeeded: 2, failed: 1 });
    // O item que falhou no S3 NÃO teve a linha apagada do banco — evita perder o
    // registro de um objeto que ainda pode existir no bucket.
    expect(prisma.deletedIds).toEqual(['r2', 'r3']);
  });

  it('lista vazia devolve zero para os dois contadores, sem chamar o storage', async () => {
    const prisma = fakePrisma([]);
    const storage = fakeStorage();

    const result = await purgeOrphanReceipts({ prisma, storage });

    expect(result).toEqual({ succeeded: 0, failed: 0 });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
