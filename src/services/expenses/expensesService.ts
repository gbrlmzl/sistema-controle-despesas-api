import prisma from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import type { ExpenseCategory } from '../../generated/client.js';
import { loadUserResidenceContext } from '../residences/residencesService.js';
import { createNotifications } from '../notifications/notificationsService.js';

export interface Competency {
  month: number;
  year: number;
}

//Limite de segurança ao procurar a competência aberta, para nunca iterar sem fim
const MAX_MONTHS_TO_SEARCH = 36;

export async function monthIsClosed(residenceId: number, month: number, year: number): Promise<boolean> {
  const closure = await prisma.monthClosure.findUnique({
    select: { id: true },
    where: { residenceId_year_month: { residenceId, year, month } },
  });

  return Boolean(closure);
}

//RN-020 -> A competência aberta é o mês corrente do calendário; se o owner já o
//fechou, passa a ser o seguinte. Reabrir um mês passado o destrava para edição, mas
//não muda onde os novos lançamentos caem — eles seguem no mês corrente ou adiante.
export async function getOpenCompetency(residenceId: number): Promise<Competency> {
  const today = new Date();
  let month = today.getMonth() + 1;
  let year = today.getFullYear();

  for (let attempt = 0; attempt < MAX_MONTHS_TO_SEARCH; attempt++) {
    if (!(await monthIsClosed(residenceId, month, year))) {
      return { month, year };
    }

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return { month, year };
}

export function getNextCompetency({ month, year }: Competency): Competency {
  return month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };
}

//Q-1 a Q-4 -> todos os membros veem todas as despesas da competência, agrupadas por
//autor, com total por membro e total geral.
export async function listExpensesForCompetency(residenceId: number, month: number, year: number) {
  const [expenses, closure] = await Promise.all([
    prisma.expense.findMany({
      where: {
        residenceId,
        month,
        year,
        deletedAt: null, //FEAT-023 usa exclusão lógica
      },
      orderBy: { createdAt: 'desc' }, //os lançamentos mais recentes aparecem primeiro
      select: {
        id: true,
        name: true,
        valueInCents: true,
        category: true,
        isRecurring: true,
        createdById: true,
        createdAt: true,
        createdBy: { select: { name: true } },
      },
    }),
    prisma.monthClosure.findUnique({
      where: { residenceId_year_month: { residenceId, year, month } },
      select: { closedAt: true, closedBy: { select: { name: true } } },
    }),
  ]);

  interface MemberGroup {
    userId: number;
    name: string;
    totalInCents: number;
    expenses: {
      id: string;
      name: string;
      valueInCents: number;
      category: ExpenseCategory;
      isRecurring: boolean;
      createdById: number;
      createdAt: Date;
    }[];
  }

  const byMember: MemberGroup[] = [];

  for (const expense of expenses) {
    let group = byMember.find((item) => item.userId === expense.createdById);

    if (!group) {
      group = { userId: expense.createdById, name: expense.createdBy.name, totalInCents: 0, expenses: [] };
      byMember.push(group);
    }

    group.totalInCents += expense.valueInCents;
    group.expenses.push({
      id: expense.id,
      name: expense.name,
      valueInCents: expense.valueInCents,
      category: expense.category,
      isRecurring: expense.isRecurring,
      createdById: expense.createdById,
      createdAt: expense.createdAt,
    });
  }

  //Quem mais gastou aparece primeiro, que é a leitura mais útil da tela
  byMember.sort((a, b) => b.totalInCents - a.totalInCents);

  return {
    byMember,
    totalInCents: expenses.reduce((sum, expense) => sum + expense.valueInCents, 0),
    count: expenses.length,
    isClosed: Boolean(closure),
    closedAt: closure?.closedAt ?? null,
    closedByName: closure?.closedBy?.name ?? null,
  };
}

export interface ExpenseInput {
  name: string;
  valueInCents: number;
  category: ExpenseCategory;
  isRecurring: boolean;
}

//RN-018: qualquer membro pode lançar despesa. Q-9 da US-020: residência arquivada
//não aceita novos lançamentos. RN-020: a despesa cai sempre na competência aberta,
//nunca numa escolhida pelo cliente.
export async function createExpense(code: string, userId: number, input: ExpenseInput) {
  const context = await loadUserResidenceContext(code, userId);

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada e não aceita novas despesas.');
  }

  const competency = await getOpenCompetency(context.residence.id);

  return prisma.expense.create({
    data: {
      name: input.name,
      valueInCents: input.valueInCents,
      category: input.category,
      month: competency.month,
      year: competency.year,
      residenceId: context.residence.id,
      createdById: userId,
      isRecurring: input.isRecurring,
    },
    select: {
      id: true,
      name: true,
      valueInCents: true,
      category: true,
      isRecurring: true,
      month: true,
      year: true,
      createdById: true,
    },
  });
}

//Filtro compartilhado pelas ações que só o autor pode alterar (edição, exclusão,
//parar recorrência). O filtro por createdById garante isso mesmo que alguém chame
//a rota com o id de um lançamento alheio (Q-5).
async function loadOwnExpenseOrThrow(residenceId: number, userId: number, expenseId: string, deniedMessage: string) {
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, residenceId, createdById: userId, deletedAt: null },
    select: { id: true, name: true, month: true, year: true },
  });

  if (!expense) {
    throw new AppError(404, deniedMessage);
  }

  //Competência fechada fica somente leitura
  if (await monthIsClosed(residenceId, expense.month, expense.year)) {
    throw new AppError(409, 'Este mês já foi fechado e não aceita mais alterações.');
  }

  return expense;
}

export async function editExpense(code: string, userId: number, expenseId: string, input: ExpenseInput) {
  const context = await loadUserResidenceContext(code, userId);

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada e não aceita alterações.');
  }

  //A competência não muda: editar corrige o lançamento, não o move de mês
  const expense = await loadOwnExpenseOrThrow(
    context.residence.id,
    userId,
    expenseId,
    'Você só pode editar as despesas que você mesmo lançou.',
  );

  return prisma.expense.update({
    where: { id: expense.id },
    data: {
      name: input.name,
      valueInCents: input.valueInCents,
      category: input.category,
      isRecurring: input.isRecurring,
    },
    select: {
      id: true,
      name: true,
      valueInCents: true,
      category: true,
      isRecurring: true,
      month: true,
      year: true,
      createdById: true,
    },
  });
}

//Exclusão lógica: o registro é preservado para auditoria e para não distorcer o
//histórico já consultado por outros membros.
export async function deleteExpense(code: string, userId: number, expenseId: string): Promise<void> {
  const context = await loadUserResidenceContext(code, userId);

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada e não aceita alterações.');
  }

  const expense = await loadOwnExpenseOrThrow(
    context.residence.id,
    userId,
    expenseId,
    'Você só pode excluir as despesas que você mesmo lançou.',
  );

  await prisma.expense.update({ where: { id: expense.id }, data: { deletedAt: new Date() } });
}

//"Parar" não remove o lançamento do mês atual, só impede que ele seja recopiado no
//próximo fechamento — a despesa continua valendo normalmente até lá.
export async function stopExpenseRecurrence(code: string, userId: number, expenseId: string): Promise<void> {
  const context = await loadUserResidenceContext(code, userId);

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada e não aceita alterações.');
  }

  const expense = await loadOwnExpenseOrThrow(
    context.residence.id,
    userId,
    expenseId,
    'Você só pode alterar as despesas que você mesmo lançou.',
  );

  await prisma.expense.update({ where: { id: expense.id }, data: { isRecurring: false } });
}

//Despesas recorrentes do próprio usuário na competência informada — é o que a tela
//dedicada de gerenciamento (FEAT-025) lista, edita e para de repetir.
export async function listUserRecurringExpenses(residenceId: number, userId: number, month: number, year: number) {
  return prisma.expense.findMany({
    where: { residenceId, createdById: userId, month, year, isRecurring: true, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, valueInCents: true, category: true, isRecurring: true },
  });
}

//Resolve o contexto (RN-010: só membro) e, quando a competência não vem na
//requisição, assume a aberta (RN-020) — é o que a rota de consulta expõe.
export async function getResidenceExpenses(code: string, userId: number, requestedCompetency: Competency | null) {
  const context = await loadUserResidenceContext(code, userId);
  const competency = requestedCompetency ?? (await getOpenCompetency(context.residence.id));
  const summary = await listExpensesForCompetency(context.residence.id, competency.month, competency.year);

  return { competency, ...summary };
}

export async function getUserRecurringExpenses(code: string, userId: number, requestedCompetency: Competency | null) {
  const context = await loadUserResidenceContext(code, userId);
  const competency = requestedCompetency ?? (await getOpenCompetency(context.residence.id));
  const expenses = await listUserRecurringExpenses(context.residence.id, userId, competency.month, competency.year);

  return { competency, expenses };
}

//FEAT-025 -> ao fechar o mês, as despesas marcadas como recorrentes são recriadas
//na competência seguinte. É o gatilho possível sem agendador no projeto.
async function generateRecurringExpenses(residenceId: number, origin: Competency, destination: Competency): Promise<number> {
  const recurring = await prisma.expense.findMany({
    where: { residenceId, month: origin.month, year: origin.year, isRecurring: true, deletedAt: null },
    select: { name: true, valueInCents: true, category: true, createdById: true },
  });

  if (recurring.length === 0) {
    return 0;
  }

  const result = await prisma.expense.createMany({
    data: recurring.map((expense) => ({
      name: expense.name,
      valueInCents: expense.valueInCents,
      category: expense.category,
      month: destination.month,
      year: destination.year,
      residenceId,
      createdById: expense.createdById,
      isRecurring: true, //segue recorrente para se repetir também no mês seguinte
    })),
  });

  return result.count;
}

//Fechar a conta do mês é decisão do owner. Só a competência aberta pode ser
//fechada — nunca uma escolhida pelo cliente — então o corpo da requisição serve só
//de confirmação: se a competência informada não bater com a aberta de verdade
//(alguém fechou o mês entre o cliente carregar a tela e enviar o pedido), a
//requisição é rejeitada em vez de fechar um mês diferente do que o cliente via.
export async function closeMonth(code: string, userId: number, requestedPeriod: Competency) {
  const context = await loadUserResidenceContext(code, userId);

  if (!context.isOwner) {
    throw new AppError(403, 'Apenas o criador da residência pode fechar o mês.');
  }

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada. Desarquive-a para fechar o mês.');
  }

  const competency = await getOpenCompetency(context.residence.id);

  if (competency.month !== requestedPeriod.month || competency.year !== requestedPeriod.year) {
    throw new AppError(409, 'A competência aberta mudou. Atualize a página e tente novamente.');
  }

  const next = getNextCompetency(competency);

  const closure = await prisma.monthClosure.create({
    data: {
      residenceId: context.residence.id,
      month: competency.month,
      year: competency.year,
      closedById: userId,
    },
    select: { id: true, month: true, year: true, closedAt: true },
  });

  //FEAT-025: as recorrentes do mês fechado renascem na competência seguinte
  const recurringExpensesGenerated = await generateRecurringExpenses(context.residence.id, competency, next);

  //MONTH_CLOSED: todos os membros são avisados de que a conta foi fechada
  const members = await prisma.membership.findMany({
    where: { residenceId: context.residence.id },
    select: { userId: true },
  });

  await createNotifications(
    members.map((member) => ({
      userId: member.userId,
      type: 'MONTH_CLOSED' as const,
      title: 'Conta do mês fechada',
      message: `A conta de ${competency.month}/${competency.year} da residência "${context.residence.name}" foi fechada.`,
      linkTo: `/app/residences/${context.residence.code}/expenses?mes=${competency.month}&ano=${competency.year}`,
    })),
  );

  return { closure, recurringExpensesGenerated };
}

//Reabrir é do owner, assim como fechar. Só o fechamento mais recente pode ser
//desfeito: reabrir um mês do meio deixaria buracos na sequência de meses fechados,
//que é o que dá sentido à ideia de "conta acertada até tal mês". O período pedido
//precisa bater com esse fechamento mais recente.
export async function reopenMonth(code: string, userId: number, period: Competency) {
  const context = await loadUserResidenceContext(code, userId);

  if (!context.isOwner) {
    throw new AppError(403, 'Apenas o criador da residência pode reabrir um mês.');
  }

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada. Desarquive-a para reabrir um mês.');
  }

  const latestClosure = await prisma.monthClosure.findFirst({
    where: { residenceId: context.residence.id },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    select: { id: true, month: true, year: true },
  });

  if (!latestClosure) {
    throw new AppError(404, 'Não há nenhum mês fechado nesta residência.');
  }

  if (latestClosure.month !== period.month || latestClosure.year !== period.year) {
    throw new AppError(409, 'Apenas o mês fechado mais recente pode ser reaberto.');
  }

  await prisma.monthClosure.delete({ where: { id: latestClosure.id } });

  return { month: latestClosure.month, year: latestClosure.year };
}
