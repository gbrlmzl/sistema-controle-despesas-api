import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';
import { AppError } from '../../src/utils/AppError.js';
import { setStorageForTests } from '../../src/lib/storage.js';
import { createFakeStorage, VALID_SIGNATURE_BYTES, INVALID_SIGNATURE_BYTES } from '../helpers/fakeStorage.js';
import {
  createReceiptIntent,
  completeReceipt,
  confirmReceived,
} from '../../src/services/payments/settlementsService.js';

// Fase 4 do plano de acertos -> testado contra o banco de verdade, chamando o
// service diretamente (as rotas HTTP só existem a partir da Fase 5), no mesmo
// molde de tests/integration/refreshTokenPurge.test.ts. O storage é o fake em
// memória (Regra 5 da Parte B: nenhum teste automatizado abre conexão com a AWS).

const TEST_EMAIL_DOMAIN = 'settlements-service-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

interface RegisteredUser {
  agent: ReturnType<typeof request.agent>;
  id: number;
  name: string;
  username: string;
}

async function registerUser(name: string): Promise<RegisteredUser> {
  const agent = request.agent(app);
  const username = `u${uniqueSuffix()}`.slice(0, 20);
  const email = `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`;

  const response = await agent
    .post('/auth/register')
    .send({ name, username, email, password: 'senhaForte1', confirmPassword: 'senhaForte1' });

  return { agent, id: response.body.user.id, name, username };
}

async function addMemberToResidence(owner: RegisteredUser, code: string, memberName: string): Promise<RegisteredUser> {
  const member = await registerUser(memberName);
  await member.agent.post('/residences/join-requests').send({ code });

  const detail = await owner.agent.get(`/residences/${code}`);
  const req = detail.body.pendingJoinRequests.find(
    (r: { requesterUsername: string }) => r.requesterUsername === member.username,
  );
  await owner.agent.patch(`/residences/join-requests/${req.id}`).send({ status: 'accepted' });

  return member;
}

const now = new Date();
const currentMonth = now.getMonth() + 1;
const currentYear = now.getFullYear();
const period = { month: currentMonth, year: currentYear };

async function expectStatusCode(promise: Promise<unknown>, statusCode: number): Promise<void> {
  try {
    await promise;
    throw new Error(`esperava rejeição com status ${statusCode}, mas a promise resolveu`);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.statusCode).toBe(statusCode);
  }
}

afterAll(async () => {
  await prisma.residence.deleteMany({ where: { owner: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('fluxo completo de liquidação de um par (D-30/RN-074/075/076/084)', () => {
  let owner: RegisteredUser;
  let memberB: RegisteredUser;
  let memberC: RegisteredUser;
  let memberD: RegisteredUser;
  let code: string;
  let settlementOwnerId: string;
  let settlementBId: string;
  const fakeStorage = createFakeStorage();

  beforeAll(async () => {
    setStorageForTests(fakeStorage);

    owner = await registerUser('Dono Acertos');
    const created = await owner.agent.post('/residences').send({ name: 'Casa Acertos' });
    code = created.body.residence.code;

    memberB = await addMemberToResidence(owner, code, 'Membro B Acertos');
    memberC = await addMemberToResidence(owner, code, 'Membro C Acertos');
    memberD = await addMemberToResidence(owner, code, 'Membro D Acertos');

    // 4 participantes, cota de 100 cada (total 400/4). C gasta 300, D gasta 100
    // (saldo exatamente zero, fora do algoritmo — RN-071). Owner e B ficam devedores
    // de 100 cada, os dois com C como credora — o cenário do RN-084.
    await memberC.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Aluguel', valueInCents: 300, category: 'ALIMENTACAO', isRecurring: false });
    await memberD.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Internet', valueInCents: 100, category: 'ASSINATURAS', isRecurring: false });

    await owner.agent.post(`/residences/${code}/expenses/month-closures`).send({ month: currentMonth, year: currentYear });

    const residence = await prisma.residence.findUnique({ where: { code }, select: { id: true } });
    const closure = await prisma.monthClosure.findUnique({
      where: { residenceId_year_month: { residenceId: residence!.id, year: currentYear, month: currentMonth } },
      select: { id: true },
    });
    const settlements = await prisma.settlement.findMany({ where: { closureId: closure!.id } });

    expect(settlements).toHaveLength(2);
    settlementOwnerId = settlements.find((s) => s.payerId === owner.id)!.id;
    settlementBId = settlements.find((s) => s.payerId === memberB.id)!.id;
    expect(settlements.every((s) => s.receiverId === memberC.id)).toBe(true);
  });

  afterAll(() => setStorageForTests(null));

  it('membro sem papel na linha recebe 403 tanto para anexar quanto para confirmar', async () => {
    await expectStatusCode(
      createReceiptIntent(code, memberD.id, period, settlementOwnerId, {
        contentType: 'image/jpeg',
        sizeInBytes: 100,
      }),
      403,
    );
    await expectStatusCode(confirmReceived(code, memberD.id, period, settlementOwnerId), 403);
  });

  it('devedor anexa e completa — a linha vira AWAITING_CONFIRMATION (RN-074), e o credor ainda não é avisado (RN-084)', async () => {
    const intent = await createReceiptIntent(code, owner.id, period, settlementOwnerId, {
      contentType: 'image/jpeg',
      sizeInBytes: VALID_SIGNATURE_BYTES['image/jpeg']!.length,
      originalName: 'comprovante.jpg',
    });
    fakeStorage.simulateUpload(intent.upload.fields.key!, VALID_SIGNATURE_BYTES['image/jpeg']!, 'image/jpeg');

    const result = await completeReceipt(code, owner.id, period, settlementOwnerId, intent.receiptId);

    expect(result.settlement.status).toBe('AWAITING_CONFIRMATION');
    expect(result.settlement.paidAt).not.toBeNull();
    // A cota da casa ainda não fechou: o par do memberB continua pendente.
    expect(result.closureStatus).toBe('AWAITING_PAYMENT');

    // RN-084: C só é avisada quando TODOS os pares em que é credora tiverem
    // paidAt — só o par do owner completou, o do memberB ainda não.
    const readyNotifications = await prisma.notification.count({ where: { userId: memberC.id, type: 'SETTLEMENT_READY' } });
    expect(readyNotifications).toBe(0);
  });

  it('completar o mesmo comprovante de novo devolve 200 idempotente, sem duplicar nada', async () => {
    const receipt = await prisma.paymentReceipt.findFirstOrThrow({ where: { settlementId: settlementOwnerId } });

    const result = await completeReceipt(code, owner.id, period, settlementOwnerId, receipt.id);
    expect(result.receipt.id).toBe(receipt.id);
    expect(result.settlement.status).toBe('AWAITING_CONFIRMATION');

    const receiptsForSettlement = await prisma.paymentReceipt.count({ where: { settlementId: settlementOwnerId } });
    expect(receiptsForSettlement).toBe(1);
  });

  it('credor confirma ANTES do devedor anexar (RN-076): 200, mas a leitura continua PENDING até o paidAt chegar', async () => {
    const result = await confirmReceived(code, memberC.id, period, settlementBId);

    expect(result.settlement.confirmedAt).not.toBeNull();
    // RN-076/§6.1: sem paidAt, a leitura da linha ainda é PENDING mesmo com
    // confirmedAt já gravado.
    expect(result.settlement.status).toBe('PENDING');
  });

  it('devedor de duas dívidas em pares diferentes: o credor só recebe SETTLEMENT_READY quando os DOIS pares tiverem paidAt (RN-084)', async () => {
    const intent = await createReceiptIntent(code, memberB.id, period, settlementBId, {
      contentType: 'image/webp',
      sizeInBytes: VALID_SIGNATURE_BYTES['image/webp']!.length,
    });
    fakeStorage.simulateUpload(intent.upload.fields.key!, VALID_SIGNATURE_BYTES['image/webp']!, 'image/webp');

    const result = await completeReceipt(code, memberB.id, period, settlementBId, intent.receiptId);

    // confirmedAt já existia (passo anterior) -> esta linha vira SETTLED agora.
    expect(result.settlement.status).toBe('SETTLED');
    // Mas o par do owner ainda só tem paidAt, sem confirmedAt -> o mês continua
    // aguardando confirmação, não quitado.
    expect(result.closureStatus).toBe('AWAITING_CONFIRMATION');

    // Agora SIM: os dois pares em que C é credora têm paidAt -> exatamente 1
    // notificação SETTLEMENT_READY, nunca uma por linha.
    const readyNotifications = await prisma.notification.count({ where: { userId: memberC.id, type: 'SETTLEMENT_READY' } });
    expect(readyNotifications).toBe(1);
  });

  it('credor confirma o último par pendente: mês vira SETTLED e MONTH_SETTLED é publicado para todos, uma vez só', async () => {
    const result = await confirmReceived(code, memberC.id, period, settlementOwnerId);

    expect(result.settlement.status).toBe('SETTLED');
    expect(result.closureStatus).toBe('SETTLED');

    const settledIds = [owner.id, memberB.id, memberC.id, memberD.id];
    const settledNotifications = await prisma.notification.findMany({
      where: { userId: { in: settledIds }, type: 'MONTH_SETTLED' },
    });
    expect(settledNotifications).toHaveLength(settledIds.length);

    const closure = await prisma.monthClosure.findFirst({
      where: { residence: { code } },
      select: { settledAt: true },
    });
    expect(closure!.settledAt).not.toBeNull();
  });
});

describe('validações independentes de acertos', () => {
  let owner: RegisteredUser;
  let memberB: RegisteredUser;
  let memberD: RegisteredUser;
  let code: string;
  let settlementId: string;
  const fakeStorage = createFakeStorage();

  beforeAll(async () => {
    setStorageForTests(fakeStorage);

    owner = await registerUser('Dono Validações');
    const created = await owner.agent.post('/residences').send({ name: 'Casa Validações' });
    code = created.body.residence.code;

    memberB = await addMemberToResidence(owner, code, 'Membro B Validações');
    memberD = await addMemberToResidence(owner, code, 'Membro D Validações');

    // 3 participantes, cota 100. B gasta 200 (credor de 100), D gasta 100 (saldo
    // zero, fora do algoritmo). Owner fica devedor de 100 — um único par.
    await memberB.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Mercado', valueInCents: 200, category: 'ALIMENTACAO', isRecurring: false });
    await memberD.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Gás', valueInCents: 100, category: 'DOMESTICAS', isRecurring: false });

    await owner.agent.post(`/residences/${code}/expenses/month-closures`).send({ month: currentMonth, year: currentYear });

    const residence = await prisma.residence.findUnique({ where: { code }, select: { id: true } });
    const closure = await prisma.monthClosure.findUnique({
      where: { residenceId_year_month: { residenceId: residence!.id, year: currentYear, month: currentMonth } },
      select: { id: true },
    });
    const settlement = await prisma.settlement.findFirstOrThrow({ where: { closureId: closure!.id } });
    settlementId = settlement.id;
    expect(settlement.payerId).toBe(owner.id);
    expect(settlement.receiverId).toBe(memberB.id);
  });

  afterAll(() => setStorageForTests(null));

  it('o credor da linha tentando anexar comprovante recebe 409 (RN-075)', async () => {
    await expectStatusCode(
      createReceiptIntent(code, memberB.id, period, settlementId, { contentType: 'image/jpeg', sizeInBytes: 100 }),
      409,
    );
  });

  it('o devedor da linha tentando confirmar recebimento recebe 409 (RN-074)', async () => {
    await expectStatusCode(confirmReceived(code, owner.id, period, settlementId), 409);
  });

  it('competência aberta recusa intenção de upload e confirmação com 409 (RN-069)', async () => {
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
    const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
    const openPeriod = { month: nextMonth, year: nextYear };
    const anySettlementId = randomUUID();

    await expectStatusCode(
      createReceiptIntent(code, owner.id, openPeriod, anySettlementId, { contentType: 'image/jpeg', sizeInBytes: 100 }),
      409,
    );
    await expectStatusCode(confirmReceived(code, memberB.id, openPeriod, anySettlementId), 409);
  });

  it('magic bytes divergentes do Content-Type declarado devolvem 422, e a linha continua pendente', async () => {
    const intent = await createReceiptIntent(code, owner.id, period, settlementId, {
      contentType: 'image/jpeg',
      sizeInBytes: INVALID_SIGNATURE_BYTES.length,
    });
    fakeStorage.simulateUpload(intent.upload.fields.key!, INVALID_SIGNATURE_BYTES, 'image/jpeg');

    await expectStatusCode(completeReceipt(code, owner.id, period, settlementId, intent.receiptId), 422);

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(settlement.paidAt).toBeNull();
    const receipt = await prisma.paymentReceipt.findUniqueOrThrow({ where: { id: intent.receiptId } });
    expect(receipt.status).toBe('PENDING');
  });
});
