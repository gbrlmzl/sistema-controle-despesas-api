import { passwordResetEmail, passwordResetGoogleAccountEmail } from '../../src/lib/emailTemplates.js';

describe('passwordResetEmail', () => {
  const resetUrl = 'https://exemplo.com/change-password?token=abc123';

  it('inclui o resetUrl no text e no html', () => {
    const email = passwordResetEmail({ name: 'Ana', resetUrl, expiresInMinutes: 30 });

    expect(email.text).toContain(resetUrl);
    expect(email.html).toContain(resetUrl);
  });

  it('tem assunto sobre redefinição de senha', () => {
    const email = passwordResetEmail({ name: 'Ana', resetUrl, expiresInMinutes: 30 });

    expect(email.subject).toMatch(/redefini/i);
  });

  it('escapa o nome no html, mas não no text', () => {
    const nomeMalicioso = '<img src=x onerror=alert(1)>';
    const email = passwordResetEmail({ name: nomeMalicioso, resetUrl, expiresInMinutes: 30 });

    expect(email.html).not.toContain(nomeMalicioso);
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.text).toContain(nomeMalicioso);
  });

  it('menciona que o link expira e que ignorar é seguro', () => {
    const email = passwordResetEmail({ name: 'Ana', resetUrl, expiresInMinutes: 30 });

    expect(email.text).toContain('30');
    expect(email.text.toLowerCase()).toContain('ignore este email');
  });
});

describe('passwordResetGoogleAccountEmail (D-11)', () => {
  it('tem assunto sobre login com Google', () => {
    const email = passwordResetGoogleAccountEmail({ name: 'Ana' });

    expect(email.subject).toMatch(/google/i);
  });

  it('NÃO contém link de redefinição nenhum', () => {
    const email = passwordResetGoogleAccountEmail({ name: 'Ana' });

    expect(email.text).not.toMatch(/https?:\/\//);
    expect(email.html).not.toContain('<a href=');
  });

  it('escapa o nome no html, mas não no text', () => {
    const nomeMalicioso = '<img src=x onerror=alert(1)>';
    const email = passwordResetGoogleAccountEmail({ name: nomeMalicioso });

    expect(email.html).not.toContain(nomeMalicioso);
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.text).toContain(nomeMalicioso);
  });
});
