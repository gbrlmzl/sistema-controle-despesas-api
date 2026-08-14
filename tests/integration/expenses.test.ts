import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';

const TEST_EMAIL_DOMAIN = 'expenses-integration-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function uniqueEmail(): string {
  return `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`;
}

function uniqueUsername(): string {
  return `u${uniqueSuffix()}`.slice(0, 20);
}

interface RegisteredUser {
  agent: ReturnType<typeof request.agent>;
  id: number;
  name: string;
  username: string;
  email: string;
}

async function registerUser(name = 'Usuário de Teste'): Promise<RegisteredUser> {
  const agent = request.agent(app);
  const email = uniqueEmail();
  const username = uniqueUsername();

  const response = await agent
    .post('/auth/register')
    .send({ name, username, email, password: 'senhaForte1', confirmPassword: 'senhaForte1' });

  return { agent, id: response.body.user.id, name, username, email };
}

async function createResidenceWithMember(
  ownerName: string,
  memberName: string,
): Promise<{ owner: RegisteredUser; member: RegisteredUser; code: string }> {
  const owner = await registerUser(ownerName);
  const member = await registerUser(memberName);

  const created = await owner.agent.post('/residences').send({ name: `Casa ${ownerName}` });
  const code = created.body.residence.code;

  await member.agent.post('/residences/join-requests').send({ code });
  const detail = await owner.agent.get(`/residences/${code}`);
  const requestId = detail.body.pendingJoinRequests[0].id;
  await owner.agent.patch(`/residences/join-requests/${requestId}`).send({ status: 'accepted' });

  return { owner, member, code };
}

const now = new Date();
const currentMonth = now.getMonth() + 1;
const currentYear = now.getFullYear();
const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
const currentPeriod = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

afterAll(async () => {
  // Mesma ordem da limpeza em residences.test.ts: Residence.ownerId não tem
  // onDelete: Cascade, então a residência precisa ser removida antes do usuário.
  // Expense e MonthClosure cascateiam a partir da residência.
  await prisma.residence.deleteMany({ where: { owner: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('lançamento e consulta de despesas', () => {
  let owner: RegisteredUser;
  let member: RegisteredUser;
  let code: string;
  let memberExpenseId: string;
  let recurringExpenseId: string;

  beforeAll(async () => {
    ({ owner, member, code } = await createResidenceWithMember('Dono Despesas', 'Membro Despesas'));
  });

  it('rejeita requisição sem autenticação', async () => {
    const response = await request(app)
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Mercado', valueInCents: 1000, category: 'ALIMENTACAO', isRecurring: false });
    expect(response.status).toBe(401);
  });

  it('quem não é membro recebe 404', async () => {
    const outsider = await registerUser('Fora Despesas');
    const response = await outsider.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Mercado', valueInCents: 1000, category: 'ALIMENTACAO', isRecurring: false });
    expect(response.status).toBe(404);
  });

  it('rejeita payload inválido (nome curto demais)', async () => {
    const response = await member.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'A', valueInCents: 1000, category: 'ALIMENTACAO', isRecurring: false });
    expect(response.status).toBe(400);
  });

  it('membro lança uma despesa, que cai na competência aberta (RN-020)', async () => {
    const response = await member.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Supermercado', valueInCents: 18050, category: 'ALIMENTACAO', isRecurring: false });

    expect(response.status).toBe(201);
    expect(response.body.expense).toMatchObject({
      name: 'Supermercado',
      valueInCents: 18050,
      month: currentMonth,
      year: currentYear,
    });
    memberExpenseId = response.body.expense.id;
  });

  it('owner lança uma despesa recorrente', async () => {
    const response = await owner.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Streaming', valueInCents: 3990, category: 'ASSINATURAS', isRecurring: true });

    expect(response.status).toBe(201);
    recurringExpenseId = response.body.expense.id;
  });

  it('GET lista as despesas da competência aberta, agrupadas por membro', async () => {
    const response = await owner.agent.get(`/residences/${code}/expenses`);

    expect(response.status).toBe(200);
    expect(response.body.competency).toEqual({ month: currentMonth, year: currentYear });
    expect(response.body.totalInCents).toBe(18050 + 3990);
    expect(response.body.count).toBe(2);
    expect(response.body.isClosed).toBe(false);

    const memberGroup = response.body.byMember.find((group: { userId: number }) => group.userId === member.id);
    expect(memberGroup.totalInCents).toBe(18050);
  });

  it('quem não lançou a despesa não pode editá-la (Q-5)', async () => {
    const response = await owner.agent
      .patch(`/residences/${code}/expenses/${memberExpenseId}`)
      .send({ name: 'Editado', valueInCents: 100, category: 'OUTROS', isRecurring: false });
    expect(response.status).toBe(404);
  });

  it('o autor edita a própria despesa', async () => {
    const response = await member.agent
      .patch(`/residences/${code}/expenses/${memberExpenseId}`)
      .send({ name: 'Supermercado Editado', valueInCents: 20000, category: 'ALIMENTACAO', isRecurring: false });

    expect(response.status).toBe(200);
    expect(response.body.expense).toMatchObject({ name: 'Supermercado Editado', valueInCents: 20000 });
  });

  it('GET /expenses/recurring lista a despesa recorrente do owner', async () => {
    const response = await owner.agent.get(`/residences/${code}/expenses/recurring`);

    expect(response.status).toBe(200);
    expect(response.body.expenses).toEqual(expect.arrayContaining([expect.objectContaining({ id: recurringExpenseId })]));
  });

  it('quem não é autor não pode parar a recorrência alheia (404)', async () => {
    const response = await member.agent.delete(`/residences/${code}/expenses/${recurringExpenseId}/recurrence`);
    expect(response.status).toBe(404);
  });

  it('o autor para a própria recorrência, e ela some da listagem de recorrentes', async () => {
    const response = await owner.agent.delete(`/residences/${code}/expenses/${recurringExpenseId}/recurrence`);
    expect(response.status).toBe(204);

    const list = await owner.agent.get(`/residences/${code}/expenses/recurring`);
    expect(list.body.expenses).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: recurringExpenseId })]));
  });

  it('o autor exclui (logicamente) a própria despesa, que some da listagem', async () => {
    const response = await member.agent.delete(`/residences/${code}/expenses/${memberExpenseId}`);
    expect(response.status).toBe(204);

    const list = await owner.agent.get(`/residences/${code}/expenses`);
    expect(list.body.byMember).toEqual(expect.not.arrayContaining([expect.objectContaining({ userId: member.id })]));
  });
});

describe('fechamento e reabertura de mês', () => {
  let owner: RegisteredUser;
  let member: RegisteredUser;
  let code: string;
  let recurringExpenseId: string;

  beforeAll(async () => {
    ({ owner, member, code } = await createResidenceWithMember('Dono Fechamento', 'Membro Fechamento'));

    const expenseResponse = await member.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Internet', valueInCents: 9990, category: 'ASSINATURAS', isRecurring: true });
    recurringExpenseId = expenseResponse.body.expense.id;
  });

  it('membro comum não pode fechar o mês (403)', async () => {
    const response = await member.agent
      .post(`/residences/${code}/expenses/month-closures`)
      .send({ month: currentMonth, year: currentYear });
    expect(response.status).toBe(403);
  });

  it('rejeita fechar um período diferente do aberto (409)', async () => {
    const response = await owner.agent
      .post(`/residences/${code}/expenses/month-closures`)
      .send({ month: nextMonth, year: nextYear });
    expect(response.status).toBe(409);
  });

  it('owner fecha a competência aberta, e a recorrente é replicada no mês seguinte (FEAT-025)', async () => {
    const response = await owner.agent
      .post(`/residences/${code}/expenses/month-closures`)
      .send({ month: currentMonth, year: currentYear });

    expect(response.status).toBe(201);
    expect(response.body.closure).toMatchObject({ month: currentMonth, year: currentYear });
    expect(response.body.recurringExpensesGenerated).toBe(1);

    const nextMonthList = await owner.agent.get(`/residences/${code}/expenses?month=${nextMonth}&year=${nextYear}`);
    expect(nextMonthList.body.count).toBe(1);
    expect(nextMonthList.body.byMember[0].expenses[0]).toMatchObject({ name: 'Internet' });
  });

  it('a competência agora fechada aparece com isClosed=true e o nome de quem fechou', async () => {
    const response = await owner.agent.get(`/residences/${code}/expenses?month=${currentMonth}&year=${currentYear}`);
    expect(response.body.isClosed).toBe(true);
    expect(response.body.closedByName).toBe(owner.name);
  });

  it('editar uma despesa do mês fechado dá 409', async () => {
    const response = await member.agent
      .patch(`/residences/${code}/expenses/${recurringExpenseId}`)
      .send({ name: 'Internet Editada', valueInCents: 10000, category: 'ASSINATURAS', isRecurring: true });
    expect(response.status).toBe(409);
  });

  it('fechar de novo o mesmo período antigo dá 409 (a competência aberta já avançou)', async () => {
    const response = await owner.agent
      .post(`/residences/${code}/expenses/month-closures`)
      .send({ month: currentMonth, year: currentYear });
    expect(response.status).toBe(409);
  });

  it('membro comum não pode reabrir o mês (403)', async () => {
    const response = await member.agent.delete(`/residences/${code}/expenses/month-closures/${currentPeriod}`);
    expect(response.status).toBe(403);
  });

  it('reabrir um período que não é o fechamento mais recente dá 409', async () => {
    const wrongPeriod = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
    const response = await owner.agent.delete(`/residences/${code}/expenses/month-closures/${wrongPeriod}`);
    expect(response.status).toBe(409);
  });

  it('owner reabre o mês fechado mais recente', async () => {
    const response = await owner.agent.delete(`/residences/${code}/expenses/month-closures/${currentPeriod}`);
    expect(response.status).toBe(204);

    const list = await owner.agent.get(`/residences/${code}/expenses?month=${currentMonth}&year=${currentYear}`);
    expect(list.body.isClosed).toBe(false);
  });

  it('reabrir de novo dá 404 (não há mais mês fechado)', async () => {
    const response = await owner.agent.delete(`/residences/${code}/expenses/month-closures/${currentPeriod}`);
    expect(response.status).toBe(404);
  });
});

describe('seletor de competências (GET /expenses/competencies)', () => {
  let owner: RegisteredUser;
  let member: RegisteredUser;
  let code: string;

  beforeAll(async () => {
    ({ owner, member, code } = await createResidenceWithMember('Dono Competências', 'Membro Competências'));
  });

  it('rejeita requisição sem autenticação', async () => {
    const response = await request(app).get(`/residences/${code}/expenses/competencies`);
    expect(response.status).toBe(401);
  });

  it('quem não é membro recebe 404', async () => {
    const outsider = await registerUser('Fora Competências');
    const response = await outsider.agent.get(`/residences/${code}/expenses/competencies`);
    expect(response.status).toBe(404);
  });

  it('sem nenhuma despesa lançada, a lista vem vazia', async () => {
    const response = await owner.agent.get(`/residences/${code}/expenses/competencies`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('uma despesa excluída não conta para a competência', async () => {
    const created = await member.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Descartável', valueInCents: 500, category: 'OUTROS', isRecurring: false });
    await member.agent.delete(`/residences/${code}/expenses/${created.body.expense.id}`);

    const response = await owner.agent.get(`/residences/${code}/expenses/competencies`);
    expect(response.body).toEqual([]);
  });

  it('após lançar uma despesa, a competência aberta aparece com isClosed=false', async () => {
    await owner.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Condomínio', valueInCents: 45000, category: 'OUTROS', isRecurring: false });

    const response = await owner.agent.get(`/residences/${code}/expenses/competencies`);
    expect(response.body).toEqual([{ month: currentMonth, year: currentYear, isClosed: false }]);
  });

  it('após fechar o mês, a competência passa a isClosed=true', async () => {
    const closeResponse = await owner.agent
      .post(`/residences/${code}/expenses/month-closures`)
      .send({ month: currentMonth, year: currentYear });
    expect(closeResponse.status).toBe(201);

    const response = await owner.agent.get(`/residences/${code}/expenses/competencies`);
    expect(response.body).toEqual([{ month: currentMonth, year: currentYear, isClosed: true }]);
  });

  it('ao lançar despesa na nova competência aberta, a lista traz as duas, mais recente primeiro', async () => {
    await member.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Internet', valueInCents: 9990, category: 'ASSINATURAS', isRecurring: false });

    const response = await owner.agent.get(`/residences/${code}/expenses/competencies`);
    expect(response.body).toEqual([
      { month: nextMonth, year: nextYear, isClosed: false },
      { month: currentMonth, year: currentYear, isClosed: true },
    ]);
  });
});

describe('relatório da residência', () => {
  let owner: RegisteredUser;
  let member: RegisteredUser;
  let code: string;

  beforeAll(async () => {
    ({ owner, member, code } = await createResidenceWithMember('Dono Relatório', 'Membro Relatório'));

    await owner.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Aluguel', valueInCents: 150000, category: 'OUTROS', isRecurring: false });
    await member.agent
      .post(`/residences/${code}/expenses`)
      .send({ name: 'Mercado', valueInCents: 50000, category: 'ALIMENTACAO', isRecurring: false });
  });

  it('rejeita requisição sem autenticação', async () => {
    const response = await request(app).get(`/residences/${code}/reports`);
    expect(response.status).toBe(401);
  });

  it('quem não é membro recebe 404', async () => {
    const outsider = await registerUser('Fora Relatório');
    const response = await outsider.agent.get(`/residences/${code}/reports`);
    expect(response.status).toBe(404);
  });

  it('rejeita mês/ano inválidos na query com 400', async () => {
    const response = await owner.agent.get(`/residences/${code}/reports?month=13&year=2026`);
    expect(response.status).toBe(400);
  });

  it('a aba padrão é a da residência inteira', async () => {
    const response = await owner.agent.get(`/residences/${code}/reports`);

    expect(response.status).toBe(200);
    expect(response.body.tab).toBe('residence');
    expect(response.body.report.totalInCents).toBe(200000);
    expect(response.body.split.hasSplit).toBe(true);
    expect(response.body.split.participants).toHaveLength(2);
    expect(response.body.expenses).toHaveLength(2);
  });

  it('aba pessoal restringe o relatório aos lançamentos do próprio usuário (RN-060)', async () => {
    const response = await member.agent.get(`/residences/${code}/reports?tab=personal`);

    expect(response.status).toBe(200);
    expect(response.body.tab).toBe('personal');
    expect(response.body.report.totalInCents).toBe(50000);
    //CA-4 da US-025 -> o total da casa aparece mesmo na aba pessoal, pra dar contexto
    expect(response.body.householdTotalInCents).toBe(200000);
  });
});
