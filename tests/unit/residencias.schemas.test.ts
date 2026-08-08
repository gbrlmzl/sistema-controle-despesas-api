import {
  createJoinRequestSchema,
  createResidenceSchema,
  inviteUserSchema,
  residenceNameSchema,
  transferOwnerSchema,
  updateResidenceSchema,
} from '../../src/schemas/residencias.js';

describe('residenceNameSchema (RN-003)', () => {
  it('aceita nomes com letras, números e espaços dentro do intervalo de tamanho', () => {
    expect(residenceNameSchema.safeParse('Casa 2').success).toBe(true);
  });

  it('rejeita nome curto demais', () => {
    expect(residenceNameSchema.safeParse('Ab').success).toBe(false);
  });

  it('rejeita caracteres fora de letras/números/espaços', () => {
    expect(residenceNameSchema.safeParse('Casa #2!').success).toBe(false);
  });

  it('remove espaços nas pontas antes de validar', () => {
    const result = createResidenceSchema.safeParse({ name: '  Casa da Praia  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Casa da Praia');
    }
  });
});

describe('createJoinRequestSchema (RN-004 / RN-012)', () => {
  it('normaliza o código pra maiúsculas e sem espaços antes de validar o formato', () => {
    const result = createJoinRequestSchema.safeParse({ code: ' ab12cd ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe('AB12CD');
    }
  });

  it('rejeita código com tamanho diferente de 6', () => {
    expect(createJoinRequestSchema.safeParse({ code: 'AB12' }).success).toBe(false);
  });
});

describe('updateResidenceSchema', () => {
  it('rejeita corpo vazio (nenhum campo pra atualizar)', () => {
    expect(updateResidenceSchema.safeParse({}).success).toBe(false);
  });

  it('aceita apenas name', () => {
    expect(updateResidenceSchema.safeParse({ name: 'Casa Nova' }).success).toBe(true);
  });

  it('aceita apenas archived', () => {
    expect(updateResidenceSchema.safeParse({ archived: true }).success).toBe(true);
  });
});

describe('transferOwnerSchema', () => {
  it('rejeita userId não inteiro', () => {
    expect(transferOwnerSchema.safeParse({ userId: 1.5 }).success).toBe(false);
  });

  it('rejeita userId não positivo', () => {
    expect(transferOwnerSchema.safeParse({ userId: 0 }).success).toBe(false);
  });
});

describe('inviteUserSchema', () => {
  it('rejeita username vazio', () => {
    expect(inviteUserSchema.safeParse({ username: '' }).success).toBe(false);
  });
});
