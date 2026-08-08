import request from 'supertest';
import app from '../../src/app.js';
import prisma from '../../src/config/prisma.js';

const TEST_EMAIL_DOMAIN = 'residences-integration-test.example.com';

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function uniqueEmail(): string {
  return `user-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`;
}

function uniqueUsername(): string {
  return `u${uniqueSuffix()}`.slice(0, 20);
}

interface RegisteredUser {
  agent: ReturnType<typeof request.agent>;
  id: number;
  name: string;
  username: string;
  email: string;
}

async function registerUser(name = 'Usuário de Teste'): Promise<RegisteredUser> {
  const agent = request.agent(app);
  const email = uniqueEmail();
  const username = uniqueUsername();

  const response = await agent
    .post('/auth/register')
    .send({ name, username, email, password: 'senhaForte1', confirmPassword: 'senhaForte1' });

  return { agent, id: response.body.user.id, name, username, email };
}

afterAll(async () => {
  // Residence.ownerId não tem onDelete: Cascade (de propósito — apagar o owner não
  // deveria apagar a residência silenciosamente em produção), então a limpeza do
  // teste precisa remover as residências primeiro.
  await prisma.residence.deleteMany({ where: { owner: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } } });
  await prisma.$disconnect();
});

describe('POST /residences', () => {
  it('rejeita requisição sem autenticação', async () => {
    const response = await request(app).post('/residences').send({ name: 'Casa Teste' });
    expect(response.status).toBe(401);
  });

  it('rejeita nome inválido (curto demais)', async () => {
    const owner = await registerUser();
    const response = await owner.agent.post('/residences').send({ name: 'Ab' });
    expect(response.status).toBe(400);
  });

  it('cria a residência com o usuário autenticado como owner', async () => {
    const owner = await registerUser();
    const response = await owner.agent.post('/residences').send({ name: 'Casa Principal' });

    expect(response.status).toBe(201);
    expect(response.body.residence).toMatchObject({ name: 'Casa Principal' });
    expect(response.body.residence.code).toMatch(/^[A-Z0-9]{6}$/);
  });
});

describe('GET /residences', () => {
  it('lista a residência recém-criada com isOwner=true', async () => {
    const owner = await registerUser();
    await owner.agent.post('/residences').send({ name: 'Casa Listada' });

    const response = await owner.agent.get('/residences');

    expect(response.status).toBe(200);
    expect(response.body.residences).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Casa Listada', isOwner: true, isArchived: false })]),
    );
  });
});

describe('fluxo de solicitação de entrada (join-request)', () => {
  let owner: RegisteredUser;
  let joiner: RegisteredUser;
  let outsider: RegisteredUser;
  let code: string;

  beforeAll(async () => {
    owner = await registerUser('Dono');
    joiner = await registerUser('Solicitante');
    outsider = await registerUser('Estranho');

    const created = await owner.agent.post('/residences').send({ name: 'Casa Join Request' });
    code = created.body.residence.code;
  });

  it('rejeita código em formato inválido', async () => {
    const response = await joiner.agent.post('/residences/join-requests').send({ code: 'abc' });
    expect(response.status).toBe(400);
  });

  it('responde 404 pra código bem formado mas inexistente (RN-050)', async () => {
    const response = await joiner.agent.post('/residences/join-requests').send({ code: 'ZZ9999' });
    expect(response.status).toBe(404);
  });

  it('cria a solicitação de entrada com código válido', async () => {
    const response = await joiner.agent.post('/residences/join-requests').send({ code });
    expect(response.status).toBe(201);
  });

  it('rejeita solicitação duplicada enquanto a anterior está pendente (CA-6)', async () => {
    const response = await joiner.agent.post('/residences/join-requests').send({ code });
    expect(response.status).toBe(409);
  });

  it('o owner vê a solicitação pendente em GET /residences/:code', async () => {
    const response = await owner.agent.get(`/residences/${code}`);
    expect(response.status).toBe(200);
    expect(response.body.pendingJoinRequests).toEqual(
      expect.arrayContaining([expect.objectContaining({ requesterUsername: joiner.username })]),
    );
  });

  it('quem não é dono da residência não pode responder a solicitação (404)', async () => {
    const list = await owner.agent.get(`/residences/${code}`);
    const requestId = list.body.pendingJoinRequests[0].id;

    const response = await outsider.agent.patch(`/residences/join-requests/${requestId}`).send({ status: 'accepted' });
    expect(response.status).toBe(404);
  });

  it('o owner aceita a solicitação e cria o vínculo de membro', async () => {
    const list = await owner.agent.get(`/residences/${code}`);
    const requestId = list.body.pendingJoinRequests[0].id;

    const response = await owner.agent.patch(`/residences/join-requests/${requestId}`).send({ status: 'accepted' });
    expect(response.status).toBe(200);

    const residencesOfJoiner = await joiner.agent.get('/residences');
    expect(residencesOfJoiner.body.residences).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, isOwner: false })]),
    );
  });

  it('responder de novo a mesma solicitação (já respondida) dá 404', async () => {
    const residence = await prisma.residence.findUniqueOrThrow({ where: { code } });
    const request_ = await prisma.joinRequest.findFirstOrThrow({
      where: { residenceId: residence.id, requesterId: joiner.id },
    });

    const response = await owner.agent.patch(`/residences/join-requests/${request_.id}`).send({ status: 'accepted' });
    expect(response.status).toBe(404);
  });

  it('quem já é membro recebe 409 ao tentar solicitar entrada de novo', async () => {
    const response = await joiner.agent.post('/residences/join-requests').send({ code });
    expect(response.status).toBe(409);
  });

  it('cancela uma solicitação pendente e ela deixa de aparecer pro owner', async () => {
    const canceller = await registerUser('Cancelador');
    await canceller.agent.post('/residences/join-requests').send({ code });

    const list = await owner.agent.get(`/residences/${code}`);
    const requestId = list.body.pendingJoinRequests.find(
      (r: { requesterUsername: string }) => r.requesterUsername === canceller.username,
    ).id;

    const cancelResponse = await canceller.agent.delete(`/residences/join-requests/${requestId}`);
    expect(cancelResponse.status).toBe(200);

    const respondResponse = await owner.agent.patch(`/residences/join-requests/${requestId}`).send({ status: 'accepted' });
    expect(respondResponse.status).toBe(404);
  });
});

describe('fluxo de convite (invite)', () => {
  let owner: RegisteredUser;
  let invitee: RegisteredUser;
  let outsider: RegisteredUser;
  let code: string;

  beforeAll(async () => {
    owner = await registerUser('Dono Convite');
    invitee = await registerUser('Convidado');
    outsider = await registerUser('Estranho Convite');

    const created = await owner.agent.post('/residences').send({ name: 'Casa Convite' });
    code = created.body.residence.code;
  });

  it('rejeita convite pra username inexistente (CA-4)', async () => {
    const response = await owner.agent.post(`/residences/${code}/invites`).send({ username: 'usuario-que-nao-existe-123' });
    expect(response.status).toBe(404);
  });

  it('quem não pertence à residência recebe 404 ao tentar convidar (RN-010; o teste de 403 pra membro comum está no describe de permissões)', async () => {
    const response = await outsider.agent.post(`/residences/${code}/invites`).send({ username: invitee.username });
    expect(response.status).toBe(404);
  });

  it('owner convida um usuário existente', async () => {
    const response = await owner.agent.post(`/residences/${code}/invites`).send({ username: invitee.username });
    expect(response.status).toBe(201);
  });

  it('o convite aparece pro convidado em GET /residences', async () => {
    const response = await invitee.agent.get('/residences');
    expect(response.body.receivedInvites).toEqual(
      expect.arrayContaining([expect.objectContaining({ residenceCode: code })]),
    );
  });

  it('quem não é o convidado não pode responder ao convite (404)', async () => {
    const list = await invitee.agent.get('/residences');
    const inviteId = list.body.receivedInvites[0].id;

    const response = await outsider.agent.patch(`/residences/invites/${inviteId}`).send({ status: 'accepted' });
    expect(response.status).toBe(404);
  });

  it('recusar o convite não cria vínculo', async () => {
    const list = await invitee.agent.get('/residences');
    const inviteId = list.body.receivedInvites[0].id;

    const response = await invitee.agent.patch(`/residences/invites/${inviteId}`).send({ status: 'declined' });
    expect(response.status).toBe(200);

    const residencesOfInvitee = await invitee.agent.get('/residences');
    expect(residencesOfInvitee.body.residences).toEqual(expect.not.arrayContaining([expect.objectContaining({ code })]));
  });

  it('owner convida de novo (o convite anterior já não está pendente) e o convidado aceita', async () => {
    const inviteResponse = await owner.agent.post(`/residences/${code}/invites`).send({ username: invitee.username });
    expect(inviteResponse.status).toBe(201);

    const list = await invitee.agent.get('/residences');
    const inviteId = list.body.receivedInvites[0].id;

    const acceptResponse = await invitee.agent.patch(`/residences/invites/${inviteId}`).send({ status: 'accepted' });
    expect(acceptResponse.status).toBe(200);

    const residencesOfInvitee = await invitee.agent.get('/residences');
    expect(residencesOfInvitee.body.residences).toEqual(
      expect.arrayContaining([expect.objectContaining({ code, isOwner: false })]),
    );
  });

  it('convidar quem já é membro dá 409', async () => {
    const response = await owner.agent.post(`/residences/${code}/invites`).send({ username: invitee.username });
    expect(response.status).toBe(409);
  });

  it('owner cancela um convite pendente e ele deixa de poder ser respondido', async () => {
    await owner.agent.post(`/residences/${code}/invites`).send({ username: outsider.username });

    const detail = await owner.agent.get(`/residences/${code}`);
    const inviteId = detail.body.sentInvites.find(
      (i: { invitedUserUsername: string }) => i.invitedUserUsername === outsider.username,
    ).id;

    const cancelResponse = await owner.agent.delete(`/residences/invites/${inviteId}`);
    expect(cancelResponse.status).toBe(200);

    const respondResponse = await outsider.agent.patch(`/residences/invites/${inviteId}`).send({ status: 'accepted' });
    expect(respondResponse.status).toBe(404);
  });
});

describe('permissões e ciclo de vida da residência (owner vs. membro)', () => {
  let owner: RegisteredUser;
  let member: RegisteredUser;
  let code: string;

  beforeAll(async () => {
    owner = await registerUser('Dono Permissões');
    member = await registerUser('Membro Permissões');

    const created = await owner.agent.post('/residences').send({ name: 'Casa Permissões' });
    code = created.body.residence.code;

    const joinResponse = await member.agent.post('/residences/join-requests').send({ code });
    expect(joinResponse.status).toBe(201);

    const detail = await owner.agent.get(`/residences/${code}`);
    const requestId = detail.body.pendingJoinRequests[0].id;
    await owner.agent.patch(`/residences/join-requests/${requestId}`).send({ status: 'accepted' });
  });

  it('quem não é membro recebe 404 em GET /residences/:code', async () => {
    const outsider = await registerUser('Fora');
    const response = await outsider.agent.get(`/residences/${code}`);
    expect(response.status).toBe(404);
  });

  it('membro comum não pode renomear a residência (403)', async () => {
    const response = await member.agent.patch(`/residences/${code}`).send({ name: 'Nome Indevido' });
    expect(response.status).toBe(403);
  });

  it('membro comum não pode regenerar o código (403)', async () => {
    const response = await member.agent.post(`/residences/${code}/code`);
    expect(response.status).toBe(403);
  });

  it('membro comum não pode remover outro membro (403)', async () => {
    const response = await member.agent.delete(`/residences/${code}/members/${owner.id}`);
    expect(response.status).toBe(403);
  });

  it('membro comum não pode transferir a propriedade (403)', async () => {
    const response = await member.agent.put(`/residences/${code}/owner`).send({ userId: member.id });
    expect(response.status).toBe(403);
  });

  it('membro comum não pode convidar usuários (403)', async () => {
    const response = await member.agent.post(`/residences/${code}/invites`).send({ username: owner.username });
    expect(response.status).toBe(403);
  });

  it('owner renomeia a residência (RN-030)', async () => {
    const response = await owner.agent.patch(`/residences/${code}`).send({ name: 'Casa Renomeada' });
    expect(response.status).toBe(200);
    expect(response.body.residence.name).toBe('Casa Renomeada');
    expect(response.body.residence.code).toBe(code);
  });

  it('owner arquiva a residência, e arquivar de novo dá 409', async () => {
    const response = await owner.agent.patch(`/residences/${code}`).send({ archived: true });
    expect(response.status).toBe(200);

    const again = await owner.agent.patch(`/residences/${code}`).send({ archived: true });
    expect(again.status).toBe(409);
  });

  it('residência arquivada é somente leitura pra renomear e regenerar código (RN-032)', async () => {
    const renameResponse = await owner.agent.patch(`/residences/${code}`).send({ name: 'Outro Nome' });
    expect(renameResponse.status).toBe(409);

    const regenerateResponse = await owner.agent.post(`/residences/${code}/code`);
    expect(regenerateResponse.status).toBe(409);
  });

  it('owner desarquiva a residência', async () => {
    const response = await owner.agent.patch(`/residences/${code}`).send({ archived: false });
    expect(response.status).toBe(200);
  });

  it('owner regenera o código, e o código antigo deixa de existir', async () => {
    const response = await owner.agent.post(`/residences/${code}/code`);
    expect(response.status).toBe(200);
    expect(response.body.code).not.toBe(code);

    const oldCodeResponse = await owner.agent.get(`/residences/${code}`);
    expect(oldCodeResponse.status).toBe(404);

    code = response.body.code;
  });

  it('owner não pode sair sem antes transferir a propriedade (RN-021)', async () => {
    const response = await owner.agent.delete(`/residences/${code}/members/me`);
    expect(response.status).toBe(409);
  });

  it('owner transfere a propriedade pro membro', async () => {
    const response = await owner.agent.put(`/residences/${code}/owner`).send({ userId: member.id });
    expect(response.status).toBe(204);

    const detail = await member.agent.get(`/residences/${code}`);
    expect(detail.body.residence.isOwner).toBe(true);
  });

  it('o antigo owner (agora membro) não pode mais renomear a residência', async () => {
    const response = await owner.agent.patch(`/residences/${code}`).send({ name: 'Não Deveria Funcionar' });
    expect(response.status).toBe(403);
  });

  it('o novo owner remove o antigo owner da residência', async () => {
    const response = await member.agent.delete(`/residences/${code}/members/${owner.id}`);
    expect(response.status).toBe(204);

    const residencesOfOldOwner = await owner.agent.get('/residences');
    expect(residencesOfOldOwner.body.residences).toEqual(expect.not.arrayContaining([expect.objectContaining({ code })]));
  });
});
