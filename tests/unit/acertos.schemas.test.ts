import { receiptIntentSchema, waiveSettlementSchema } from '../../src/schemas/acertos.js';

describe('receiptIntentSchema (RN-081)', () => {
  it('aceita um payload válido', () => {
    const result = receiptIntentSchema.safeParse({
      contentType: 'image/jpeg',
      sizeInBytes: 244121,
      originalName: 'comprovante.jpg',
    });
    expect(result.success).toBe(true);
  });

  it('aceita sem originalName (opcional)', () => {
    expect(receiptIntentSchema.safeParse({ contentType: 'application/pdf', sizeInBytes: 1000 }).success).toBe(true);
  });

  it('rejeita Content-Type fora da lista (D-15): HEIC, GIF e SVG de propósito', () => {
    for (const contentType of ['image/heic', 'image/gif', 'image/svg+xml', 'application/zip']) {
      expect(receiptIntentSchema.safeParse({ contentType, sizeInBytes: 1000 }).success).toBe(false);
    }
  });

  it('rejeita tamanho acima de 5 MB', () => {
    expect(
      receiptIntentSchema.safeParse({ contentType: 'image/jpeg', sizeInBytes: 5 * 1024 * 1024 + 1 }).success,
    ).toBe(false);
  });

  it('aceita exatamente o teto de 5 MB', () => {
    expect(receiptIntentSchema.safeParse({ contentType: 'image/jpeg', sizeInBytes: 5 * 1024 * 1024 }).success).toBe(
      true,
    );
  });

  it('rejeita tamanho zero ou negativo', () => {
    expect(receiptIntentSchema.safeParse({ contentType: 'image/jpeg', sizeInBytes: 0 }).success).toBe(false);
    expect(receiptIntentSchema.safeParse({ contentType: 'image/jpeg', sizeInBytes: -1 }).success).toBe(false);
  });

  it('rejeita originalName acima de 120 caracteres', () => {
    expect(
      receiptIntentSchema.safeParse({ contentType: 'image/jpeg', sizeInBytes: 1000, originalName: 'a'.repeat(121) })
        .success,
    ).toBe(false);
  });
});

describe('waiveSettlementSchema (D-07/RN-082)', () => {
  it('aceita um motivo válido', () => {
    expect(waiveSettlementSchema.safeParse({ reason: 'Morador saiu da residência.' }).success).toBe(true);
  });

  it('rejeita motivo curto demais (menos de 3 caracteres)', () => {
    expect(waiveSettlementSchema.safeParse({ reason: 'Oi' }).success).toBe(false);
  });

  it('rejeita motivo vazio', () => {
    expect(waiveSettlementSchema.safeParse({ reason: '' }).success).toBe(false);
  });

  it('rejeita motivo acima de 200 caracteres', () => {
    expect(waiveSettlementSchema.safeParse({ reason: 'a'.repeat(201) }).success).toBe(false);
  });
});
