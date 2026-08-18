import * as z from 'zod';

//Identificador público do usuário. É por ele que um usuário convida outro
//para uma residência, sem precisar expor o email.
export const usernameSchema = z
  .string()
  .min(3, 'O nome de usuário deve ter no mínimo 3 caracteres')
  .max(20, 'O nome de usuário deve ter no máximo 20 caracteres')
  .regex(/^[a-z0-9_]+$/, 'O nome de usuário aceita apenas letras minúsculas, números e _');

export const nameSchema = z.string().min(1, 'O nome não pode estar vazio').max(100);

// Regra de senha compartilhada entre registro, troca de senha e redefinição por
// email — três lugares diferentes que precisam concordar exatamente na mesma regra,
// senão um schema aceita o que o outro rejeita.
export const passwordSchema = z
  .string()
  .min(8, 'A senha deve ter no mínimo 8 caracteres')
  .max(100)
  .refine((p) => /[\d\W]/.test(p), 'A senha deve conter ao menos um número ou símbolo');

export const registerSchema = z
  .object({
    name: nameSchema,
    username: usernameSchema,
    email: z.email('Email inválido'),
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Confirme a senha'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'As senhas não coincidem',
  });

export const loginSchema = z.object({
  username: usernameSchema,
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

export const updateProfileSchema = z
  .object({
    name: nameSchema.optional(),
    avatar: z.enum(AVATARS, { message: 'Avatar inválido' }).optional(),
  })
  .refine((data) => data.name !== undefined || data.avatar !== undefined, {
    message: 'Informe ao menos um campo para atualizar.',
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Informe a senha atual'),
    newPassword: passwordSchema,
    confirmNewPassword: z.string().min(1, 'Confirme a nova senha'),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    path: ['confirmNewPassword'],
    message: 'As novas senhas não coincidem',
  });

// D-01 -> Recuperação de senha aceita email, não username (ver plano de recuperação
// de senha, D-01): o username é público por design, e aceitá-lo aqui permitiria
// disparar email pra caixa de qualquer pessoa só por conhecer o handle dela.
export const forgotPasswordSchema = z.object({
  email: z.email('Email inválido'),
});

// D-10 -> O token vai no corpo, nunca em parâmetro de rota — morgan loga a URL
// completa em produção, e um token na URL viraria credencial gravada em texto puro.
export const verifyResetTokenSchema = z.object({
  token: z.string().min(1, 'Token é obrigatório'),
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, 'Token é obrigatório'),
    newPassword: passwordSchema,
    confirmNewPassword: z.string().min(1, 'Confirme a nova senha'),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    path: ['confirmNewPassword'],
    message: 'As novas senhas não coincidem',
  });
