// Status, Ersteinrichtung, Anmeldung (mit Code per Mail), Einladungen,
// Passwort vergessen, eigenes Konto

import { Router } from 'express';
import { tx, run } from '../db.js';
import { verifyPassword } from '../crypto.js';
import {
  HttpError, badRequest, unauthorized, notFound, tooMany, email as checkEmail, str,
} from '../http.js';
import { limits } from '../ratelimit.js';
import { createSession, destroySession, destroyUserSessions, requireUser } from '../session.js';
import { setupRequired, checkSetupToken, consumeSetupToken } from '../setup.js';
import {
  findUserByEmail, findUser, publicUser, checkPassword, checkName, createUser, setPassword,
} from '../users.js';
import {
  findLinkToken, markUsed, createReset, deleteInvitesFor, createLoginCode, findLoginCode,
  verifyLoginCode, resendLoginCode, CODE_MINUTES, RESET_MINUTES,
} from '../tokens.js';
import { sendMail, codeMail, resetMail, smtpTested } from '../mailer.js';
import { twoFactorActive, maskEmail } from '../security.js';

export const authRoutes = Router();

let cfg = null;
export function initAuthRoutes(config) { cfg = config; }

// ---------- Status ------------------------------------------------------------

authRoutes.get('/status', (req, res) => {
  res.json({
    setupRequired: setupRequired(),
    user: req.user,
    features: {
      passwordReset: smtpTested(),
      passkeys: true,
    },
  });
});

// ---------- Ersteinrichtung --------------------------------------------------

let setupBusy = false;

authRoutes.post('/setup', async (req, res) => {
  if (!setupRequired()) throw badRequest('Die Einrichtung ist bereits abgeschlossen.');
  const ip = req.ip;
  const lim = limits.setupIp.check(ip);
  if (!lim.ok) throw tooMany(lim.retryAfter);

  if (!checkSetupToken(req.body?.token)) {
    limits.setupIp.hit(ip);
    throw badRequest('Das Setup-Token stimmt nicht. Du findest es in der Konsole bzw. im Journal des Dienstes.', { field: 'token' });
  }
  const mail = checkEmail(req.body.email);
  const name = checkName(req.body.name);
  const password = checkPassword(req.body.password);

  // Doppelte, gleichzeitige Anfragen abfangen
  if (setupBusy) throw badRequest('Die Einrichtung läuft bereits.');
  setupBusy = true;
  try {
    if (!setupRequired()) throw badRequest('Die Einrichtung ist bereits abgeschlossen.');
    const user = await createUser({ email: mail, name, password, role: 'admin' });
    consumeSetupToken();
    limits.setupIp.reset(ip);
    createSession(req, res, user.id, true);
    console.log(`Ersteinrichtung abgeschlossen: Admin ${user.email} angelegt.`);
    res.status(201).json({ user: publicUser(user) });
  } finally {
    setupBusy = false;
  }
});

// ---------- Anmeldung --------------------------------------------------------

authRoutes.post('/login', async (req, res) => {
  const ip = req.ip;
  const ipLim = limits.loginIp.check(ip);
  if (!ipLim.ok) throw tooMany(ipLim.retryAfter);

  const mail = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const remember = req.body?.remember === true;
  if (!mail || !password) throw badRequest('Bitte gib E-Mail und Passwort ein.');

  const accLim = limits.loginAccount.check(mail);
  if (!accLim.ok) throw tooMany(accLim.retryAfter);

  const user = findUserByEmail(mail);
  const ok = await verifyPassword(password, user?.password_hash ?? null);
  if (!user || !ok || user.disabled) {
    limits.loginIp.hit(ip);
    limits.loginAccount.hit(mail);
    throw unauthorized('E-Mail oder Passwort ist falsch.');
  }
  limits.loginAccount.reset(mail);

  // Zwei-Faktor-Code per E-Mail
  if (twoFactorActive()) {
    const { challenge, code } = createLoginCode(user.id, remember);
    try {
      await sendMail({ to: user.email, ...codeMail({ code, minutes: CODE_MINUTES }) });
    } catch (err) {
      console.error(`Anmelde-Code an ${user.email} nicht versendet: ${err.message}`);
      run("DELETE FROM tokens WHERE kind = 'login_code' AND user_id = ?", user.id);
      throw new HttpError(502, 'Der Anmelde-Code konnte nicht per E-Mail verschickt werden. Bitte versuche es später erneut oder wende dich an den Admin.');
    }
    return res.json({ twoFactor: true, challenge, email: maskEmail(user.email), minutes: CODE_MINUTES });
  }

  createSession(req, res, user.id, remember);
  res.json({ user: publicUser(user) });
});

authRoutes.post('/login/code', (req, res) => {
  const ip = req.ip;
  const lim = limits.codeIp.check(ip);
  if (!lim.ok) throw tooMany(lim.retryAfter);
  const challenge = String(req.body?.challenge || '');
  const row = findLoginCode(challenge);
  if (!row) throw badRequest('Die Anmeldung ist abgelaufen. Bitte melde dich erneut an.', { expired: true });
  const result = verifyLoginCode(row, challenge, req.body?.code);
  if (result !== 'ok') {
    limits.codeIp.hit(ip);
    if (result === 'locked') {
      throw badRequest('Zu viele falsche Codes. Bitte melde dich erneut an.', { expired: true });
    }
    throw badRequest('Der Code stimmt nicht.', { field: 'code' });
  }
  const user = findUser(row.user_id);
  if (!user || user.disabled) throw unauthorized('Anmeldung nicht möglich.');
  createSession(req, res, user.id, JSON.parse(row.data).remember);
  res.json({ user: publicUser(user) });
});

authRoutes.post('/login/code/resend', async (req, res) => {
  const challenge = String(req.body?.challenge || '');
  const row = findLoginCode(challenge);
  if (!row) throw badRequest('Die Anmeldung ist abgelaufen. Bitte melde dich erneut an.', { expired: true });
  const r = resendLoginCode(row, challenge);
  if (r.error === 'limit') throw badRequest('Es wurden schon mehrere Codes verschickt. Bitte melde dich erneut an.', { expired: true });
  if (r.error === 'wait') throw badRequest(`Bitte warte noch ${r.wait} Sekunden, bevor du einen neuen Code anforderst.`);
  const user = findUser(row.user_id);
  try {
    await sendMail({ to: user.email, ...codeMail({ code: r.code, minutes: CODE_MINUTES }) });
  } catch (err) {
    console.error(`Anmelde-Code an ${user.email} nicht versendet: ${err.message}`);
    throw new HttpError(502, 'Der Code konnte nicht per E-Mail verschickt werden.');
  }
  res.json({ ok: true });
});

authRoutes.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// ---------- Einladung annehmen -----------------------------------------------

const invalidLink = () => notFound('Dieser Link ist ungültig, abgelaufen oder wurde schon verwendet.');

authRoutes.get('/invites/:token', (req, res) => {
  const inv = findLinkToken('invite', req.params.token);
  if (!inv) throw invalidLink();
  res.json({ email: inv.email, name: inv.name || '', role: inv.role, expiresAt: inv.expires_at });
});

authRoutes.post('/invites/:token', async (req, res) => {
  const inv = findLinkToken('invite', req.params.token);
  if (!inv) throw invalidLink();
  const name = checkName(req.body?.name);
  const password = checkPassword(req.body?.password);
  if (findUserByEmail(inv.email)) throw badRequest('Für diese E-Mail-Adresse gibt es bereits ein Konto. Melde dich einfach an.');
  if (!markUsed(inv.id)) throw invalidLink();
  const user = await createUser({ email: inv.email, name, password, role: inv.role === 'admin' ? 'admin' : 'user' });
  deleteInvitesFor(inv.email);
  createSession(req, res, user.id, req.body?.remember !== false);
  console.log(`Einladung angenommen: ${user.email} (${user.role}).`);
  res.status(201).json({ user: publicUser(user) });
});

// ---------- Passwort vergessen -----------------------------------------------

authRoutes.post('/password/forgot', (req, res) => {
  if (!smtpTested()) throw badRequest('Das Zurücksetzen per E-Mail ist nicht eingerichtet. Bitte wende dich an den Admin.');
  const ip = req.ip;
  const mail = checkEmail(req.body?.email);
  for (const [lim, key] of [[limits.forgotIp, ip], [limits.forgotAccount, mail]]) {
    const r = lim.check(key);
    if (!r.ok) throw tooMany(r.retryAfter);
    lim.hit(key);
  }
  const user = findUserByEmail(mail);
  if (user && !user.disabled) {
    const token = createReset(user.id);
    const link = `${cfg.baseUrl}/passwort/${token}`;
    // nicht abwarten: die Antwortzeit verrät sonst, ob es das Konto gibt
    sendMail({ to: user.email, ...resetMail({ link, minutes: RESET_MINUTES }) })
      .catch((err) => console.error(`Reset-Mail an ${user.email} nicht versendet: ${err.message}`));
  }
  res.json({ ok: true });
});

authRoutes.get('/password/reset/:token', (req, res) => {
  const t = findLinkToken('reset', req.params.token);
  const user = t && findUser(t.user_id);
  if (!user || user.disabled) throw invalidLink();
  res.json({ email: user.email });
});

authRoutes.post('/password/reset/:token', async (req, res) => {
  const t = findLinkToken('reset', req.params.token);
  const user = t && findUser(t.user_id);
  if (!user || user.disabled) throw invalidLink();
  const password = checkPassword(req.body?.password);
  if (!markUsed(t.id)) throw invalidLink();
  await setPassword(user.id, password);
  tx(() => {
    destroyUserSessions(user.id);
    run("DELETE FROM tokens WHERE kind IN ('reset', 'login_code') AND user_id = ?", user.id);
  });
  limits.loginAccount.reset(user.email);
  res.json({ ok: true });
});

// ---------- Eigenes Konto ----------------------------------------------------

authRoutes.get('/account', requireUser, (req, res) => {
  res.json({ user: req.user });
});

authRoutes.put('/account', requireUser, (req, res) => {
  const name = checkName(req.body?.name);
  run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', name, Date.now(), req.user.id);
  res.json({ user: publicUser(findUser(req.user.id)) });
});

authRoutes.put('/account/password', requireUser, async (req, res) => {
  const key = String(req.user.id);
  const lim = limits.passwordUser.check(key);
  if (!lim.ok) throw tooMany(lim.retryAfter);
  const current = str(req.body?.current, { name: 'Aktuelles Passwort', min: 1, max: 1024, trim: false });
  const next = checkPassword(req.body?.password);
  const user = findUser(req.user.id);
  if (!(await verifyPassword(current, user.password_hash))) {
    limits.passwordUser.hit(key);
    throw badRequest('Das aktuelle Passwort stimmt nicht.', { field: 'current' });
  }
  limits.passwordUser.reset(key);
  await setPassword(user.id, next);
  // andere Geräte abmelden, dieses bleibt angemeldet
  tx(() => destroyUserSessions(user.id, req.sessionHash));
  res.json({ ok: true });
});
