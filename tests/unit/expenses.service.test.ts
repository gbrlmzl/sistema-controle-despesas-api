import { getNextCompetency } from '../../src/modules/expenses/expenses.service.js';
import { getPreviousCompetency } from '../../src/modules/reports/reports.service.js';

describe('getNextCompetency', () => {
  it('avança um mês dentro do mesmo ano', () => {
    expect(getNextCompetency({ month: 3, year: 2026 })).toEqual({ month: 4, year: 2026 });
  });

  it('vira o ano em dezembro', () => {
    expect(getNextCompetency({ month: 12, year: 2026 })).toEqual({ month: 1, year: 2027 });
  });
});

describe('getPreviousCompetency', () => {
  it('volta um mês dentro do mesmo ano', () => {
    expect(getPreviousCompetency({ month: 3, year: 2026 })).toEqual({ month: 2, year: 2026 });
  });

  it('volta o ano em janeiro', () => {
    expect(getPreviousCompetency({ month: 1, year: 2026 })).toEqual({ month: 12, year: 2025 });
  });
});
