import { calculateInviteExpiration, normalizeResidenceCode } from '../../src/modules/residences/residences.service.js';

describe('normalizeResidenceCode (RN-012)', () => {
  it('remove espaços nas pontas e converte para maiúsculas', () => {
    expect(normalizeResidenceCode('  ab12cd  ')).toBe('AB12CD');
  });

  it('devolve string vazia para valores que não são string', () => {
    expect(normalizeResidenceCode(undefined)).toBe('');
    expect(normalizeResidenceCode(123)).toBe('');
    expect(normalizeResidenceCode(null)).toBe('');
  });
});

describe('calculateInviteExpiration (RN-015)', () => {
  it('devolve uma data 7 dias no futuro', () => {
    const before = Date.now();
    const expiration = calculateInviteExpiration();
    const after = Date.now();

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiration.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    expect(expiration.getTime()).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
  });
});
