import bcrypt from 'bcrypt';
import prisma from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import type { AuthUser } from '../auth/authService.js';

const SALT_ROUNDS = 10;

function toAuthUser(user: { id: number; name: string; username: string | null; email: string; profilePic: string | null }): AuthUser {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    profilePic: user.profilePic,
  };
}

// Contas de login social (Google) não têm senha local — usado pelo front pra decidir
// se mostra a tela de troca de senha.
export async function userHasPassword(userId: number): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
  return user?.password != null;
}

export async function updateProfile(
  userId: number,
  { name, avatar }: { name?: string; avatar?: string },
): Promise<AuthUser> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(name !== undefined && { name }),
      ...(avatar !== undefined && { profilePic: avatar }),
    },
  });

  return toAuthUser(user);
}

export async function changeUserPassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, 'Usuário não encontrado.');
  }

  // Contas só-Google não têm senha local — não há o que comparar/trocar.
  if (!user.password) {
    throw new AppError(400, 'Esta conta não usa senha local.');
  }

  const passwordMatches = await bcrypt.compare(currentPassword, user.password);
  if (!passwordMatches) {
    throw new AppError(401, 'Senha atual incorreta.');
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { password: passwordHash },
  });

  return toAuthUser(updated);
}
