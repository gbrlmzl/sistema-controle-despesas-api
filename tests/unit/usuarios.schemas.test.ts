import { AVATARS, changePasswordSchema, updateAvatarSchema } from '../../src/schemas/usuarios.js';

describe('updateAvatarSchema', () => {
  it('aceita um avatar da whitelist', () => {
    expect(updateAvatarSchema.safeParse({ avatar: AVATARS[0] }).success).toBe(true);
  });

  it('rejeita um avatar fora da whitelist', () => {
    expect(updateAvatarSchema.safeParse({ avatar: '/avatars/avatar-99.svg' }).success).toBe(false);
  });

  it('rejeita corpo sem avatar', () => {
    expect(updateAvatarSchema.safeParse({}).success).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  const valid = {
    currentPassword: 'senhaAtual1',
    newPassword: 'senhaNova1',
    confirmNewPassword: 'senhaNova1',
  };

  it('aceita um payload válido', () => {
    expect(changePasswordSchema.safeParse(valid).success).toBe(true);
  });

  it('rejeita nova senha curta demais', () => {
    expect(
      changePasswordSchema.safeParse({ ...valid, newPassword: 'a1', confirmNewPassword: 'a1' }).success,
    ).toBe(false);
  });

  it('rejeita nova senha sem número ou símbolo', () => {
    expect(
      changePasswordSchema.safeParse({ ...valid, newPassword: 'somenteletras', confirmNewPassword: 'somenteletras' })
        .success,
    ).toBe(false);
  });

  it('rejeita quando a confirmação não bate com a nova senha', () => {
    const result = changePasswordSchema.safeParse({ ...valid, confirmNewPassword: 'outraSenha1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['confirmNewPassword']);
    }
  });

  it('rejeita senha atual vazia', () => {
    expect(changePasswordSchema.safeParse({ ...valid, currentPassword: '' }).success).toBe(false);
  });
});
