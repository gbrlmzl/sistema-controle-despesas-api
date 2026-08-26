import { simplifyDebts, type DebtPair } from '../../src/services/reports/splitService.js';

// D-29 -> testado isolado de closeMonth: não depende de banco, só da lista de saldos
// líquidos que calculateSplit já garante somar exatamente zero (RN-066).

function sumByPayer(pairs: DebtPair[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const pair of pairs) totals.set(pair.payerId, (totals.get(pair.payerId) ?? 0) + pair.amountInCents);
  return totals;
}

function sumByReceiver(pairs: DebtPair[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const pair of pairs) totals.set(pair.receiverId, (totals.get(pair.receiverId) ?? 0) + pair.amountInCents);
  return totals;
}

describe('simplifyDebts (D-29)', () => {
  it('saldo zero não entra no algoritmo e não gera par (RN-071)', () => {
    const pairs = simplifyDebts([
      { userId: 1, balanceInCents: 0 },
      { userId: 2, balanceInCents: -100 },
      { userId: 3, balanceInCents: 100 },
    ]);
    expect(pairs.some((p) => p.payerId === 1 || p.receiverId === 1)).toBe(false);
  });

  it('lista vazia devolve nenhum par', () => {
    expect(simplifyDebts([])).toEqual([]);
  });

  it('um devedor e um credor geram um único par com o valor exato', () => {
    const pairs = simplifyDebts([
      { userId: 1, balanceInCents: -500 },
      { userId: 2, balanceInCents: 500 },
    ]);
    expect(pairs).toEqual([{ payerId: 1, receiverId: 2, amountInCents: 500 }]);
  });

  it('produz no máximo devedores + credores − 1 linhas, e nenhum saldo residual', () => {
    const participants = [
      { userId: 1, balanceInCents: -700 },
      { userId: 2, balanceInCents: -300 },
      { userId: 3, balanceInCents: 500 },
      { userId: 4, balanceInCents: 500 },
    ];
    const pairs = simplifyDebts(participants);

    expect(pairs.length).toBeLessThanOrEqual(2 /* devedores */ + 2 /* credores */ - 1);

    const byPayer = sumByPayer(pairs);
    const byReceiver = sumByReceiver(pairs);
    expect(byPayer.get(1)).toBe(700);
    expect(byPayer.get(2)).toBe(300);
    expect([...byReceiver.values()].reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('a soma de amountInCents por devedor bate com o valor absoluto do saldo dele', () => {
    const participants = [
      { userId: 10, balanceInCents: -219_10 },
      { userId: 11, balanceInCents: -107_62 },
      { userId: 12, balanceInCents: 150_00 },
      { userId: 13, balanceInCents: 176_72 },
    ];
    const pairs = simplifyDebts(participants);
    const byPayer = sumByPayer(pairs);

    expect(byPayer.get(10)).toBe(219_10);
    expect(byPayer.get(11)).toBe(107_62);
  });

  it('nunca sobra devedor ou credor com saldo positivo ao final (RN-066)', () => {
    const participants = Array.from({ length: 9 }, (_, i) => ({
      userId: i + 1,
      // Saldos variados que somam zero: 4 devedores, 5 credores desiguais.
      balanceInCents: [-1000, -2500, -300, -4200, 900, 1800, 1200, 2100, 2000][i],
    }));
    expect(participants.reduce((sum, p) => sum + p.balanceInCents, 0)).toBe(0);

    const pairs = simplifyDebts(participants);
    const totalPaid = pairs.reduce((sum, p) => sum + p.amountInCents, 0);
    const totalOwed = participants.filter((p) => p.balanceInCents < 0).reduce((sum, p) => sum - p.balanceInCents, 0);
    expect(totalPaid).toBe(totalOwed);
  });

  it('ordem de entrada não muda o resultado — só a ordenação interna decide (determinístico)', () => {
    const a = [
      { userId: 1, balanceInCents: -400 },
      { userId: 2, balanceInCents: 250 },
      { userId: 3, balanceInCents: 150 },
    ];
    const b = [a[2], a[0], a[1]];

    expect(simplifyDebts(a)).toEqual(simplifyDebts(b));
  });

  it('empate de valor é desempatado por userId ascendente, de forma determinística', () => {
    const participants = [
      { userId: 5, balanceInCents: -100 },
      { userId: 2, balanceInCents: -100 },
      { userId: 8, balanceInCents: 100 },
      { userId: 3, balanceInCents: 100 },
    ];
    const pairs = simplifyDebts(participants);
    // O menor userId devedor (2) casa com o menor userId credor (3) primeiro.
    expect(pairs[0]).toEqual({ payerId: 2, receiverId: 3, amountInCents: 100 });
  });
});
