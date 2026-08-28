import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import ms from 'ms';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import prisma from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { normalizeUsername, usernameEmUso, gerarUsernameDisponivel } from '../../lib/username.js';
import { logSecurityEvent, type SecurityContext } from '../../utils/logger.js';
import type { User } from '../../generated/client.js';

const SALT_ROUNDS = 10;

export interface AuthUser {
  id: number;
  name: string;
  username: string | null;
  email: string;
  profilePic: string | null;
}

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    profilePic: user.profilePic,
  };
}

export interface RegisterInput {
  name: string;
  username: string;
  email: string;
  password: string;
}

export async function registerUser(input: RegisterInput): Promise<AuthUser> {
  const username = normalizeUsername(input.username);

  const existingByEmail = await prisma.user.findUnique({ where: { email: input.email } });
  if (existingByEmail) {
    throw new AppError(409, 'Este usuário já existe!');
  }

  if (await usernameEmUso(username)) {
    throw new AppError(409, 'Este nome de usuário já está em uso!');
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      name: input.name,
      username,
      email: input.email,
      password: passwordHash,
      profilePic: null,
      authProviders: {
        create: { provider: 'local', providerId: input.email },
      },
    },
  });

  return toAuthUser(user);
}

export async function getUserById(id: number): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({ where: { id } });
  return user ? toAuthUser(user) : null;
}

// SEC-10 -> O log da falha mora aqui, e não no controller, porque só aqui se sabe
// QUAL dos dois ramos falhou. A resposta ao cliente continua indistinguível (é o que
// impede enumeração), mas o log registra a diferença — "500 user_not_found do mesmo IP"
// é varredura de usernames, "500 invalid_password no mesmo username" é força bruta de
// senha. São ataques diferentes e a distinção só existe neste ponto do código.
export async function loginWithCredentials(
  username: string,
  password: string,
  context: SecurityContext = {},
): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { username: normalizeUsername(username) } });

  // Mesma mensagem tanto pra "não existe" quanto pra "senha errada" — não dar
  // pista de qual delas falhou, pra não facilitar enumeração de usernames cadastrados.
  if (!user || !user.password) {
    logSecurityEvent('login_failed', { ip: context.ip, username, reason: 'user_not_found' });
    throw new AppError(401, 'Credenciais inválidas.');
  }

  const passwordMatches = await bcrypt.compare(password, user.password);
  if (!passwordMatches) {
    // Nunca a senha tentada — só o identificador de quem foi alvo.
    logSecurityEvent('login_failed', { ip: context.ip, username, userId: user.id, reason: 'invalid_password' });
    throw new AppError(401, 'Credenciais inválidas.');
  }

  return toAuthUser(user);
}

export interface GoogleProfile {
  id: string;
  displayName?: string;
  email: string;
  photo?: string;
}

export async function findOrCreateGoogleUser(profile: GoogleProfile): Promise<AuthUser> {
  const usuarioComProviders = await prisma.user.findUnique({
    where: { email: profile.email },
    include: { authProviders: true },
  });

  let usuario: User;

  if (!usuarioComProviders) {
    // No login social o usuário não escolhe um nome de usuário, então o sistema
    // gera um a partir do email pra não deixar a conta sem identificador público.
    usuario = await prisma.user.create({
      data: {
        name: profile.displayName ?? profile.email,
        username: await gerarUsernameDisponivel(profile.email.split('@')[0]),
        email: profile.email,
        password: null,
        profilePic: profile.photo ?? null,
        authProviders: {
          create: { provider: 'google', providerId: profile.id },
        },
      },
    });
  } else {
    usuario = usuarioComProviders;

    const hasGoogleProvider = usuarioComProviders.authProviders.some(
      (p) => p.provider === 'google' && p.providerId === profile.id,
    );

    if (!hasGoogleProvider) {
      await prisma.userAuthProvider.create({
        data: { userId: usuario.id, provider: 'google', providerId: profile.id },
      });
    }

    if (profile.photo && usuario.profilePic === null) {
      usuario = await prisma.user.update({
        where: { id: usuario.id },
        data: { profilePic: profile.photo },
      });
    }

    // Contas criadas antes da adoção do nome de usuário ficam sem identificador
    // público. Gera um na primeira vez que o usuário voltar a entrar.
    if (usuario.username === null) {
      usuario = await prisma.user.update({
        where: { id: usuario.id },
        data: { username: await gerarUsernameDisponivel(profile.email.split('@')[0]) },
      });
    }
  }

  return toAuthUser(usuario);
}

interface TokenPayload {
  sub: number;
  email: string;
}

// SEC-12 -> Quem emitiu e pra quem o token serve. Hoje só esta aplicação usa o
// JWT_SECRET, então o ganho é pequeno; a hora de colocar é agora, antes de existir um
// segundo serviço compartilhando o segredo, quando um token emitido pra outro público
// passaria a ser aceito aqui sem nenhum aviso.
//
// Exigir na verificação é o que dá sentido ao par: assinar sem exigir não protege nada.
const JWT_ISSUER = 'sistema-controle-despesas-api';
const JWT_AUDIENCE = 'sistema-controle-despesas-web';

export function signToken(user: AuthUser): string {
  const payload: TokenPayload = { sub: user.id, email: user.email };

  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as unknown as TokenPayload;
  } catch {
    throw new AppError(401, 'Token inválido ou expirado.');
  }
}

// --- Refresh token: opaco, rotativo, com detecção de reuso ---
//
// Ao contrário do access token (JWT stateless), o refresh token é só um valor
// aleatório de alta entropia — não carrega claim nenhuma, então não precisa (e não
// deve) ser um JWT. O banco é a única fonte de verdade sobre validade/revogação.
// Só o hash (SHA-256) é guardado, nunca o valor em texto puro — igual senha, mas
// sem custo de bcrypt, porque já é aleatório de alta entropia, não uma senha
// escolhida por humano sujeita a força bruta com dicionário.

const REFRESH_TOKEN_BYTES = 40;

interface IssuedRefreshToken {
  raw: string;
  expiresAt: Date;
}

function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

async function createRefreshTokenRecord(userId: number, familyId: string): Promise<IssuedRefreshToken> {
  const raw = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + ms(env.REFRESH_TOKEN_EXPIRES_IN as ms.StringValue));

  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashRefreshToken(raw), familyId, expiresAt },
  });

  return { raw, expiresAt };
}

// Chamado no login/registro/callback do Google — início de uma "família" nova de
// rotação.
export async function issueRefreshToken(userId: number): Promise<IssuedRefreshToken> {
  return createRefreshTokenRecord(userId, randomUUID());
}

async function revokeTokenFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// SEC-06 -> Derruba TODAS as sessões do usuário, de todos os dispositivos e de todas as
// famílias de rotação. Diferente de revokeTokenFamily, que só alcança a linhagem de um
// token específico: aqui o alvo é o usuário inteiro, porque o gatilho (troca de senha)
// significa "não confio em nenhuma sessão que exista agora".
export async function revokeAllUserTokens(userId: number): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// SEC-09 -> Cada /auth/refresh insere uma linha e revoga a anterior; nada some sozinho.
// Um usuário ativo gera ~96 linhas por dia com access token de 15 minutos.
//
// A janela de retenção não é arbitrária: uma linha revogada ainda serve pra detectar
// reuso (é ela que faz rotateRefreshToken reconhecer um token roubado em vez de
// devolver "não existe"). Passados 30 dias, o refresh token já expirou de qualquer
// forma — o registro vira peso morto.
export const REFRESH_TOKEN_RETENTION_DAYS = 30;

export async function purgeExpiredRefreshTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - REFRESH_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const { count } = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });

  return count;
}

export interface RotatedSession {
  user: AuthUser;
  refreshToken: IssuedRefreshToken;
}

// Janela de graça da rotação: por quanto tempo, depois de rotacionado, um token ainda é
// aceito de novo em vez de ser tratado como roubo.
//
// Sem ela, "reuso" e "concorrência" viram a mesma coisa. Um cliente normal dispara
// requisições em paralelo o tempo todo (várias abas, prefetch do Next, um fetch que toma
// 401 no mesmo instante de uma navegação), e todas carregam o MESMO refresh token porque
// nenhuma viu ainda o Set-Cookie das outras. A primeira rotaciona; a segunda chega
// milissegundos depois com um token que acabou de ser revogado e derrubava a família
// inteira — deslogando o usuário de todos os dispositivos e emitindo um alerta de roubo
// falso. Nenhum controle no cliente resolve isso sozinho: o front é stateless e pode
// rodar em mais de uma instância.
//
// O preço é explícito e limitado: quem roubar um token tem estes 10 segundos, contados a
// partir da rotação legítima, pra usá-lo. Passada a janela, a detecção continua exatamente
// como era. É o mesmo compromisso que o OAuth 2.0 Security BCP descreve pra rotação com
// clientes concorrentes.
const ROTATION_GRACE_MS = 10_000;

// A graça vale só pra quem foi revogado POR ROTAÇÃO. Tempo sozinho não basta como
// critério: logout, troca de senha (revokeAllUserTokens) e a própria detecção de reuso
// também gravam revokedAt = agora, e uma janela puramente temporal ressuscitaria por 10s
// exatamente as sessões que esses três fluxos existem pra matar.
//
// O que distingue os casos, sem coluna nova no banco: rotação legítima deixa um sucessor
// VIVO na mesma família — é o token que o cliente acabou de receber. Revogação em massa
// não deixa nenhum. Logo, "existe irmão vivo nesta família" é o mesmo que "este token foi
// aposentado por uma rotação normal, e quem o reapresenta é um cliente atrasado".
async function temSucessorVivo(familyId: string): Promise<boolean> {
  const sucessor = await prisma.refreshToken.findFirst({
    where: { familyId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });

  return sucessor !== null;
}

// Troca um refresh token válido por um novo (mesma família) + devolve o usuário,
// pra emitir um access token novo. Detecta reuso: um token revogado há mais tempo que a
// janela de graça sendo apresentado de novo é sinal de token roubado — revoga a família
// inteira, forçando login de novo em todos os dispositivos daquela sessão.
export async function rotateRefreshToken(rawToken: string, context: SecurityContext = {}): Promise<RotatedSession> {
  const tokenHash = hashRefreshToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    throw new AppError(401, 'Sessão inválida. Faça login novamente.');
  }

  const dentroDaJanelaDeGraca =
    existing.revokedAt !== null &&
    Date.now() - existing.revokedAt.getTime() <= ROTATION_GRACE_MS &&
    (await temSucessorVivo(existing.familyId));

  if (existing.revokedAt && !dentroDaJanelaDeGraca) {
    // SEC-10 -> Este é o evento mais importante da aplicação inteira: um token já
    // rotacionado sendo reapresentado fora da janela de graça só acontece se alguém ficou
    // com uma cópia. Não é suspeita, é roubo confirmado.
    //
    // O identificador logado é o prefixo do hash, nunca o token: quem lê o log precisa
    // conseguir correlacionar a linha do banco, não reusar a credencial.
    logSecurityEvent('refresh_token_reuse', {
      ip: context.ip,
      userId: existing.userId,
      familyId: existing.familyId,
      tokenHashPrefix: tokenHash.slice(0, 12),
    });

    await revokeTokenFamily(existing.familyId);
    throw new AppError(401, 'Sessão inválida. Faça login novamente.');
  }

  if (dentroDaJanelaDeGraca) {
    // Evento próprio, e não refresh_token_reuse: isto é esperado e não deve acionar quem
    // responde a alerta de segurança. Mas continua valendo a pena medir — um volume que
    // suba muito significa que o front voltou a multiplicar chamadas de renovação (foi o
    // que aconteceu quando o apiClient.ts do Next renovava durante o render, sem
    // conseguir persistir o cookie).
    logSecurityEvent('refresh_token_grace_reuse', {
      ip: context.ip,
      userId: existing.userId,
      familyId: existing.familyId,
      tokenHashPrefix: tokenHash.slice(0, 12),
    });
  }

  if (existing.expiresAt < new Date()) {
    throw new AppError(401, 'Sessão expirada. Faça login novamente.');
  }

  // Só revoga o que ainda não estava revogado. Reescrever revokedAt num token já
  // rotacionado empurraria o fim da janela de graça pra frente a cada reapresentação —
  // um token roubado ficaria válido indefinidamente enquanto fosse usado a cada 10s.
  if (!existing.revokedAt) {
    await prisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
  }

  const user = await getUserById(existing.userId);
  if (!user) {
    throw new AppError(401, 'Sessão inválida. Faça login novamente.');
  }

  const refreshToken = await createRefreshTokenRecord(existing.userId, existing.familyId);

  return { user, refreshToken };
}
