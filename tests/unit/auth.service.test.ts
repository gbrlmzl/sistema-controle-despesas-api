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

// SEC-12 -> issuer e audience. O ganho não é grande hoje (só esta aplicação usa o
// segredo), mas os testes abaixo travam as duas metades: assinar COM os claims e
// EXIGI-LOS na verificação. Assinar sem exigir não protege de nada, e é justamente a
// metade que passa despercebida num refactor.
describe('issuer e audience do JWT (SEC-12)', () => {
  const user = { id: 7, name: 'Teste', username: 'teste', email: 'teste@example.com', profilePic: null };

  it('assina o token com issuer e audience desta aplicação', () => {
    const decoded = jwt.decode(signToken(user)) as jwt.JwtPayload;

    expect(decoded.iss).toBe('sistema-controle-despesas-api');
    expect(decoded.aud).toBe('sistema-controle-despesas-web');
  });

  it('rejeita token válido e bem assinado, mas sem issuer/audience nenhum', () => {
    // Este é o caso que importa: mesmo segredo, mesmo algoritmo, assinatura perfeita —
    // só não foi emitido por esta aplicação. Antes do SEC-12 seria aceito.
    const semClaims = jwt.sign({ sub: user.id, email: user.email }, env.JWT_SECRET, { algorithm: 'HS256' });

    expect(() => verifyToken(semClaims)).toThrow(AppError);
  });

  it('rejeita token emitido por outro issuer', () => {
    const outroEmissor = jwt.sign({ sub: user.id, email: user.email }, env.JWT_SECRET, {
      algorithm: 'HS256',
      issuer: 'outro-servico',
      audience: 'sistema-controle-despesas-web',
    });

    expect(() => verifyToken(outroEmissor)).toThrow(AppError);
  });

  it('rejeita token destinado a outra audience', () => {
    // O cenário do futuro: um segundo serviço compartilhando o JWT_SECRET emite um
    // token pro público dele. Sem `audience` na verificação, esta API o aceitaria.
    const outroPublico = jwt.sign({ sub: user.id, email: user.email }, env.JWT_SECRET, {
      algorithm: 'HS256',
      issuer: 'sistema-controle-despesas-api',
      audience: 'outro-front',
    });

    expect(() => verifyToken(outroPublico)).toThrow(AppError);
  });
});
