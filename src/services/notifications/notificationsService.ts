import prisma from '../../config/prisma.js';
import type { NotificationType } from '../../generated/client.js';

//RN-040 -> a tela dedicada de notificações pagina a partir de 20 itens.
export const NOTIFICATIONS_PER_PAGE = 20;

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

//Variante em lote, usada quando o mesmo evento notifica vários usuários de uma vez
//(ex.: fechamento de mês avisa todos os membros da residência).
export async function createNotifications(notifications: NewNotification[]) {
  if (notifications.length === 0) {
    return;
  }

  return prisma.notification.createMany({
    data: notifications.map(({ userId, type, title, message, linkTo }) => ({
      userId,
      type,
      title,
      message,
      linkTo: linkTo ?? null,
    })),
  });
}

//RN-034 -> cada usuário enxerga exclusivamente as próprias notificações.
export async function countUnread(userId: number): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export interface ListNotificationsOptions {
  page?: number;
  limit?: number;
}

export interface NotificationDTO {
  id: number;
  type: NotificationType;
  title: string;
  message: string;
  linkTo: string | null;
  isRead: boolean;
  createdAt: Date;
}

export interface NotificationsPage {
  notifications: NotificationDTO[];
  total: number;
  page: number;
  totalPages: number;
}

export async function listNotifications(
  userId: number,
  { page, limit }: ListNotificationsOptions = {},
): Promise<NotificationsPage> {
  const pageSize = limit ?? NOTIFICATIONS_PER_PAGE;
  const currentPage = page ?? 1;

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        linkTo: true,
        readAt: true,
        createdAt: true,
      },
    }),
    prisma.notification.count({ where: { userId } }),
  ]);

  return {
    notifications: notifications.map(({ readAt, ...notification }) => ({
      ...notification,
      isRead: readAt !== null,
    })),
    total,
    page: currentPage,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

//RN-036 -> ao abrir o painel do sino, as notificações exibidas passam a contar como lidas.
export async function markAsRead(userId: number, ids: number[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  //O filtro por userId impede marcar como lida uma notificação de outro usuário.
  await prisma.notification.updateMany({
    where: { userId, id: { in: ids }, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function markAllAsRead(userId: number): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}
