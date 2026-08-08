import prisma from '../../config/prisma.js';

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
