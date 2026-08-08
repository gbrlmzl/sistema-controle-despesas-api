import * as z from 'zod';

//Identificador público do usuário. É por ele que um usuário convida outro
//para uma residência, sem precisar expor o email.
export const usernameSchema = z
  .string()
  .min(3, 'O nome de usuário deve ter no mínimo 3 caracteres')
  .max(20, 'O nome de usuário deve ter no máximo 20 caracteres')
  .regex(/^[a-z0-9_]+$/, 'O nome de usuário aceita apenas letras minúsculas, números e _');

export const registerSchema = z
  .object({
    name: z.string().min(1, 'O nome não pode estar vazio').max(100),
    username: usernameSchema,
    email: z.email('Email inválido'),
    password: z
      .string()
      .min(8, 'A senha deve ter no mínimo 8 caracteres')
      .max(100)
      .refine((p) => /[\d\W]/.test(p)),
    confirmPassword: z.string().min(1, 'Confirme a senha'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'As senhas não coincidem',
  });

export const loginSchema = z.object({
  email: z.email('Email inválido'),
  password: z.string().min(1, 'Informe a senha'),
});

//Fonte única de verdade dos avatares pré-definidos. Cada caminho aponta para um SVG
//servido estaticamente pelo front-end a partir de /public/avatars — a API só valida
//que o valor recebido está na whitelist, não serve os arquivos.
export const AVATARS = [
  '/avatars/avatar-01.svg',
  '/avatars/avatar-02.svg',
  '/avatars/avatar-03.svg',
  '/avatars/avatar-04.svg',
  '/avatars/avatar-05.svg',
  '/avatars/avatar-06.svg',
  '/avatars/avatar-07.svg',
  '/avatars/avatar-08.svg',
  '/avatars/avatar-09.svg',
  '/avatars/avatar-10.svg',
  '/avatars/avatar-11.svg',
  '/avatars/avatar-12.svg',
  '/avatars/avatar-13.svg',
  '/avatars/avatar-14.svg',
  '/avatars/avatar-15.svg',
  '/avatars/avatar-16.svg',
  '/avatars/avatar-17.svg',
  '/avatars/avatar-18.svg',
  '/avatars/avatar-19.svg',
  '/avatars/avatar-20.svg',
] as const;

export const updateAvatarSchema = z.object({
  avatar: z.enum(AVATARS, { message: 'Avatar inválido' }),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Informe a senha atual'),
    newPassword: z
      .string()
      .min(8, 'A nova senha deve ter no mínimo 8 caracteres')
      .max(100)
      .refine((p) => /[\d\W]/.test(p), 'A nova senha deve conter ao menos um número ou símbolo'),
    confirmNewPassword: z.string().min(1, 'Confirme a nova senha'),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    path: ['confirmNewPassword'],
    message: 'As novas senhas não coincidem',
  });
