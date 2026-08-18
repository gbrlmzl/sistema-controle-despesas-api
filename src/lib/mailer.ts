// D-09 -> O envio de email é uma porta (SendEmail), não uma dependência direta
// importada pelo service — mesmo padrão de ReadinessDependencies/ShutdownDependencies.
// Ganho principal: trocar Gmail por AWS SES em produção (ver A.4 do plano) mexe só
// neste arquivo, sem tocar em regra de negócio nem em teste do service.

import nodemailer, { type Transporter } from 'nodemailer';
import { env, mailEnabled } from '../config/env.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type SendEmail = (email: OutgoingEmail) => Promise<void>;

// Criado uma única vez no escopo do módulo: o nodemailer faz pool de conexão, e um
// transport novo por envio desperdiça handshake TLS e esbarra em limite do Gmail.
function createSmtpSender(): SendEmail {
  const transporter: Transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Porta 465 é TLS implícito; qualquer outra (ex.: 587/STARTTLS) precisa de
    // secure:false — se a porta mudar, essa derivação muda junto.
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });

  return async function sendSmtpEmail(email: OutgoingEmail): Promise<void> {
    await transporter.sendMail({
      from: env.MAIL_FROM,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  };
}

// D-08 -> Sem o grupo SMTP, não envia nada. Em development ainda assim registra o
// conteúdo (link incluso) no console — é o caminho de desenvolvimento local sem
// precisar configurar SMTP nenhum.
function createDisabledSender(): SendEmail {
  return async function sendDisabledEmail(email: OutgoingEmail): Promise<void> {
    if (env.NODE_ENV === 'development') {
      console.log(`[mailer] SMTP desabilitado — email não enviado.\nPara: ${email.to}\nAssunto: ${email.subject}\n${email.text}`);
    }
  };
}

const realSender: SendEmail = mailEnabled ? createSmtpSender() : createDisabledSender();

let activeSender: SendEmail = realSender;

// `sendEmail` em si é uma referência estável (quem importou já tem a função), mas o
// que ela FAZ pode ser trocado — mesmo padrão de setRateLimitersArmedInTests em
// rateLimit.ts. Sem isto, o teste de integração da recuperação de senha (que passa
// pelo controller de verdade, não pelo service isolado) só teria dois jeitos de
// verificar o link enviado: abrir uma conexão SMTP de teste, ou tocar o Gmail de
// verdade — os dois errados para `npm test`.
export const sendEmail: SendEmail = (email) => activeSender(email);

// Gancho de teste: troca o remetente ativo por um espião. Chamar com `null` restaura
// o remetente real (SMTP ou desabilitado, conforme mailEnabled).
export function setSendEmailForTests(sender: SendEmail | null): void {
  activeSender = sender ?? realSender;
}
