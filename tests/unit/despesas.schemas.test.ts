import { expenseSchema, monthClosureSchema } from '../../src/schemas/despesas.js';

describe('expenseSchema', () => {
  it('aceita um payload válido', () => {
    const result = expenseSchema.safeParse({
      name: 'Supermercado',
      valueInCents: 18050,
      category: 'ALIMENTACAO',
      isRecurring: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejeita nome curto demais', () => {
    expect(expenseSchema.safeParse({ name: 'A', valueInCents: 100, category: 'OUTROS', isRecurring: false }).success).toBe(
      false,
    );
  });

  it('rejeita valor zero ou negativo', () => {
    expect(
      expenseSchema.safeParse({ name: 'Aluguel', valueInCents: 0, category: 'OUTROS', isRecurring: false }).success,
    ).toBe(false);
    expect(
      expenseSchema.safeParse({ name: 'Aluguel', valueInCents: -100, category: 'OUTROS', isRecurring: false }).success,
    ).toBe(false);
  });

  it('rejeita valor não inteiro (centavos fracionados)', () => {
    expect(
      expenseSchema.safeParse({ name: 'Aluguel', valueInCents: 100.5, category: 'OUTROS', isRecurring: false }).success,
    ).toBe(false);
  });

  it('rejeita categoria fora do enum', () => {
    expect(
      expenseSchema.safeParse({ name: 'Aluguel', valueInCents: 100, category: 'VIAGEM', isRecurring: false }).success,
    ).toBe(false);
  });
});

describe('monthClosureSchema', () => {
  it('aceita mês e ano válidos', () => {
    expect(monthClosureSchema.safeParse({ month: 8, year: 2026 }).success).toBe(true);
  });

  it('rejeita mês fora do intervalo 1-12', () => {
    expect(monthClosureSchema.safeParse({ month: 0, year: 2026 }).success).toBe(false);
    expect(monthClosureSchema.safeParse({ month: 13, year: 2026 }).success).toBe(false);
  });
});
