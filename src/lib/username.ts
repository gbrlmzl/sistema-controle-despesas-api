import prisma from '../config/prisma.js';

//Normaliza o que o usuário digitou para o formato aceito pelo usernameSchema.
export function normalizeUsername(username: unknown): string {
  if (typeof username !== 'string') {
    return '';
  }
  return username.trim().toLowerCase();
}

//Verifica se o nome de usuário já está em uso por outra conta.
export async function usernameEmUso(username: string): Promise<boolean> {
  const usuario = await prisma.user.findUnique({
    select: { id: true },
    where: { username },
  });

  return Boolean(usuario);
}

//Gera um nome de usuário disponível a partir de um texto base (nome ou email).
//Usado no login com Google, onde o usuário não escolhe um nome de usuário.
export async function gerarUsernameDisponivel(textoBase: string): Promise<string> {
  const raiz = normalizeUsername(textoBase)
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 15);
  const candidatoBase = raiz.length >= 3 ? raiz : `usuario${raiz}`;

  let candidato = candidatoBase;
  let sufixo = 0;

  //Tenta o candidato limpo primeiro e, havendo colisão, acrescenta um sufixo numérico.
  while (await usernameEmUso(candidato)) {
    sufixo += 1;
    candidato = `${candidatoBase}${sufixo}`;
  }

  return candidato;
}
