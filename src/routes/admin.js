// Admin-Oberfläche: Benutzer, Einladungen, SMTP, Sicherheit.
// Notizen anderer Benutzer sind für Admins bewusst NICHT zugänglich.

import { Router } from 'express';
import { one, all, run, tx } from '../db.js';
import { HttpError, badRequest, notFound, str, email as checkEmail } from '../http.js';
import { requireAdmin, destroyUserSessions } from '../session.js';
import {
  findUser, findUserByEmail, publicUser, checkName, checkPassword, createUser, setPassword,
} from '../users.js';
import {
  createInvite, renewInvite, pendingInvites, getInvite, deleteInvite, createReset,
  INVITE_DAYS, RESET_MINUTES,
} from '../tokens.js';
import {
  smtpConfigured, smtpTested, saveSmtp, publicSmtp, markSmtpTested, sendMail, inviteMail, resetMail, testMail,
} from '../mailer.js';
import { securityStatus, setTwoFactor } from '../security.js';

export const adminRoutes = Router();
adminRoutes.use('/admin', requireAdmin);

let cfg = null;
export function initAdminRoutes(config) { cfg = config; }

const ROLES = new Set(['user', 'admin']);

function checkRole(role) {
  if (!ROLES.has(role)) throw badRequest('Ungültige Rolle.');
  return role;
}

function idParam(req) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('Ungültige ID.');
  return id;
}

function targetUser(req) {
  const u = findUser(idParam(req));
  if (!u) throw notFound('Benutzer nicht gefunden.');
  return u;
}

function activeAdminCount() {
  return one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n;
}

/** Der letzte aktive Admin darf nicht verschwinden */
function ensureNotLastAdmin(u) {
  if (u.role === 'admin' && !u.disabled && activeAdminCount() <= 1) {
    throw badRequest('Es muss mindestens einen aktiven Admin geben.');
  }
}

function userJson(u) {
  return {
    ...publicUser(u),
    disabled: !!u.disabled,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    sessions: u.sessions ?? 0,
  };
}

function inviteJson(i) {
  return {
    id: i.id,
    email: i.email,
    name: i.name || '',
    role: i.role,
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    expired: i.expires_at <= Date.now(),
    createdBy: i.created_by_name || null,
  };
}

/** Versucht eine Mail zu senden; Fehler werden zurückgegeben statt geworfen. */
async function trySend(to, mail) {
  if (!smtpConfigured()) return { mailed: false, mailError: null };
  try {
    await sendMail({ to, ...mail });
    return { mailed: true, mailError: null };
  } catch (err) {
    console.error(`Mail an ${to} nicht versendet: ${err.message}`);
    return { mailed: false, mailError: err.message };
  }
}

// ---------- Übersicht ----------------------------------------------------------

adminRoutes.get('/admin/users', (req, res) => {
  const users = all(`
    SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
      FROM users u ORDER BY u.name COLLATE NOCASE, u.email`, Date.now());
  res.json({
    users: users.map(userJson),
    invites: pendingInvites().map(inviteJson),
    smtpConfigured: smtpConfigured(),
  });
});

// ---------- Benutzer -----------------------------------------------------------

adminRoutes.post('/admin/users', async (req, res) => {
  const email = checkEmail(req.body?.email);
  const name = checkName(req.body?.name);
  const password = checkPassword(req.body?.password);
  const role = checkRole(req.body?.role);
  const user = await createUser({ email, name, password, role });
  run("DELETE FROM tokens WHERE kind = 'invite' AND used_at IS NULL AND email = ? COLLATE NOCASE", email);
  console.log(`Admin ${req.user.email} hat ${user.email} (${role}) angelegt.`);
  res.status(201).json({ user: userJson(user) });
});

adminRoutes.patch('/admin/users/:id', (req, res) => {
  const u = targetUser(req);
  const b = req.body || {};
  const self = u.id === req.user.id;
  tx(() => {
    if (b.name !== undefined) {
      run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', checkName(b.name), Date.now(), u.id);
    }
    if (b.role !== undefined && checkRole(b.role) !== u.role) {
      if (b.role === 'user') ensureNotLastAdmin(u);
      run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', b.role, Date.now(), u.id);
    }
    if (b.disabled !== undefined && !!b.disabled !== !!u.disabled) {
      if (b.disabled) {
        if (self) throw badRequest('Du kannst dich nicht selbst deaktivieren.');
        ensureNotLastAdmin(u);
        destroyUserSessions(u.id);
      }
      run('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?', b.disabled ? 1 : 0, Date.now(), u.id);
    }
  });
  res.json({ user: userJson(findUser(u.id)) });
});

adminRoutes.delete('/admin/users/:id', (req, res) => {
  const u = targetUser(req);
  if (u.id === req.user.id) throw badRequest('Du kannst dein eigenes Konto nicht löschen.');
  ensureNotLastAdmin(u);
  // Notizen, Sitzungen und Tokens werden über Fremdschlüssel mitgelöscht
  run('DELETE FROM users WHERE id = ?', u.id);
  console.log(`Admin ${req.user.email} hat ${u.email} gelöscht.`);
  res.json({ ok: true });
});

adminRoutes.post('/admin/users/:id/password', async (req, res) => {
  const u = targetUser(req);
  const password = checkPassword(req.body?.password);
  await setPassword(u.id, password);
  // überall abmelden (die eigene aktuelle Sitzung bleibt bestehen)
  destroyUserSessions(u.id, u.id === req.user.id ? req.sessionHash : null);
  res.json({ ok: true });
});

adminRoutes.post('/admin/users/:id/reset-link', async (req, res) => {
  const u = targetUser(req);
  if (u.disabled) throw badRequest('Das Konto ist deaktiviert.');
  const token = createReset(u.id, req.user.id);
  const link = `${cfg.baseUrl}/passwort/${token}`;
  const sent = await trySend(u.email, resetMail({ link, minutes: RESET_MINUTES }));
  res.json({ link, minutes: RESET_MINUTES, ...sent });
});

adminRoutes.post('/admin/users/:id/logout', (req, res) => {
  const u = targetUser(req);
  destroyUserSessions(u.id, u.id === req.user.id ? req.sessionHash : null);
  res.json({ ok: true });
});

// ---------- Einladungen --------------------------------------------------------

adminRoutes.post('/admin/invites', async (req, res) => {
  const email = checkEmail(req.body?.email);
  const name = req.body?.name ? checkName(req.body.name) : '';
  const role = checkRole(req.body?.role);
  if (findUserByEmail(email)) throw badRequest('Für diese E-Mail-Adresse gibt es bereits ein Konto.', { field: 'email' });
  // eine offene Einladung pro Adresse
  run("DELETE FROM tokens WHERE kind = 'invite' AND used_at IS NULL AND email = ? COLLATE NOCASE", email);
  const { id, token } = createInvite({ email, name, role, createdBy: req.user.id });
  const link = `${cfg.baseUrl}/einladung/${token}`;
  const sent = await trySend(email, inviteMail({ link, inviter: req.user.name, days: INVITE_DAYS }));
  res.status(201).json({ invite: inviteJson({ ...getInvite(id), created_by_name: req.user.name }), link, days: INVITE_DAYS, ...sent });
});

adminRoutes.post('/admin/invites/:id/resend', async (req, res) => {
  const inv = getInvite(idParam(req));
  if (!inv) throw notFound('Einladung nicht gefunden.');
  const token = renewInvite(inv.id);
  if (!token) throw notFound('Einladung nicht gefunden.');
  const link = `${cfg.baseUrl}/einladung/${token}`;
  const sent = await trySend(inv.email, inviteMail({ link, inviter: req.user.name, days: INVITE_DAYS }));
  res.json({ link, days: INVITE_DAYS, ...sent });
});

adminRoutes.delete('/admin/invites/:id', (req, res) => {
  if (!deleteInvite(idParam(req))) throw notFound('Einladung nicht gefunden.');
  res.json({ ok: true });
});

// ---------- SMTP ---------------------------------------------------------------

adminRoutes.get('/admin/smtp', (req, res) => {
  res.json({ smtp: publicSmtp(), security: securityStatus() });
});

adminRoutes.put('/admin/smtp', (req, res) => {
  const b = req.body || {};
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('Ungültiger Port.', { field: 'port' });
  const security = ['starttls', 'tls', 'none'].includes(b.security) ? b.security : null;
  if (!security) throw badRequest('Ungültige Verschlüsselung.', { field: 'security' });
  const host = str(b.host, { name: 'Server', min: 1, max: 253 });
  if (!/^[a-z0-9.-]+$/i.test(host)) throw badRequest('Ungültiger Servername.', { field: 'host' });
  const from = str(b.from, { name: 'Absender', min: 3, max: 300 });
  if (!/@/.test(from) || /[\r\n]/.test(from)) throw badRequest('Bitte gib einen gültigen Absender an, z. B. Notizzettel <notes@example.com>.', { field: 'from' });
  saveSmtp({
    host,
    port,
    security,
    user: typeof b.user === 'string' ? b.user.trim().slice(0, 254) : '',
    pass: typeof b.pass === 'string' ? b.pass.slice(0, 1024) : '',
    clearPass: b.clearPass === true,
    from,
  });
  res.json({ smtp: publicSmtp(), security: securityStatus() });
});

adminRoutes.post('/admin/smtp/test', async (req, res) => {
  if (!smtpConfigured()) throw badRequest('Bitte speichere zuerst die SMTP-Einstellungen.');
  const to = req.body?.to ? checkEmail(req.body.to) : req.user.email;
  try {
    await sendMail({ to, ...testMail() });
  } catch (err) {
    throw new HttpError(502, `Die Testmail konnte nicht verschickt werden: ${err.message}`);
  }
  markSmtpTested();
  res.json({ smtp: publicSmtp(), security: securityStatus(), to });
});

// ---------- Sicherheit ---------------------------------------------------------

adminRoutes.get('/admin/security', (req, res) => {
  res.json({ security: securityStatus() });
});

adminRoutes.put('/admin/security', (req, res) => {
  const on = req.body?.twofa === true;
  if (on && !smtpTested()) {
    throw badRequest('Richte zuerst SMTP ein und sende erfolgreich eine Testmail.');
  }
  setTwoFactor(on);
  console.log(`Admin ${req.user.email} hat den Zwei-Faktor-Code ${on ? 'aktiviert' : 'deaktiviert'}.`);
  res.json({ security: securityStatus() });
});
