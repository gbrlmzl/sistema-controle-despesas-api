// Funções puras, sem I/O: só montam o `OutgoingEmail` que src/lib/mailer.ts envia.
// Ficarem puras é o que permite testar assunto/corpo sem SMTP nem rede (ver
// tests/unit/emailTemplates.test.ts).

import type { OutgoingEmail } from './mailer.js';

// O nome vem do cadastro do usuário — interpolar direto no HTML abriria injeção de
// HTML no corpo do email (alguém registrado como `<img src=x onerror=...>`).
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// HTML deliberadamente simples: só div/estilo inline. Sem CSS externo, sem <style>
// no head, sem imagem remota — que seria, além de desnecessário, um pixel de
// rastreio.
function wrapHtml(bodyHtml: string): string {
  return `<div style="font-family: sans-serif; font-size: 16px; color: #1a1a1a; line-height: 1.5; max-width: 480px;">${bodyHtml}</div>`;
}

export interface PasswordResetEmailInput {
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export function passwordResetEmail({ name, resetUrl, expiresInMinutes }: PasswordResetEmailInput): OutgoingEmail {
  const safeName = escapeHtml(name);

  const text = [
    `Olá, ${name}.`,
    '',
    'Recebemos um pedido para redefinir a senha da sua conta no Cronos.',
    `Para criar uma nova senha, acesse o link abaixo (válido por ${expiresInMinutes} minutos):`,
    resetUrl,
    '',
    'Se você não pediu isso, ignore este email',
  ].join('\n');

  const html = wrapHtml(
    `<p>Olá, ${safeName}.</p>` +
      '<p>Recebemos um pedido para redefinir a senha da sua conta no Cronos.</p>' +
      `<p>Para criar uma nova senha, acesse o link abaixo (válido por ${expiresInMinutes} minutos):</p>` +
      `<p><a href="${resetUrl}">${resetUrl}</a></p>` +
      '<p>Se você não pediu isso, ignore este email.</p>',
  );

  return {
    to: '',
    subject: 'Redefinição de senha — Cronos',
    text,
    html,
  };
}

export interface PasswordResetGoogleAccountEmailInput {
  name: string;
}

// D-11 -> Conta que só entra com Google não tem senha local pra redefinir. Este
// template NÃO contém link de redefinição nenhum — é o que o teste unitário verifica.
export function passwordResetGoogleAccountEmail({ name }: PasswordResetGoogleAccountEmailInput): OutgoingEmail {
  const safeName = escapeHtml(name);

  const text = [
    `Olá, ${name}.`,
    '',
    'Recebemos um pedido de redefinição de senha para o email desta conta, mas ela usa login com o Google — não existe senha local para redefinir.',
    'Para entrar, use o botão "Entrar com Google" na tela de login.',
    '',
    'Se você não pediu isso, ignore este email — nenhuma alteração foi feita.',
  ].join('\n');

  const html = wrapHtml(
    `<p>Olá, ${safeName}.</p>` +
      '<p>Recebemos um pedido de redefinição de senha para o email desta conta, mas ela usa login com o Google — não existe senha local para redefinir.</p>' +
      '<p>Para entrar, use o botão "Entrar com Google" na tela de login.</p>' +
      '<p>Se você não pediu isso, ignore este email — nenhuma alteração foi feita.</p>',
  );

  return {
    to: '',
    subject: 'Sua conta usa login com o Google — Cronos',
    text,
    html,
  };
}
