// 3.1 do plano de acertos (docs/plano-registro-de-pagamentos.md) -> calculateSplit foi
// movida para cá, isolada num arquivo que usa só `prisma`. reportsService.ts já importa
// de expensesService.ts; se expensesService.ts (closeMonth) passasse a importar
// calculateSplit de volta de reportsService.ts, haveria ciclo de import. Este arquivo
// não importa nenhum outro service, então tanto reportsService quanto expensesService
// podem importar dele sem ciclo.

import prisma from '../../config/prisma.js';

//FEAT-029 -> rateio por divisão igual, como no cálculo da V1. RN-065 -> a cota é
//dividida entre os membros atuais. Quem sai leva junto os lançamentos da competência
//aberta (RN-022), então o total não fica inflado por gastos de quem não está mais na casa.
export async function calculateSplit(residenceId: number, month: number, year: number) {
  const [members, expenses] = await Promise.all([
    prisma.membership.findMany({
      where: { residenceId },
      orderBy: { joinedAt: 'asc' },
      select: { userId: true, user: { select: { name: true } } },
    }),
    prisma.expense.findMany({
      where: { residenceId, month, year, deletedAt: null }, //RN-057: excluídos ficam de fora
      select: { createdById: true, valueInCents: true },
    }),
  ]);

  const totalInCents = expenses.reduce((sum, expense) => sum + expense.valueInCents, 0);
  const memberCount = members.length;

  if (memberCount === 0 || totalInCents === 0) {
    return { shareInCents: 0, totalInCents, participants: [], hasSplit: false };
  }

  //RN-066 -> a divisão em centavos raramente é exata. A sobra é distribuída de um em
  //um centavo entre os primeiros participantes, o que mantém a soma das cotas igual
  //ao total e, por consequência, a soma dos saldos exatamente em zero.
  const baseShare = Math.floor(totalInCents / memberCount);
  const remainder = totalInCents - baseShare * memberCount;

  const spentByMember = new Map<number, number>();
  for (const expense of expenses) {
    spentByMember.set(expense.createdById, (spentByMember.get(expense.createdById) ?? 0) + expense.valueInCents);
  }

  const participants = members
    .map((member, index) => {
      const shareInCents = baseShare + (index < remainder ? 1 : 0);
      const spentInCents = spentByMember.get(member.userId) ?? 0;
      const balanceInCents = spentInCents - shareInCents;

      return {
        userId: member.userId,
        name: member.user.name,
        spentInCents,
        shareInCents,
        balanceInCents,
        receives: balanceInCents > 0,
        pays: balanceInCents < 0,
      };
    })
    .sort((a, b) => b.balanceInCents - a.balanceInCents);

  return { shareInCents: baseShare, totalInCents, participants, hasSplit: true };
}

//D-29 -> Consequência direta de D-01=B. Recebe o saldo líquido por participante que
//calculateSplit já calcula (soma exatamente zero, RN-066) e devolve PARES devedor→credor
//por um algoritmo guloso ("simplify debts"), o mesmo usado por Splitwise e Settle Up.
//Heurístico, não a solução ótima: minimizar o número de transferências no caso geral é
//NP-difícil, mas o guloso abaixo produz no máximo devedores + credores − 1 linhas, sem
//deixar resíduo — não é uma divisão fracionária, só transferência de centavos inteiros
//entre saldos que já fecham em zero.
export interface DebtPair {
  payerId: number;
  receiverId: number;
  amountInCents: number;
}

export function simplifyDebts(
  participants: Array<{ userId: number; balanceInCents: number }>,
): DebtPair[] {
  //RN-071 -> saldo zero não entra no algoritmo e não gera par.
  const debtors = participants
    .filter((p) => p.balanceInCents < 0)
    .map((p) => ({ userId: p.userId, remaining: -p.balanceInCents }))
    //Ordem decrescente por valor, userId como desempate — determinístico (D-29).
    .sort((a, b) => b.remaining - a.remaining || a.userId - b.userId);
  const creditors = participants
    .filter((p) => p.balanceInCents > 0)
    .map((p) => ({ userId: p.userId, remaining: p.balanceInCents }))
    .sort((a, b) => b.remaining - a.remaining || a.userId - b.userId);

  const pairs: DebtPair[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].remaining, creditors[j].remaining);
    pairs.push({ payerId: debtors[i].userId, receiverId: creditors[j].userId, amountInCents: amount });
    debtors[i].remaining -= amount;
    creditors[j].remaining -= amount;
    if (debtors[i].remaining === 0) i++;
    if (creditors[j].remaining === 0) j++;
  }
  //RN-066 garante soma zero: as duas listas terminam vazias juntas, sem resíduo.
  return pairs;
}
