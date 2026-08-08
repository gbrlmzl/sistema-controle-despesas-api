import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../../src/config/env.js';
import { signToken, verifyToken } from '../../src/services/auth/authService.js';
import { AppError } from '../../src/utils/AppError.js';

describe('bcrypt (hash de senha)', () => {
  it('gera um hash diferente da senha em texto puro e confere de volta', async () => {
    const hash = await bcrypt.hash('minhaSenha123', 10);

    expect(hash).not.toBe('minhaSenha123');
    await expect(bcrypt.compare('minhaSenha123', hash)).resolves.toBe(true);
    await expect(bcrypt.compare('senhaErrada', hash)).resolves.toBe(false);
  });
});

describe('signToken / verifyToken (geração e validação de JWT)', () => {
  const user = { id: 1, name: 'Teste', username: 'teste', email: 'teste@example.com', profilePic: null };

  it('gera um token que verifyToken consegue validar de volta', () => {
    const token = signToken(user);
    const payload = verifyToken(token);

    expect(payload.sub).toBe(user.id);
    expect(payload.email).toBe(user.email);
  });

  it('rejeita um token malformado', () => {
    expect(() => verifyToken('token-invalido')).toThrow(AppError);
  });

  it('rejeita um token expirado', () => {
    const expiredToken = jwt.sign({ sub: user.id, email: user.email }, env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: -1, // já expirado no momento da emissão
    });

    expect(() => verifyToken(expiredToken)).toThrow(AppError);
  });

  it('rejeita um token assinado com outro segredo', () => {
    const forgedToken = jwt.sign({ sub: user.id, email: user.email }, 'segredo-errado-1234567890123456789', {
      algorithm: 'HS256',
    });

    expect(() => verifyToken(forgedToken)).toThrow(AppError);
  });
});
