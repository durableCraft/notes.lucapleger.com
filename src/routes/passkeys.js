// Passkeys (WebAuthn): jeder Benutzer verwaltet seine Passkeys selbst.
// Anmeldung per Passkey braucht keinen Mail-Code – der Passkey ist bereits
// zweistufig (Gerät + Entsperren per Biometrie/PIN, "User Verification").

import crypto from 'node:crypto';
import { Router } from 'express';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { one, all, run } from '../db.js';
import { badRequest, notFound, unauthorized, tooMany, str } from '../http.js';
import { limits } from '../ratelimit.js';
import { createSession, requireUser } from '../session.js';
import { findUser, publicUser } from '../users.js';

export const passkeyRoutes = Router();

let rpID = 'localhost';
let origin = 'http://localhost:3100';
export function initPasskeyRoutes(cfg) {
  const u = new URL(cfg.baseUrl);
  rpID = u.hostname;
  origin = u.origin;
}

// Challenges leben nur kurz im Arbeitsspeicher
const CHALLENGE_MS = 5 * 60_000;
const challenges = new Map();

function putChallenge(key, value) {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  challenges.set(key, { ...value, expires: now + CHALLENGE_MS });
}

function takeChallenge(key) {
  const c = challenges.get(key);
  challenges.delete(key);
  if (!c || c.expires < Date.now()) return null;
  return c;
}

/** Stabile, zufällige WebAuthn-Benutzerkennung (verrät weder ID noch E-Mail) */
function webauthnUserId(user) {
  if (user.webauthn_id) return user.webauthn_id;
  const id = crypto.randomBytes(32).toString('base64url');
  run('UPDATE users SET webauthn_id = ? WHERE id = ?', id, user.id);
  return id;
}

function passkeyJson(p) {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.created_at,
    lastUsedAt: p.last_used_at,
    synced: p.device_type === 'multiDevice',
    backedUp: !!p.backed_up,
  };
}

const userPasskeys = (userId) => all('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at', userId);

function checkName(name) {
  return str(name, { name: 'Name', min: 1, max: 60 });
}

// ---------- Verwalten (Mein Konto) ---------------------------------------------

passkeyRoutes.get('/passkeys', requireUser, (req, res) => {
  res.json({ passkeys: userPasskeys(req.user.id).map(passkeyJson) });
});

passkeyRoutes.post('/passkeys/register/options', requireUser, async (req, res) => {
  const user = findUser(req.user.id);
  const options = await generateRegistrationOptions({
    rpName: 'Notizzettel',
    rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: Buffer.from(webauthnUserId(user), 'base64url'),
    attestationType: 'none',
    excludeCredentials: userPasskeys(user.id).map((p) => ({
      id: p.id,
      transports: p.transports ? JSON.parse(p.transports) : undefined,
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  putChallenge(`reg:${user.id}`, { challenge: options.challenge });
  res.json({ options });
});

passkeyRoutes.post('/passkeys/register/verify', requireUser, async (req, res) => {
  const c = takeChallenge(`reg:${req.user.id}`);
  if (!c) throw badRequest('Die Anfrage ist abgelaufen. Bitte versuche es erneut.');
  const name = checkName(req.body?.name || 'Passkey');
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body?.response,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    throw badRequest(`Der Passkey konnte nicht bestätigt werden: ${err.message}`);
  }
  if (!verification.verified) throw badRequest('Der Passkey konnte nicht bestätigt werden.');
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  if (one('SELECT 1 FROM passkeys WHERE id = ?', credential.id)) {
    throw badRequest('Dieser Passkey ist bereits gespeichert.');
  }
  run(`INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  credential.id, req.user.id, Buffer.from(credential.publicKey), credential.counter,
  credential.transports ? JSON.stringify(credential.transports) : null,
  credentialDeviceType, credentialBackedUp ? 1 : 0, name, Date.now());
  res.status(201).json({ passkey: passkeyJson(one('SELECT * FROM passkeys WHERE id = ?', credential.id)) });
});

passkeyRoutes.patch('/passkeys/:id', requireUser, (req, res) => {
  const name = checkName(req.body?.name);
  const r = run('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?', name, req.params.id, req.user.id);
  if (!r.changes) throw notFound('Passkey nicht gefunden.');
  res.json({ ok: true });
});

passkeyRoutes.delete('/passkeys/:id', requireUser, (req, res) => {
  const r = run('DELETE FROM passkeys WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  if (!r.changes) throw notFound('Passkey nicht gefunden.');
  res.json({ ok: true });
});

// ---------- Anmelden ---------------------------------------------------------------

passkeyRoutes.post('/passkeys/login/options', async (req, res) => {
  const lim = limits.loginIp.check(req.ip);
  if (!lim.ok) throw tooMany(lim.retryAfter);
  // Ohne allowCredentials: der Browser bietet alle Passkeys für diese Seite an
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  const flow = crypto.randomBytes(18).toString('base64url');
  putChallenge(`login:${flow}`, { challenge: options.challenge });
  res.json({ options, flow });
});

passkeyRoutes.post('/passkeys/login/verify', async (req, res) => {
  const ip = req.ip;
  const lim = limits.loginIp.check(ip);
  if (!lim.ok) throw tooMany(lim.retryAfter);
  const c = takeChallenge(`login:${String(req.body?.flow || '')}`);
  if (!c) throw badRequest('Die Anfrage ist abgelaufen. Bitte versuche es erneut.');
  const response = req.body?.response;
  const fail = () => {
    limits.loginIp.hit(ip);
    return unauthorized('Dieser Passkey ist hier nicht (mehr) bekannt. Melde dich mit E-Mail und Passwort an.');
  };
  const pk = typeof response?.id === 'string' ? one('SELECT * FROM passkeys WHERE id = ?', response.id) : null;
  if (!pk) throw fail();
  const user = findUser(pk.user_id);
  if (!user || user.disabled) throw fail();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(pk.public_key),
        counter: pk.counter,
        transports: pk.transports ? JSON.parse(pk.transports) : undefined,
      },
      requireUserVerification: true,
    });
  } catch (err) {
    console.warn(`Passkey-Anmeldung fehlgeschlagen (${user.email}): ${err.message}`);
    throw fail();
  }
  if (!verification.verified) throw fail();
  const info = verification.authenticationInfo;
  run('UPDATE passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?',
    info.newCounter, info.credentialBackedUp ? 1 : 0, Date.now(), pk.id);
  createSession(req, res, user.id, req.body?.remember !== false);
  res.json({ user: publicUser(user) });
});
