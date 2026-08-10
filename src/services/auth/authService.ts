import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import ms from 'ms';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import prisma from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { normalizeUsername, usernameEmUso, gerarUsernameDisponivel } from '../../lib/username.js';
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

export async function loginWithCredentials(username: string, password: string): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { username: normalizeUsername(username) } });

  // Mesma mensagem tanto pra "não existe" quanto pra "senha errada" — não dar
  // pista de qual delas falhou, pra não facilitar enumeração de usernames cadastrados.
  if (!user || !user.password) {
    throw new AppError(401, 'Credenciais inválidas.');
  }

  const passwordMatches = await bcrypt.compare(password, user.password);
  if (!passwordMatches) {
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

export function signToken(user: AuthUser): string {
  const payload: TokenPayload = { sub: user.id, email: user.email };

  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as unknown as TokenPayload;
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

export interface RotatedSession {
  user: AuthUser;
  refreshToken: IssuedRefreshToken;
}

// Troca um refresh token válido por um novo (mesma família) + devolve o usuário,
// pra emitir um access token novo. Detecta reuso: um token já revogado sendo
// apresentado de novo é sinal de token roubado — revoga a família inteira, forçando
// login de novo em todos os dispositivos daquela sessão.
export async function rotateRefreshToken(rawToken: string): Promise<RotatedSession> {
  const tokenHash = hashRefreshToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    throw new AppError(401, 'Sessão inválida. Faça login novamente.');
  }

  if (existing.revokedAt) {
    await revokeTokenFamily(existing.familyId);
    throw new AppError(401, 'Sessão inválida. Faça login novamente.');
  }

  if (existing.expiresAt < new Date()) {
    throw new AppError(401, 'Sessão expirada. Faça login novamente.');
  }

  await prisma.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });

  const user = await getUserById(existing.userId);
  if (!user) {
    throw new AppError(401, 'Sessão inválida. Faça login novamente.');
  }

  const refreshToken = await createRefreshTokenRecord(existing.userId, existing.familyId);

  return { user, refreshToken };
}
