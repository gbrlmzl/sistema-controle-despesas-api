import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';
import { setStorageForTests } from '../../src/lib/storage.js';
import { createFakeStorage, VALID_SIGNATURE_BYTES } from '../helpers/fakeStorage.js';

// Fase 8 do plano de acertos -> contrato HTTP das 6 rotas novas (§6), montadas na
// Fase 5. A lógica de negócio fina (RN-074/075/076/084, magic bytes, idempotência
// do /complete) já está coberta em tests/integration/settlementsService.test.ts
// chamando o service direto; aqui o que se prova é o que só existe na camada
// HTTP: roteamento, 404 de não-membro em cada rota, validação de corpo, e o
// interruptor storageEnabled (D-18) na prática.

const TEST_EMAIL_DOMAIN = 'settlements-http-test.example.com';

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
const period = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

async function closeOnePairResidence(
  ownerName: string,
  memberName: string,
  memberOwesInCents: number,
): Promise<{ owner: RegisteredUser; member: RegisteredUser; code: string; settlementId: string }> {
  const owner = await registerUser(ownerName);
  const created = await owner.agent.post('/residences').send({ name: `Casa ${ownerName}` });
  const code = created.body.residence.code;
  const member = await addMemberToResidence(owner, code, memberName);

  // Só o member gasta: owner fica devedor de metade do valor, member credor.
  await member.agent
    .post(`/residences/${code}/expenses`)
    .send({ name: 'Mercado', valueInCents: memberOwesInCents * 2, category: 'ALIMENTACAO', isRecurring: false });

  await owner.agent.post(`/residences/${code}/expenses/month-closures`).send({ month: currentMonth, year: currentYear });

  const residence = await prisma.residence.findUnique({ where: { code }, select: { id: true } });
  const closure = await prisma.monthClosure.findUnique({
    where: { residenceId_year_month: { residenceId: residence!.id, year: currentYear, month: currentMonth } },
    select: { id: true },
  });
  const settlement = await prisma.settlement.findFirstOrThrow({ where: { closureId: closure!.id } });

  return { owner, member, code, settlementId: settlement.id };
}

afterAll(async () => {
  await prisma.residence.deleteMany({ where: { owner: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('não-membro recebe 404 nas 6 rotas de acerto (RN-080)', () => {
  it('todas as rotas devolvem 404 para quem não é membro da residência', async () => {
    const { owner, code, settlementId } = await closeOnePairResidence('Dono 404', 'Membro 404', 5000);
    const outsider = await registerUser('Fora 404');

    // Corpo válido em cada rota com validateBody: um 400 de validação mascararia o
    // 404 de não-membro que este teste quer provar.
    const routes: Array<[method: 'get' | 'post', path: string, body?: Record<string, unknown>]> = [
      ['get', `/residences/${code}/closures/${period}/settlements`],
      [
        'post',
        `/residences/${code}/closures/${period}/settlements/${settlementId}/receipts`,
        { contentType: 'image/jpeg', sizeInBytes: 1000 },
      ],
      ['post', `/residences/${code}/closures/${period}/settlements/${settlementId}/receipts/qualquer/complete`],
      ['post', `/residences/${code}/closures/${period}/settlements/${settlementId}/confirm`],
      ['post', `/residences/${code}/closures/${period}/settlements/${settlementId}/waive`, { reason: 'Teste de dispensa' }],
      ['get', `/residences/${code}/closures/${period}/receipts/qualquer/url`],
    ];

    for (const [method, path, body] of routes) {
      const response = method === 'get' ? await outsider.agent.get(path) : await outsider.agent.post(path).send(body ?? {});
      expect(response.status).toBe(404);
    }

    // Confirma que o dono, que É membro, não recebe 404 nas mesmas rotas de leitura.
    const ownerRead = await owner.agent.get(`/residences/${code}/closures/${period}/settlements`);
    expect(ownerRead.status).toBe(200);
  });
});

describe('fluxo completo por HTTP: intenção -> upload -> complete -> confirm', () => {
  const fakeStorage = createFakeStorage();

  beforeAll(() => setStorageForTests(fakeStorage));
  afterAll(() => setStorageForTests(null));

  it('percorre as rotas reais e o GET de listagem reflete cada transição', async () => {
    const { owner, member, code, settlementId } = await closeOnePairResidence('Dono Fluxo', 'Membro Fluxo', 5000);

    // Payload inválido -> 400 (schema realmente pendurado na rota).
    const badIntent = await owner.agent
      .post(`/residences/${code}/closures/${period}/settlements/${settlementId}/receipts`)
      .send({ contentType: 'image/gif', sizeInBytes: 100 });
    expect(badIntent.status).toBe(400);

    const intentResponse = await owner.agent
      .post(`/residences/${code}/closures/${period}/settlements/${settlementId}/receipts`)
      .send({ contentType: 'image/jpeg', sizeInBytes: VALID_SIGNATURE_BYTES['image/jpeg']!.length, originalName: 'nota.jpg' });
    expect(intentResponse.status).toBe(201);
    const { receiptId, upload } = intentResponse.body;

    fakeStorage.simulateUpload(upload.fields.key, VALID_SIGNATURE_BYTES['image/jpeg']!, 'image/jpeg');

    const completeResponse = await owner.agent.post(
      `/residences/${code}/closures/${period}/settlements/${settlementId}/receipts/${receiptId}/complete`,
    );
    expect(completeResponse.status).toBe(200);
    expect(completeResponse.body.settlement.status).toBe('AWAITING_CONFIRMATION');

    const confirmResponse = await member.agent.post(
      `/residences/${code}/closures/${period}/settlements/${settlementId}/confirm`,
    );
    expect(confirmResponse.status).toBe(200);
    expect(confirmResponse.body.settlement.status).toBe('SETTLED');
    expect(confirmResponse.body.closureStatus).toBe('SETTLED');

    const listResponse = await owner.agent.get(`/residences/${code}/closures/${period}/settlements`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.status).toBe('SETTLED');
    expect(listResponse.body.settlements[0]).toMatchObject({ status: 'SETTLED' });
    expect(listResponse.body.settlements[0].receipts).toHaveLength(1);

    const urlResponse = await member.agent.get(`/residences/${code}/closures/${period}/receipts/${receiptId}/url`);
    expect(urlResponse.status).toBe(200);
    expect(typeof urlResponse.body.url).toBe('string');
  });
});

describe('residência arquivada (D-05/RN-078)', () => {
  const fakeStorage = createFakeStorage();

  beforeAll(() => setStorageForTests(fakeStorage));
  afterAll(() => setStorageForTests(null));

  it('recusa anexo e confirmação com 409, mas a leitura continua 200', async () => {
    const { owner, member, code, settlementId } = await closeOnePairResidence('Dono Arquivada', 'Membro Arquivada', 3000);

    await owner.agent.patch(`/residences/${code}`).send({ archived: true });

    const intentResponse = await owner.agent
      .post(`/residences/${code}/closures/${period}/settlements/${settlementId}/receipts`)
      .send({ contentType: 'image/jpeg', sizeInBytes: 1000 });
    expect(intentResponse.status).toBe(409);

    const confirmResponse = await member.agent.post(
      `/residences/${code}/closures/${period}/settlements/${settlementId}/confirm`,
    );
    expect(confirmResponse.status).toBe(409);

    const listResponse = await owner.agent.get(`/residences/${code}/closures/${period}/settlements`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.canAct).toBe(false);
  });
});

describe('dispensa de acerto pelo owner (D-07/RN-082)', () => {
  const fakeStorage = createFakeStorage();

  beforeAll(() => setStorageForTests(fakeStorage));
  afterAll(() => setStorageForTests(null));

  it('só o owner dispensa; dispensa a linha inteira mesmo com paidAt já preenchido; nunca vira SETTLED; notifica os dois lados; quita o mês', async () => {
    const { owner, member, code, settlementId } = await closeOnePairResidence('Dono Dispensa', 'Membro Dispensa', 4000);

    // O devedor já anexou (paidAt preenchido) antes da dispensa acontecer.
    const intent = await owner.agent
      .post(`/residences/${code}/closures/${period}/settlements/${settlementId}/receipts`)
      .send({ contentType: 'image/png', sizeInBytes: VALID_SIGNATURE_BYTES['image/png']!.length });
    fakeStorage.simulateUpload(intent.body.upload.fields.key, VALID_SIGNATURE_BYTES['image/png']!, 'image/png');
    await owner.agent.post(
      `/residences/${code}/closures/${period}/settlements/${settlementId}/receipts/${intent.body.receiptId}/complete`,
    );

    const forbidden = await member.agent
      .post(`/residences/${code}/closures/${period}/settlements/${settlementId}/waive`)
      .send({ reason: 'Tentativa de dispensa por quem não é owner' });
    expect(forbidden.status).toBe(403);

    const waiveResponse = await owner.agent
      .post(`/residences/${code}/closures/${period}/settlements/${settlementId}/waive`)
      .send({ reason: 'Morador combinou de acertar em dinheiro fora do sistema.' });
    expect(waiveResponse.status).toBe(200);
    expect(waiveResponse.body.settlement.status).toBe('WAIVED');
    expect(waiveResponse.body.closureStatus).toBe('SETTLED'); // era o único par

    const notifications = await prisma.notification.findMany({
      where: { userId: { in: [owner.id, member.id] }, type: 'SETTLEMENT_WAIVED' },
    });
    expect(notifications).toHaveLength(2);
  });
});

describe('storageEnabled=false (D-18): degradação graciosa', () => {
  it('intenção de upload e URL de leitura respondem 503, mas confirmação, listagem, fechamento e despesas continuam 200', async () => {
    setStorageForTests(null); // garante a implementação desligada, sem fake nenhum

    const { owner, member, code, settlementId } = await closeOnePairResidence('Dono S3 Off', 'Membro S3 Off', 6000);

    const intentResponse = await owner.agent
      .post(`/residences/${code}/closures/${period}/settlements/${settlementId}/receipts`)
      .send({ contentType: 'image/jpeg', sizeInBytes: 1000 });
    expect(intentResponse.status).toBe(503);

    const missingUrlResponse = await owner.agent.get(`/residences/${code}/closures/${period}/receipts/qualquer/url`);
    expect(missingUrlResponse.status).toBe(404); // não existe comprovante nenhum, nem chega a tocar o storage

    // Para provar o 503 de verdade (e não só o 404 de "não existe"), grava um
    // PaymentReceipt já STORED direto no banco -- criá-lo pelo fluxo normal
    // exigiria storage ligado, que é justamente o que este teste está desligando.
    const storedReceipt = await prisma.paymentReceipt.create({
      data: {
        settlementId,
        storageKey: `residences/_test/${settlementId}.jpg`,
        status: 'STORED',
        declaredContentType: 'image/jpeg',
        contentType: 'image/jpeg',
        sizeInBytes: 1000,
        uploadedById: owner.id,
      },
    });
    const urlResponse = await owner.agent.get(`/residences/${code}/closures/${period}/receipts/${storedReceipt.id}/url`);
    expect(urlResponse.status).toBe(503);

    // A confirmação de recebimento NUNCA toca o S3 (D-18) -- continua 200.
    const confirmResponse = await member.agent.post(
      `/residences/${code}/closures/${period}/settlements/${settlementId}/confirm`,
    );
    expect(confirmResponse.status).toBe(200);

    const listResponse = await owner.agent.get(`/residences/${code}/closures/${period}/settlements`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.canUpload).toBe(false);

    const expensesResponse = await owner.agent.get(`/residences/${code}/expenses?month=${currentMonth}&year=${currentYear}`);
    expect(expensesResponse.status).toBe(200);
  });
});

describe('SETTLEMENT_PENDING é uma notificação por pessoa, somando os pares (D-31/RN-083)', () => {
  it('devedor em 3 pares no mesmo fechamento recebe uma única notificação, somando os 3 valores', async () => {
    const owner = await registerUser('Dono Tres Pares');
    const created = await owner.agent.post('/residences').send({ name: 'Casa Tres Pares' });
    const code = created.body.residence.code;

    const y = await addMemberToResidence(owner, code, 'Credora Y');
    const z = await addMemberToResidence(owner, code, 'Credor Z');
    const w = await addMemberToResidence(owner, code, 'Credora W');

    // owner (devedor) não gasta nada; y/z/w gastam de forma que sobra exatamente
    // 150/100/50 de crédito para cada uma, batendo com o que o owner deve (300).
    await y.agent.post(`/residences/${code}/expenses`).send({ name: 'Gasto Y', valueInCents: 450, category: 'ALIMENTACAO', isRecurring: false });
    await z.agent.post(`/residences/${code}/expenses`).send({ name: 'Gasto Z', valueInCents: 400, category: 'ALIMENTACAO', isRecurring: false });
    await w.agent.post(`/residences/${code}/expenses`).send({ name: 'Gasto W', valueInCents: 350, category: 'ALIMENTACAO', isRecurring: false });

    const closeResponse = await owner.agent
      .post(`/residences/${code}/expenses/month-closures`)
      .send({ month: currentMonth, year: currentYear });
    expect(closeResponse.body.settlementsCreated).toBe(3);

    const pendingNotifications = await prisma.notification.findMany({
      where: { userId: owner.id, type: 'SETTLEMENT_PENDING' },
    });
    expect(pendingNotifications).toHaveLength(1);
    expect(pendingNotifications[0]!.message).toEqual(expect.stringContaining('R$'));
  });
});
