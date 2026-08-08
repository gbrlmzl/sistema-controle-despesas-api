import { randomInt } from 'node:crypto';
import prisma from '../../config/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { createNotification } from '../notifications/notifications.service.js';
import { getOpenCompetency } from '../expenses/expenses.service.js';
import { normalizeUsername } from '../../lib/username.js';

// --- Código público da residência ---

//RN-004 -> Alfabeto do código sem caracteres ambíguos (O/0 e I/1), porque o código
//é lido e digitado manualmente por outro usuário.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_CODE_ATTEMPTS = 10;

//RN-012 -> O código é comparado sem diferenciar maiúsculas de minúsculas e
//ignorando espaços nas pontas, para tolerar erro de digitação e colagem.
export function normalizeResidenceCode(code: unknown): string {
  if (typeof code !== 'string') {
    return '';
  }
  return code.trim().toUpperCase();
}

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

//Gera um código ainda não usado por nenhuma residência.
//Retorna null se não encontrar um código livre dentro do limite de tentativas.
export async function generateAvailableCode(): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateCode();

    const existing = await prisma.residence.findUnique({ select: { id: true }, where: { code } });
    if (!existing) {
      return code;
    }
  }

  return null;
}

// --- Consulta de residências e vínculo do usuário ---

//RN-007 -> Lista apenas as residências das quais o usuário é membro.
//Q-7 -> A flag isArchived permite separar as arquivadas em uma seção própria,
//em vez de escondê-las (o que passaria a impressão de que os dados sumiram).
export async function listResidencesForUser(userId: number) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    orderBy: { joinedAt: 'asc' },
    select: {
      role: true,
      residence: {
        select: { name: true, code: true, archivedAt: true, owner: { select: { name: true } } },
      },
    },
  });

  return memberships.map((membership) => ({
    name: membership.residence.name,
    code: membership.residence.code,
    ownerName: membership.residence.owner.name,
    isOwner: membership.role === 'OWNER',
    isArchived: membership.residence.archivedAt !== null,
  }));
}

//RN-009 / RN-010 -> Busca a residência pelo código, mas só a devolve se o usuário for
//membro. Um não-membro recebe null, o mesmo resultado de um código inexistente, para
//que não seja possível descobrir códigos válidos testando URLs.
export async function findResidenceForMember(code: string, userId: number) {
  const normalizedCode = normalizeResidenceCode(code);
  if (!normalizedCode) {
    return null;
  }

  const residence = await prisma.residence.findUnique({
    where: { code: normalizedCode },
    select: {
      id: true,
      name: true,
      code: true,
      ownerId: true,
      archivedAt: true,
      owner: { select: { name: true } },
      members: {
        orderBy: { joinedAt: 'asc' },
        select: { role: true, user: { select: { id: true, name: true, username: true } } },
      },
    },
  });

  if (!residence) {
    return null;
  }

  const userMembership = residence.members.find((member) => member.user.id === userId);
  if (!userMembership) {
    return null;
  }

  return {
    id: residence.id,
    name: residence.name,
    code: residence.code,
    ownerName: residence.owner.name,
    isOwner: userMembership.role === 'OWNER',
    isArchived: residence.archivedAt !== null,
    //O owner aparece primeiro na lista de membros, por ser quem administra a residência
    members: residence.members
      .map((member) => ({
        userId: member.user.id,
        name: member.user.name,
        username: member.user.username,
        isOwner: member.role === 'OWNER',
        isCurrentUser: member.user.id === userId,
      }))
      .sort((a, b) => Number(b.isOwner) - Number(a.isOwner)),
  };
}

//Carrega o vínculo do usuário autenticado com a residência informada e lança
//AppError(404) nos dois casos em que qualquer ação deve ser negada: residência
//inexistente ou usuário que não é membro dela.
export async function loadUserResidenceContext(code: string, userId: number) {
  const normalizedCode = normalizeResidenceCode(code);
  if (!normalizedCode) {
    throw new AppError(404, 'Residência não encontrada');
  }

  const residence = await prisma.residence.findUnique({
    where: { code: normalizedCode },
    select: { id: true, name: true, code: true, ownerId: true, archivedAt: true },
  });

  if (!residence) {
    throw new AppError(404, 'Residência não encontrada');
  }

  const membership = await prisma.membership.findUnique({
    select: { id: true, role: true },
    where: { userId_residenceId: { userId, residenceId: residence.id } },
  });

  if (!membership) {
    throw new AppError(404, 'Residência não encontrada');
  }

  return {
    residence,
    membership,
    isOwner: membership.role === 'OWNER',
    isArchived: residence.archivedAt !== null,
  };
}

// --- Convites e solicitações de entrada ---

//RN-015 -> convite expira em 7 dias
export const INVITE_EXPIRATION_DAYS = 7;
//RN-013 -> uma solicitação recusada só pode ser refeita depois de uma hora
export const DECLINE_COOLDOWN_HOURS = 1;

export function calculateInviteExpiration(): Date {
  const expiration = new Date();
  expiration.setDate(expiration.getDate() + INVITE_EXPIRATION_DAYS);
  return expiration;
}

//A expiração é aplicada na leitura, e não por rotina agendada: o sistema não tem
//agendador, e um convite vencido só precisa parar de valer quando alguém for olhá-lo.
export async function expireOverdueInvites(): Promise<void> {
  await prisma.invite.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });
}

//Convites pendentes recebidos pelo usuário (US-008)
export async function listReceivedInvites(userId: number) {
  await expireOverdueInvites();

  const invites = await prisma.invite.findMany({
    where: { invitedUserId: userId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      residence: { select: { name: true, code: true } },
      invitedBy: { select: { name: true } },
    },
  });

  return invites.map((invite) => ({
    id: invite.id,
    residenceName: invite.residence.name,
    residenceCode: invite.residence.code,
    invitedByName: invite.invitedBy.name,
    createdAt: invite.createdAt,
  }));
}

//Convites pendentes enviados por uma residência (US-022, CA-1)
export async function listSentInvites(residenceId: number) {
  await expireOverdueInvites();

  const invites = await prisma.invite.findMany({
    where: { residenceId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, invitedUser: { select: { name: true, username: true } } },
  });

  return invites.map((invite) => ({
    id: invite.id,
    invitedUserName: invite.invitedUser.name,
    invitedUserUsername: invite.invitedUser.username,
    createdAt: invite.createdAt,
  }));
}

//Solicitações pendentes recebidas por uma residência (US-009, CA-1)
export async function listPendingJoinRequests(residenceId: number) {
  const requests = await prisma.joinRequest.findMany({
    where: { residenceId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, requester: { select: { name: true, username: true } } },
  });

  return requests.map((request) => ({
    id: request.id,
    requesterName: request.requester.name,
    requesterUsername: request.requester.username,
    createdAt: request.createdAt,
  }));
}

//Solicitações pendentes enviadas pelo usuário (US-022, CA-3)
export async function listSentJoinRequests(userId: number) {
  const requests = await prisma.joinRequest.findMany({
    where: { requesterId: userId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, residence: { select: { name: true, code: true } } },
  });

  return requests.map((request) => ({
    id: request.id,
    residenceName: request.residence.name,
    residenceCode: request.residence.code,
    createdAt: request.createdAt,
  }));
}

//RN-013 -> devolve a data em que o usuário poderá solicitar entrada novamente, ou
//null quando não há recusa recente bloqueando uma nova tentativa.
export async function recentDeclineBlockedUntil(residenceId: number, userId: number): Promise<Date | null> {
  const cutoff = new Date(Date.now() - DECLINE_COOLDOWN_HOURS * 60 * 60 * 1000);

  const recentDecline = await prisma.joinRequest.findFirst({
    where: { residenceId, requesterId: userId, status: 'DECLINED', respondedAt: { gte: cutoff } },
    orderBy: { respondedAt: 'desc' },
    select: { respondedAt: true },
  });

  if (!recentDecline?.respondedAt) {
    return null;
  }

  return new Date(recentDecline.respondedAt.getTime() + DECLINE_COOLDOWN_HOURS * 60 * 60 * 1000);
}

// --- Bloqueio de força bruta contra o código da residência ---

//RN-049 -> 10 tentativas malsucedidas em 15 minutos bloqueiam por 15 minutos. O
//limite é generoso de propósito: com 6 caracteres em um alfabeto de 32 existem cerca
//de 1,07 bilhão de códigos possíveis, então isto é defesa em profundidade e não pode
//atrapalhar quem apenas errou a digitação.
const JOIN_ATTEMPT_LIMIT = 10;
const JOIN_ATTEMPT_WINDOW_MINUTES = 15;

function windowStart(): Date {
  return new Date(Date.now() - JOIN_ATTEMPT_WINDOW_MINUTES * 60 * 1000);
}

//RN-051 -> a contagem é por usuário autenticado, nunca pela residência alvo (CA-5),
//senão bastaria errar códigos para bloquear a entrada na casa de outra pessoa.
//CA-3 -> o bloqueio expira sozinho: as tentativas antigas simplesmente saem da janela.
export async function userIsBlockedFromJoining(userId: number): Promise<boolean> {
  const attempts = await prisma.joinAttempt.count({
    where: { userId, createdAt: { gte: windowStart() } },
  });

  return attempts >= JOIN_ATTEMPT_LIMIT;
}

export async function recordFailedJoinAttempt(userId: number): Promise<void> {
  await prisma.joinAttempt.create({ data: { userId } });
}

//CA-4 -> uma tentativa bem-sucedida zera o contador do usuário. Apagar as linhas
//também evita que a tabela cresça indefinidamente.
export async function clearJoinAttempts(userId: number): Promise<void> {
  await prisma.joinAttempt.deleteMany({ where: { userId } });
}

// --- Ações (usadas pelos controllers) ---

export interface CreateResidenceInput {
  name: string;
}

//Cria a residência junto do vínculo do criador como OWNER. Os dois registros nascem
//na mesma operação para que nunca exista residência sem dono.
export async function createResidence(userId: number, input: CreateResidenceInput) {
  const code = await generateAvailableCode();
  if (!code) {
    throw new AppError(500, 'Não foi possível gerar um código para a residência. Tente novamente.');
  }

  return prisma.residence.create({
    data: {
      name: input.name,
      code,
      ownerId: userId,
      members: { create: { userId, role: 'OWNER' } },
    },
    select: { name: true, code: true },
  });
}

//RN-050 -> a resposta a um código que não leva a lugar nenhum é sempre a mesma,
//exista a residência ou não. É o que impede descobrir residências testando códigos.
const NOT_FOUND_MESSAGE = 'Nenhuma residência foi encontrada com esse código';

export async function requestToJoinResidence(userId: number, requesterName: string, code: string) {
  //FEAT-020: bloqueia antes de consultar, para que o bloqueio não dependa do
  //resultado da busca e não vire um canal de informação sobre códigos válidos.
  if (await userIsBlockedFromJoining(userId)) {
    throw new AppError(429, 'Muitas tentativas seguidas. Aguarde alguns minutos antes de tentar de novo.');
  }

  const residence = await prisma.residence.findUnique({
    where: { code },
    select: {
      id: true,
      name: true,
      code: true,
      ownerId: true,
      archivedAt: true,
      members: { where: { userId }, select: { id: true } },
    },
  });

  //Q-11 -> residência arquivada congela a entrada de novos membros. A resposta é a
  //mesma de código inexistente, e a tentativa também é contabilizada, para que os
  //dois casos sejam indistinguíveis de fora (RN-050).
  if (!residence || residence.archivedAt !== null) {
    await recordFailedJoinAttempt(userId);
    throw new AppError(404, NOT_FOUND_MESSAGE);
  }

  //CA-5: já é membro. Não conta como tentativa malsucedida, já que o usuário conhece
  //a residência de qualquer forma e não há nada a revelar.
  if (residence.members.length > 0) {
    throw new AppError(409, 'Você já participa desta residência');
  }

  //CA-6: não cria solicitação duplicada
  const pendingRequest = await prisma.joinRequest.findFirst({
    select: { id: true },
    where: { residenceId: residence.id, requesterId: userId, status: 'PENDING' },
  });

  if (pendingRequest) {
    throw new AppError(409, 'Sua solicitação já foi enviada e está aguardando resposta');
  }

  //RN-013: uma recusa recente impede nova tentativa por uma hora
  const blockedUntil = await recentDeclineBlockedUntil(residence.id, userId);
  if (blockedUntil) {
    throw new AppError(
      429,
      `Sua solicitação foi recusada recentemente. Você poderá tentar novamente em até ${DECLINE_COOLDOWN_HOURS} hora.`,
    );
  }

  await prisma.joinRequest.create({ data: { residenceId: residence.id, requesterId: userId } });

  await createNotification({
    userId: residence.ownerId,
    type: 'JOIN_REQUEST_RECEIVED',
    title: 'Nova solicitação de entrada',
    message: `${requesterName} pediu para entrar na residência "${residence.name}".`,
    linkTo: `/app/residences/${residence.code}`,
  });

  //CA-4 da US-023 -> uma tentativa bem-sucedida zera o contador
  await clearJoinAttempts(userId);

  return { residenceName: residence.name };
}

//RN-042: o filtro por requesterId garante que ninguém cancela solicitação alheia.
//RN-043: só enquanto estiver pendente.
export async function cancelJoinRequest(userId: number, requestId: number) {
  const request = await prisma.joinRequest.findFirst({
    where: { id: requestId, requesterId: userId, status: 'PENDING' },
    select: { id: true, residence: { select: { name: true } } },
  });

  if (!request) {
    throw new AppError(404, 'Esta solicitação não está mais pendente');
  }

  await prisma.joinRequest.update({
    where: { id: request.id },
    data: { status: 'CANCELLED', respondedAt: new Date() },
  });

  return { residenceName: request.residence.name };
}

export async function respondToInvite(userId: number, inviteId: number, accept: boolean) {
  //RN-015: convites vencidos deixam de valer antes de qualquer resposta
  await expireOverdueInvites();

  //CA-4: só um convite pendente e endereçado a este usuário pode ser respondido. O
  //filtro por invitedUserId também impede responder convite de outra pessoa.
  const invite = await prisma.invite.findFirst({
    where: { id: inviteId, invitedUserId: userId, status: 'PENDING' },
    select: {
      id: true,
      residenceId: true,
      residence: { select: { name: true, code: true, archivedAt: true } },
    },
  });

  if (!invite) {
    throw new AppError(404, 'Este convite não está mais disponível');
  }

  //Q-11: residência arquivada não aceita novos membros
  if (accept && invite.residence.archivedAt !== null) {
    throw new AppError(409, 'Esta residência foi arquivada e não está aceitando novos membros.');
  }

  if (!accept) {
    //CA-3: recusar não cria vínculo nenhum
    await prisma.invite.update({ where: { id: invite.id }, data: { status: 'DECLINED', respondedAt: new Date() } });
    return { residenceName: invite.residence.name, joined: false };
  }

  //RN-016: aceitar dispensa aprovação do owner, que já manifestou a intenção ao
  //convidar. O vínculo e a baixa do convite acontecem na mesma transação.
  await prisma.$transaction([
    prisma.membership.create({ data: { userId, residenceId: invite.residenceId, role: 'MEMBER' } }),
    prisma.invite.update({ where: { id: invite.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } }),
  ]);

  return { residenceName: invite.residence.name, joined: true };
}

export interface ResidenceUpdateInput {
  name?: string;
  archived?: boolean;
}

//RN-030: o code permanece o mesmo para não invalidar os códigos já compartilhados —
//só name e archivedAt mudam aqui.
export async function updateResidence(code: string, userId: number, input: ResidenceUpdateInput) {
  const context = await loadUserResidenceContext(code, userId);

  //RN-031 / Q-12 / RN-033: apenas o owner renomeia e arquiva/desarquiva
  if (!context.isOwner) {
    throw new AppError(403, 'Apenas o criador da residência pode alterar esta residência.');
  }

  if (input.name !== undefined && context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada. Desarquive-a para renomeá-la.');
  }

  if (input.archived !== undefined && input.archived === context.isArchived) {
    throw new AppError(409, input.archived ? 'Esta residência já está arquivada.' : 'Esta residência não está arquivada.');
  }

  const data: { name?: string; archivedAt?: Date | null } = {};
  if (input.name !== undefined) {
    data.name = input.name;
  }
  if (input.archived !== undefined) {
    data.archivedAt = input.archived ? new Date() : null;
  }

  return prisma.residence.update({
    where: { id: context.residence.id },
    data,
    select: { name: true, code: true, archivedAt: true },
  });
}

//RN-045 / CA-8: apenas o owner regenera o código. RN-046: gerado pelo sistema, com
//tratamento de colisão. RN-048: solicitações pendentes nasceram do código antigo —
//se o motivo de regenerar é um vazamento, mantê-las contradiz a intenção da ação,
//então caem junto. RN-047: os membros atuais não são tocados.
export async function regenerateResidenceCode(code: string, userId: number) {
  const context = await loadUserResidenceContext(code, userId);

  if (!context.isOwner) {
    throw new AppError(403, 'Apenas o criador da residência pode gerar um novo código.');
  }

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada. Desarquive-a para gerar um novo código.');
  }

  const newCode = await generateAvailableCode();
  if (!newCode) {
    throw new AppError(500, 'Não foi possível gerar um novo código. Tente novamente.');
  }

  await prisma.$transaction([
    prisma.residence.update({ where: { id: context.residence.id }, data: { code: newCode } }),
    prisma.joinRequest.updateMany({
      where: { residenceId: context.residence.id, status: 'PENDING' },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    }),
  ]);

  return { code: newCode };
}

//RN-021: o owner não pode sair sem antes transferir a propriedade, senão a
//residência ficaria sem dono (RN-017). RN-022: quem sai leva junto os lançamentos da
//competência ainda aberta — ao sair, está abrindo mão de receber por eles. Os meses
//já fechados permanecem intactos, porque aquelas contas já foram acertadas.
export async function leaveResidence(code: string, userId: number) {
  const context = await loadUserResidenceContext(code, userId);

  if (context.isOwner) {
    throw new AppError(409, 'Transfira a propriedade da residência antes de sair dela.');
  }

  const competency = await getOpenCompetency(context.residence.id);

  await prisma.$transaction([
    prisma.expense.updateMany({
      where: {
        residenceId: context.residence.id,
        createdById: userId,
        month: competency.month,
        year: competency.year,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    }),
    prisma.membership.delete({ where: { id: context.membership.id } }),
  ]);
}

//RN-024: apenas o owner remove membros. CA-5: o owner não pode remover a si mesmo
//(para sair, precisa transferir a propriedade). RN-026: o membro removido segue a
//mesma regra da RN-022 sobre a competência aberta.
export async function removeMember(code: string, requesterId: number, targetUserId: number) {
  const context = await loadUserResidenceContext(code, requesterId);

  if (!context.isOwner) {
    throw new AppError(403, 'Apenas o criador da residência pode remover membros.');
  }

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada. Desarquive-a para gerenciar os membros.');
  }

  if (targetUserId === requesterId) {
    throw new AppError(409, 'Você não pode remover a si mesmo da residência.');
  }

  const targetMembership = await prisma.membership.findUnique({
    select: { id: true },
    where: { userId_residenceId: { userId: targetUserId, residenceId: context.residence.id } },
  });

  if (!targetMembership) {
    throw new AppError(404, 'Este usuário não é membro da residência.');
  }

  const competency = await getOpenCompetency(context.residence.id);

  await prisma.$transaction([
    prisma.expense.updateMany({
      where: {
        residenceId: context.residence.id,
        createdById: targetUserId,
        month: competency.month,
        year: competency.year,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    }),
    prisma.membership.delete({ where: { id: targetMembership.id } }),
  ]);

  //CA-7 -> o membro removido é notificado
  await createNotification({
    userId: targetUserId,
    type: 'MEMBER_REMOVED',
    title: 'Você saiu de uma residência',
    message: `Você foi removido da residência "${context.residence.name}".`,
    linkTo: '/app/residences',
  });
}

//As três alterações (dono da residência + papel dos dois membros) acontecem na
//mesma transação para que a residência nunca fique com zero ou dois owners (RN-017
//e CA-5).
export async function transferOwnership(code: string, currentOwnerId: number, newOwnerUserId: number) {
  const context = await loadUserResidenceContext(code, currentOwnerId);

  if (!context.isOwner) {
    throw new AppError(403, 'Apenas o administrador da residência pode transferir a propriedade.');
  }

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada. Desarquive-a para transferir a propriedade.');
  }

  if (newOwnerUserId === currentOwnerId) {
    throw new AppError(409, 'Você já é o administrador desta residência.');
  }

  //RN-027: o destino precisa ser um membro ativo da residência
  const newOwnerMembership = await prisma.membership.findUnique({
    select: { id: true },
    where: { userId_residenceId: { userId: newOwnerUserId, residenceId: context.residence.id } },
  });

  if (!newOwnerMembership) {
    throw new AppError(404, 'Só é possível transferir a propriedade para um membro da residência.');
  }

  await prisma.$transaction([
    prisma.residence.update({ where: { id: context.residence.id }, data: { ownerId: newOwnerUserId } }),
    prisma.membership.update({ where: { id: newOwnerMembership.id }, data: { role: 'OWNER' } }),
    prisma.membership.update({ where: { id: context.membership.id }, data: { role: 'MEMBER' } }),
  ]);

  //CA-7 -> o novo owner é notificado
  await createNotification({
    userId: newOwnerUserId,
    type: 'OWNERSHIP_TRANSFERRED',
    title: 'Você agora administra uma residência',
    message: `Você passou a ser o administrador da residência "${context.residence.name}".`,
    linkTo: `/app/residences/${context.residence.code}`,
  });
}

//RN-017 / CA-5: apenas o owner decide sobre entradas. Q-11: residência arquivada
//congela a entrada de novos membros.
//Rota achatada pra raiz (sem :code, ver seção 2.2 do plano) — o :id da solicitação
//já é único, então a residência e a checagem de dono vêm do próprio registro.
export async function respondToJoinRequest(ownerId: number, requestId: number, accept: boolean) {
  const request = await prisma.joinRequest.findFirst({
    where: { id: requestId, status: 'PENDING' },
    select: {
      id: true,
      requesterId: true,
      requester: { select: { name: true } },
      residence: { select: { id: true, name: true, code: true, ownerId: true, archivedAt: true } },
    },
  });

  //Mesma resposta pra "não existe" e "não é sua residência" — não dar pista de que
  //a solicitação existe pra quem não tem nada a ver com ela.
  if (!request || request.residence.ownerId !== ownerId) {
    throw new AppError(404, 'Esta solicitação não está mais disponível');
  }

  if (request.residence.archivedAt !== null) {
    throw new AppError(409, 'Esta residência está arquivada. Desarquive-a para responder solicitações.');
  }

  if (!accept) {
    //CA-3: recusar não cria vínculo. O respondedAt registrado aqui é o que alimenta
    //a espera de uma hora antes de uma nova tentativa (RN-013).
    await prisma.joinRequest.update({
      where: { id: request.id },
      data: { status: 'DECLINED', respondedAt: new Date() },
    });

    //CA-4 -> o solicitante é notificado da decisão
    await createNotification({
      userId: request.requesterId,
      type: 'JOIN_REQUEST_DECLINED',
      title: 'Solicitação recusada',
      message: `Sua solicitação para entrar na residência "${request.residence.name}" foi recusada.`,
      linkTo: '/app/residences',
    });

    return { requesterName: request.requester.name, accepted: false };
  }

  //CA-2: aceitar cria o vínculo e dá baixa na solicitação, na mesma transação
  await prisma.$transaction([
    prisma.membership.create({ data: { userId: request.requesterId, residenceId: request.residence.id, role: 'MEMBER' } }),
    prisma.joinRequest.update({ where: { id: request.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } }),
  ]);

  await createNotification({
    userId: request.requesterId,
    type: 'JOIN_REQUEST_ACCEPTED',
    title: 'Solicitação aceita',
    message: `Você agora faz parte da residência "${request.residence.name}".`,
    linkTo: `/app/residences/${request.residence.code}`,
  });

  return { requesterName: request.requester.name, accepted: true };
}

//RN-042 / CA-7: apenas o owner cancela os convites que a residência enviou. RN-043:
//só é possível cancelar enquanto o convite estiver pendente — aceito ou recusado é
//desfecho final e não volta atrás. RN-044: o destinatário não é notificado.
//Rota achatada pra raiz (sem :code) pelo mesmo motivo da respondToJoinRequest acima.
export async function cancelInvite(ownerId: number, inviteId: number) {
  const invite = await prisma.invite.findFirst({
    where: { id: inviteId, status: 'PENDING' },
    select: {
      id: true,
      invitedUser: { select: { name: true } },
      residence: { select: { ownerId: true } },
    },
  });

  if (!invite || invite.residence.ownerId !== ownerId) {
    throw new AppError(404, 'Este convite não está mais pendente');
  }

  await prisma.invite.update({ where: { id: invite.id }, data: { status: 'CANCELLED', respondedAt: new Date() } });

  return { invitedUserName: invite.invitedUser.name };
}

export interface InviteUserInput {
  username: string;
}

//RN-014: apenas o owner convida. Q-11: residência arquivada congela a entrada de
//novos membros. CA-6: não cria convite duplicado.
export async function inviteUser(code: string, ownerId: number, input: InviteUserInput) {
  const context = await loadUserResidenceContext(code, ownerId);

  if (!context.isOwner) {
    throw new AppError(403, 'Apenas o criador da residência pode convidar usuários.');
  }

  if (context.isArchived) {
    throw new AppError(409, 'Esta residência está arquivada. Desarquive-a para convidar usuários.');
  }

  const username = normalizeUsername(input.username);

  //CA-4: nome de usuário precisa existir
  const invitedUser = await prisma.user.findUnique({ select: { id: true, name: true }, where: { username } });
  if (!invitedUser) {
    throw new AppError(404, 'Nenhum usuário encontrado com esse nome de usuário');
  }

  //CA-5: quem já é membro não é convidado de novo
  const alreadyMember = await prisma.membership.findUnique({
    select: { id: true },
    where: { userId_residenceId: { userId: invitedUser.id, residenceId: context.residence.id } },
  });

  if (alreadyMember) {
    throw new AppError(409, `${invitedUser.name} já participa desta residência`);
  }

  //Vencidos são expirados antes da checagem, senão um convite antigo impediria o
  //envio de um novo (RN-015).
  await expireOverdueInvites();

  const pendingInvite = await prisma.invite.findFirst({
    select: { id: true },
    where: { residenceId: context.residence.id, invitedUserId: invitedUser.id, status: 'PENDING' },
  });

  if (pendingInvite) {
    throw new AppError(409, `${invitedUser.name} já tem um convite pendente para esta residência`);
  }

  await prisma.invite.create({
    data: {
      residenceId: context.residence.id,
      invitedUserId: invitedUser.id,
      invitedById: ownerId,
      expiresAt: calculateInviteExpiration(),
    },
  });

  await createNotification({
    userId: invitedUser.id,
    type: 'INVITE_RECEIVED',
    title: 'Convite para uma residência',
    message: `Você foi convidado para a residência "${context.residence.name}".`,
    linkTo: '/app/residences',
  });

  return { invitedUserName: invitedUser.name };
}
