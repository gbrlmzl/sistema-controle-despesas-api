import * as z from 'zod';

export const EXPENSE_CATEGORIES = ['ALIMENTACAO', 'DOMESTICAS', 'ASSINATURAS', 'LAZER', 'OUTROS'] as const;

//O valor chega em centavos já convertido pelo cliente — diferente do formulário
//HTML original, aqui não há string digitada (vírgula/ponto) para interpretar.
export const expenseSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'O nome da despesa deve ter no mínimo 2 caracteres')
    .max(60, 'O nome da despesa deve ter no máximo 60 caracteres'),
  valueInCents: z.number().int().positive('O valor deve ser maior que zero'),
  category: z.enum(EXPENSE_CATEGORIES, { message: 'Selecione uma categoria' }),
  isRecurring: z.boolean(),
});

export const monthClosureSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
});
