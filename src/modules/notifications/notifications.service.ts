import prisma from '../../config/prisma.js';
import type { NotificationType } from '../../generated/client.js';

interface NewNotification {
  userId: number;
  type: NotificationType;
  title: string;
  message: string;
  linkTo?: string | null;
}

//RN-037 -> Ponto único de publicação. Qualquer área do sistema cria notificação por
//aqui, já resolvendo o texto e o destino, para que a leitura não precise conhecer as
//regras de cada tipo.
export async function createNotification({ userId, type, title, message, linkTo }: NewNotification) {
  return prisma.notification.create({
    data: { userId, type, title, message, linkTo: linkTo ?? null },
  });
}
