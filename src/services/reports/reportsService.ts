import prisma from '../../config/prisma.js';
import type { ExpenseCategory } from '../../generated/client.js';
import { loadUserResidenceContext } from '../residences/residencesService.js';
import { getOpenCompetency, type Competency } from '../expenses/expensesService.js';
//3.1 do plano de acertos -> calculateSplit mora em splitService.ts agora (ela usa só
//`prisma`, sem importar nenhum service, o que evita ciclo com expensesService.ts).
//Reexportada aqui para não quebrar quem já importa calculateSplit de reportsService
//(e importada normalmente, não só re-exportada, porque este arquivo também a usa abaixo).
import { calculateSplit } from './splitService.js';
export { calculateSplit };

//RN-062 -> o gráfico de evolução mostra as últimas 6 competências
export const COMPETENCIES_IN_EVOLUTION = 6;
//RN-068 -> a média usa as 3 competências anteriores, sinalizando desvio a partir de
//30%, e exige ao menos 2 meses de histórico para não alarmar com base num único mês.
export const COMPETENCIES_IN_AVERAGE = 3;
export const DEVIATION_THRESHOLD = 0.3;
export const MINIMUM_COMPETENCIES_FOR_AVERAGE = 2;

export function getPreviousCompetency({ month, year }: Competency): Competency {
  return month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
}

function baseFilter(residenceId: number, month: number, year: number, userId: number | null) {
  return {
    residenceId,
    month,
    year,
    deletedAt: null as null, //RN-057: lançamentos excluídos ficam de fora do relatório
    ...(userId ? { createdById: userId } : {}),
  };
}

//FEAT-026 -> quebra por categoria de uma competência. Passar userId restringe ao
//relatório pessoal (RN-060: sempre dentro da residência atual).
export async function categoryReport(residenceId: number, month: number, year: number, userId: number | null = null) {
  const grouped = await prisma.expense.groupBy({
    by: ['category'],
    where: baseFilter(residenceId, month, year, userId),
    _sum: { valueInCents: true },
    _count: { _all: true },
  });

  const totalInCents = grouped.reduce((sum, item) => sum + (item._sum.valueInCents ?? 0), 0);

  //CA-4 -> categorias sem lançamento simplesmente não aparecem, porque o groupBy só
  //devolve o que existe. CA-3 -> da que mais gastou para a que menos gastou.
  const categories = grouped
    .map((item) => ({
      category: item.category,
      totalInCents: item._sum.valueInCents ?? 0,
      count: item._count._all,
      //RN-058 -> o percentual é sobre o total da competência exibida
      percentage: totalInCents > 0 ? ((item._sum.valueInCents ?? 0) / totalInCents) * 100 : 0,
    }))
    .sort((a, b) => b.totalInCents - a.totalInCents);

  return { categories, totalInCents };
}

//FEAT-027 -> variação entre duas competências, no total e por categoria.
export async function compareCompetencies(
  residenceId: number,
  current: Competency,
  previous: Competency,
  userId: number | null = null,
) {
  const [currentReport, previousReport] = await Promise.all([
    categoryReport(residenceId, current.month, current.year, userId),
    categoryReport(residenceId, previous.month, previous.year, userId),
  ]);

  const previousByCategory = new Map(previousReport.categories.map((item) => [item.category, item.totalInCents]));
  const seenCategories = new Set([
    ...currentReport.categories.map((item) => item.category),
    ...previousReport.categories.map((item) => item.category),
  ]);

  const categories = [...seenCategories]
    .map((category) => {
      const currentValue = currentReport.categories.find((item) => item.category === category)?.totalInCents ?? 0;
      const previousValue = previousByCategory.get(category) ?? 0;

      return {
        category,
        currentInCents: currentValue,
        previousInCents: previousValue,
        variationInCents: currentValue - previousValue,
        //RN-061 -> sem base de comparação não existe percentual com leitura útil. A
        //categoria é marcada como nova e o percentual fica nulo.
        isNew: previousValue === 0 && currentValue > 0,
        percentage: previousValue > 0 ? ((currentValue - previousValue) / previousValue) * 100 : null,
      };
    })
    .sort((a, b) => Math.abs(b.variationInCents) - Math.abs(a.variationInCents));

  return {
    totalCurrentInCents: currentReport.totalInCents,
    totalPreviousInCents: previousReport.totalInCents,
    variationInCents: currentReport.totalInCents - previousReport.totalInCents,
    percentage:
      previousReport.totalInCents > 0
        ? ((currentReport.totalInCents - previousReport.totalInCents) / previousReport.totalInCents) * 100
        : null,
    hasComparisonBase: previousReport.totalInCents > 0,
    categories,
  };
}

//FEAT-028 -> série das últimas competências até a selecionada, para o gráfico de evolução.
export async function evolutionSeries(
  residenceId: number,
  until: Competency,
  quantity: number = COMPETENCIES_IN_EVOLUTION,
  userId: number | null = null,
) {
  //Monta a janela andando para trás a partir da competência exibida
  const window: Competency[] = [];
  let cursor: Competency = { month: until.month, year: until.year };

  for (let i = 0; i < quantity; i++) {
    window.unshift({ ...cursor });
    cursor = getPreviousCompetency(cursor);
  }

  return Promise.all(
    window.map(async (competency) => {
      const aggregate = await prisma.expense.aggregate({
        where: baseFilter(residenceId, competency.month, competency.year, userId),
        _sum: { valueInCents: true },
      });

      return {
        month: competency.month,
        year: competency.year,
        totalInCents: aggregate._sum.valueInCents ?? 0,
      };
    }),
  );
}

//FEAT-035 -> média das competências anteriores por categoria, para sinalizar desvios.
export async function averagesByCategory(residenceId: number, until: Competency, userId: number | null = null) {
  const window: Competency[] = [];
  let cursor = getPreviousCompetency(until);

  for (let i = 0; i < COMPETENCIES_IN_AVERAGE; i++) {
    window.push({ ...cursor });
    cursor = getPreviousCompetency(cursor);
  }

  const reports = await Promise.all(window.map((competency) => categoryReport(residenceId, competency.month, competency.year, userId)));

  //Só entram no cálculo as competências em que a categoria realmente teve
  //lançamento; meses sem movimento puxariam a média para baixo e gerariam alarme falso.
  const accumulated = new Map<ExpenseCategory, { sum: number; months: number }>();

  for (const report of reports) {
    for (const category of report.categories) {
      const current = accumulated.get(category.category) ?? { sum: 0, months: 0 };
      current.sum += category.totalInCents;
      current.months += 1;
      accumulated.set(category.category, current);
    }
  }

  const averages = new Map<ExpenseCategory, { averageInCents: number; monthsConsidered: number; reliable: boolean }>();

  for (const [category, data] of accumulated) {
    averages.set(category, {
      averageInCents: Math.round(data.sum / data.months),
      monthsConsidered: data.months,
      //CA-4 -> sem histórico suficiente a categoria não é sinalizada
      reliable: data.months >= MINIMUM_COMPETENCIES_FOR_AVERAGE,
    });
  }

  return averages;
}

//Junta a quebra por categoria com a média histórica, marcando os desvios relevantes.
export async function reportWithDeviations(residenceId: number, competency: Competency, userId: number | null = null) {
  const [report, averages] = await Promise.all([
    categoryReport(residenceId, competency.month, competency.year, userId),
    averagesByCategory(residenceId, competency, userId),
  ]);

  const categories = report.categories.map((category) => {
    const average = averages.get(category.category);

    if (!average || !average.reliable || average.averageInCents === 0) {
      return { ...category, averageInCents: average?.averageInCents ?? null, deviation: null as number | null, aboveAverage: null as boolean | null };
    }

    const deviation = (category.totalInCents - average.averageInCents) / average.averageInCents;

    return {
      ...category,
      averageInCents: average.averageInCents,
      deviation: Math.abs(deviation) >= DEVIATION_THRESHOLD ? deviation : null,
      aboveAverage: deviation > 0,
    };
  });

  return { categories, totalInCents: report.totalInCents };
}

//FEAT-033 -> linhas da exportação, já com autor e categoria resolvidos.
export async function expensesForExport(residenceId: number, month: number, year: number, userId: number | null = null) {
  const expenses = await prisma.expense.findMany({
    where: baseFilter(residenceId, month, year, userId),
    orderBy: { createdAt: 'asc' },
    select: {
      createdAt: true,
      name: true,
      category: true,
      valueInCents: true,
      isRecurring: true,
      createdBy: { select: { name: true } },
    },
  });

  return expenses.map((expense) => ({
    createdAt: expense.createdAt,
    name: expense.name,
    category: expense.category,
    valueInCents: expense.valueInCents,
    isRecurring: expense.isRecurring,
    authorName: expense.createdBy.name,
  }));
}

export type ReportTab = 'residence' | 'personal';

//RN-010: só membro vê o relatório. CA-1 da US-024: a tela abre na aba da residência.
//RN-060: a aba pessoal olha só para esta residência, nunca soma as outras.
export async function getResidenceReport(code: string, userId: number, requestedCompetency: Competency | null, tab: ReportTab) {
  const context = await loadUserResidenceContext(code, userId);

  const competency = requestedCompetency ?? (await getOpenCompetency(context.residence.id));
  const filterUserId = tab === 'personal' ? userId : null;

  const [report, comparison, evolution, split, householdTotal, expenses] = await Promise.all([
    reportWithDeviations(context.residence.id, competency, filterUserId),
    compareCompetencies(context.residence.id, competency, getPreviousCompetency(competency), filterUserId),
    evolutionSeries(context.residence.id, competency, COMPETENCIES_IN_EVOLUTION, filterUserId),
    calculateSplit(context.residence.id, competency.month, competency.year),
    //CA-4 da US-025 -> o percentual que os gastos do usuário representam do total da casa
    reportWithDeviations(context.residence.id, competency, null),
    expensesForExport(context.residence.id, competency.month, competency.year, filterUserId),
  ]);

  return {
    competency,
    tab,
    report,
    comparison,
    evolution,
    split,
    householdTotalInCents: householdTotal.totalInCents,
    expenses,
  };
}
