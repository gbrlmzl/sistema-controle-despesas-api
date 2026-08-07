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
