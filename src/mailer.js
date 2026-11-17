// E-Mail-Versand über SMTP (vorgesehen: Brevo). Zugangsdaten liegen nur in
// der Datenbank in data/ – nie im Repository.

import nodemailer from 'nodemailer';
import { getSetting, setSetting } from './db.js';

const KEY = 'smtp';

/**
 * @typedef {{ host: string, port: number, security: 'starttls'|'tls'|'none',
 *             user: string, pass: string, from: string, testedAt: number|null }} SmtpSettings
 */

/** @returns {SmtpSettings|null} */
export function getSmtp() {
  return getSetting(KEY, null);
}

export function smtpConfigured() {
  const s = getSmtp();
  return !!(s && s.host && s.port && s.from);
}

/** SMTP eingerichtet und mit erfolgreicher Testmail bestätigt */
export function smtpTested() {
  return smtpConfigured() && !!getSmtp().testedAt;
}

/** Speichert Einstellungen. Jede Änderung verlangt eine neue Testmail. */
export function saveSmtp(input) {
  const old = getSmtp() || {};
  const next = {
    host: input.host,
    port: input.port,
    security: input.security,
    user: input.user,
    // leeres Passwort = bisheriges behalten
    pass: input.pass ? input.pass : (input.clearPass ? '' : old.pass || ''),
    from: input.from,
    testedAt: null,
  };
  const same = ['host', 'port', 'security', 'user', 'pass', 'from'].every((k) => old[k] === next[k]);
  if (same) next.testedAt = old.testedAt ?? null;
  setSetting(KEY, next);
  return next;
}

export function markSmtpTested() {
  const s = getSmtp();
  if (s) setSetting(KEY, { ...s, testedAt: Date.now() });
}

/** Für die Admin-Oberfläche – ohne Passwort */
export function publicSmtp() {
  const s = getSmtp();
  if (!s) return { host: '', port: 587, security: 'starttls', user: '', from: '', hasPassword: false, testedAt: null };
  return { host: s.host, port: s.port, security: s.security, user: s.user, from: s.from, hasPassword: !!s.pass, testedAt: s.testedAt };
}

function transport(s) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

export async function sendMail({ to, subject, text, html }) {
  const s = getSmtp();
  if (!smtpConfigured()) throw new Error('SMTP ist nicht eingerichtet.');
  await transport(s).sendMail({ from: s.from, to, subject, text, html });
}

// ---------- Vorlagen ----------------------------------------------------------

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(title, bodyHtml) {
  return `<!doctype html><html lang="de"><body style="margin:0;padding:24px;background:#ebe6dc;font-family:Consolas,Menlo,Monaco,'Courier New',monospace;color:#2b2924">
<div style="max-width:520px;margin:0 auto;background:#fffdf7;border:1px solid #ddd5c4;border-radius:4px;overflow:hidden">
<div style="height:10px;background:#8e3c2f"></div>
<div style="padding:28px 28px 24px">
<h1 style="margin:0 0 16px;font-size:20px">${esc(title)}</h1>
${bodyHtml}
<p style="margin:28px 0 0;font-size:12px;color:#8b877c">Notizzettel</p>
</div></div></body></html>`;
}

const button = (href, label) => `<p style="margin:24px 0"><a href="${esc(href)}" style="display:inline-block;padding:12px 22px;border-radius:22px;background:#34679f;color:#fff;text-decoration:none;font-weight:bold">${esc(label)}</a></p>
<p style="font-size:12px;color:#77726a;word-break:break-all">Falls der Knopf nicht funktioniert, kopiere diesen Link in deinen Browser:<br>${esc(href)}</p>`;

export function inviteMail({ link, inviter, days }) {
  const text = `Hallo,

${inviter} lädt dich zu Notizzettel ein. Über diesen Link legst du dein Konto an:

${link}

Der Link ist ${days} Tage gültig und kann nur einmal verwendet werden.`;
  const html = layout('Du bist eingeladen', `<p style="line-height:1.6">${esc(inviter)} lädt dich zu Notizzettel ein. Über den Knopf legst du dein Konto an.</p>
${button(link, 'Konto anlegen')}
<p style="font-size:13px;color:#77726a">Der Link ist ${days} Tage gültig und kann nur einmal verwendet werden.</p>`);
  return { subject: 'Einladung zu Notizzettel', text, html };
}

export function resetMail({ link, minutes }) {
  const text = `Hallo,

für dein Notizzettel-Konto wurde ein neues Passwort angefordert. Über diesen Link vergibst du es:

${link}

Der Link ist ${minutes} Minuten gültig. Falls du das nicht warst, kannst du diese Mail ignorieren.`;
  const html = layout('Neues Passwort', `<p style="line-height:1.6">Für dein Notizzettel-Konto wurde ein neues Passwort angefordert.</p>
${button(link, 'Neues Passwort vergeben')}
<p style="font-size:13px;color:#77726a">Der Link ist ${minutes} Minuten gültig. Falls du das nicht warst, kannst du diese Mail ignorieren.</p>`);
  return { subject: 'Neues Passwort für Notizzettel', text, html };
}

export function codeMail({ code, minutes }) {
  const text = `Dein Anmelde-Code für Notizzettel: ${code}

Der Code ist ${minutes} Minuten gültig. Falls du dich nicht gerade anmeldest, ändere bitte dein Passwort.`;
  const html = layout('Dein Anmelde-Code', `<p style="line-height:1.6">Gib diesen Code ein, um die Anmeldung abzuschließen:</p>
<p style="margin:20px 0;font-size:32px;letter-spacing:.3em;font-weight:bold">${esc(code)}</p>
<p style="font-size:13px;color:#77726a">Der Code ist ${minutes} Minuten gültig. Falls du dich nicht gerade anmeldest, ändere bitte dein Passwort.</p>`);
  return { subject: `${code} ist dein Anmelde-Code`, text, html };
}

export function testMail() {
  const text = 'Diese Testmail bestätigt, dass Notizzettel E-Mails verschicken kann.';
  return { subject: 'Testmail von Notizzettel', text, html: layout('Testmail', `<p style="line-height:1.6">${esc(text)}</p>`) };
}
