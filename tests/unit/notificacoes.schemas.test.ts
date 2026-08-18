import { markNotificationsReadSchema } from '../../src/schemas/notificacoes.js';

describe('markNotificationsReadSchema', () => {
  it('aceita { all: true }', () => {
    expect(markNotificationsReadSchema.safeParse({ all: true }).success).toBe(true);
  });

  it('aceita uma lista de ids', () => {
    expect(markNotificationsReadSchema.safeParse({ ids: [1, 2, 3] }).success).toBe(true);
  });

  it('rejeita corpo vazio (nem all nem ids)', () => {
    expect(markNotificationsReadSchema.safeParse({}).success).toBe(false);
  });

  it('rejeita lista de ids vazia', () => {
    expect(markNotificationsReadSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  //SEC-07 -> sem teto, um array de 100 mil ids vira um WHERE id IN (...) com 100 mil
  //parâmetros, e o corpo ainda cabe no limite de 32kb do express.json().
  it('aceita exatamente 200 ids (o teto)', () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(markNotificationsReadSchema.safeParse({ ids }).success).toBe(true);
  });

  it('rejeita mais de 200 ids', () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    expect(markNotificationsReadSchema.safeParse({ ids }).success).toBe(false);
  });

  it('rejeita ids não inteiros ou não positivos', () => {
    expect(markNotificationsReadSchema.safeParse({ ids: [1.5] }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({ ids: [0] }).success).toBe(false);
  });
});
