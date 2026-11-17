// Status, Ersteinrichtung, Anmeldung, Abmeldung, eigenes Konto

import { Router } from 'express';
import { tx, run } from '../db.js';
import { verifyPassword } from '../crypto.js';
import { badRequest, unauthorized, tooMany, email as checkEmail, str } from '../http.js';
import { limits } from '../ratelimit.js';
import { createSession, destroySession, destroyUserSessions, requireUser } from '../session.js';
import { setupRequired, checkSetupToken, consumeSetupToken } from '../setup.js';
import {
  findUserByEmail, findUser, publicUser, checkPassword, checkName, createUser, setPassword,
} from '../users.js';

export const authRoutes = Router();

// ---------- Status ------------------------------------------------------------

authRoutes.get('/status', (req, res) => {
  res.json({
    setupRequired: setupRequired(),
    user: req.user,
    features: {
      passwordReset: false, // folgt mit SMTP
      passkeys: false,      // folgt in Schritt 4
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
  createSession(req, res, user.id, remember);
  res.json({ user: publicUser(user) });
});

authRoutes.post('/logout', (req, res) => {
  destroySession(req, res);
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
