// Einmal-Tokens: Einladungen, Passwort-Reset, Anmelde-Codes.
// In der Datenbank liegt nur der SHA-256-Hash des Tokens bzw. Codes.

import crypto from 'node:crypto';
import { one, all, run } from './db.js';
import { randomToken, sha256, safeEqual } from './crypto.js';

const MIN = 60_000;
export const INVITE_DAYS = 7;
export const RESET_MINUTES = 60;
export const CODE_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_MAX_SENDS = 4;
export const CODE_RESEND_GAP_MS = 30_000;

// ---------- Einladungen ------------------------------------------------------

/** @returns {{ id: number, token: string }} */
export function createInvite({ email, name, role, createdBy }) {
  const token = randomToken(24);
  const now = Date.now();
  const res = run(`INSERT INTO tokens (token_hash, kind, email, name, role, created_by, created_at, expires_at, last_sent_at)
                   VALUES (?, 'invite', ?, ?, ?, ?, ?, ?, ?)`,
  sha256(token), email, name || null, role, createdBy, now, now + INVITE_DAYS * 24 * 60 * MIN, now);
  return { id: Number(res.lastInsertRowid), token };
}

/** Neuer Link für eine bestehende Einladung (alter Link wird ungültig, Frist beginnt neu) */
export function renewInvite(id) {
  const token = randomToken(24);
  const now = Date.now();
  const r = run(`UPDATE tokens SET token_hash = ?, expires_at = ?, sends = sends + 1, last_sent_at = ?
                  WHERE id = ? AND kind = 'invite' AND used_at IS NULL`,
  sha256(token), now + INVITE_DAYS * 24 * 60 * MIN, now, id);
  return r.changes ? token : null;
}

export function pendingInvites() {
  return all(`SELECT t.id, t.email, t.name, t.role, t.created_at, t.expires_at, u.name AS created_by_name
                FROM tokens t LEFT JOIN users u ON u.id = t.created_by
               WHERE t.kind = 'invite' AND t.used_at IS NULL
               ORDER BY t.created_at DESC`);
}

export function getInvite(id) {
  return one("SELECT * FROM tokens WHERE id = ? AND kind = 'invite' AND used_at IS NULL", id);
}

export function deleteInvite(id) {
  return run("DELETE FROM tokens WHERE id = ? AND kind = 'invite' AND used_at IS NULL", id).changes > 0;
}

export function deleteInvitesFor(email) {
  run("DELETE FROM tokens WHERE kind = 'invite' AND used_at IS NULL AND email = ? COLLATE NOCASE", email);
}

// ---------- Token per Link (Einladung, Reset) --------------------------------

/** Gültiges, unbenutztes Token einer Art finden */
export function findLinkToken(kind, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = one('SELECT * FROM tokens WHERE token_hash = ? AND kind = ?', sha256(token), kind);
  if (!row || row.used_at || row.expires_at <= Date.now()) return null;
  return row;
}

export function markUsed(id) {
  return run('UPDATE tokens SET used_at = ? WHERE id = ? AND used_at IS NULL', Date.now(), id).changes > 0;
}

export function createReset(userId, createdBy = null) {
  // ältere, noch offene Reset-Links dieses Benutzers verfallen
  run("DELETE FROM tokens WHERE kind = 'reset' AND user_id = ? AND used_at IS NULL", userId);
  const token = randomToken(24);
  const now = Date.now();
  run(`INSERT INTO tokens (token_hash, kind, user_id, created_by, created_at, expires_at, last_sent_at)
       VALUES (?, 'reset', ?, ?, ?, ?, ?)`, sha256(token), userId, createdBy, now, now + RESET_MINUTES * MIN, now);
  return token;
}

// ---------- Anmelde-Codes (2FA per Mail) -------------------------------------

function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

const codeHash = (challenge, code) => sha256(`${challenge}:${code}`);

/**
 * Legt eine Anmelde-Abfrage an.
 * @returns {{ challenge: string, code: string }}
 */
export function createLoginCode(userId, remember) {
  run("DELETE FROM tokens WHERE kind = 'login_code' AND user_id = ?", userId);
  const challenge = randomToken(24);
  const code = newCode();
  const now = Date.now();
  run(`INSERT INTO tokens (token_hash, kind, user_id, created_at, expires_at, last_sent_at, data)
       VALUES (?, 'login_code', ?, ?, ?, ?, ?)`,
  sha256(challenge), userId, now, now + CODE_MINUTES * MIN, now,
  JSON.stringify({ remember: !!remember, code: codeHash(challenge, code) }));
  return { challenge, code };
}

export function findLoginCode(challenge) {
  return findLinkToken('login_code', challenge);
}

/**
 * Prüft einen Code. Jeder Fehlversuch zählt; nach CODE_MAX_ATTEMPTS ist die
 * Abfrage verbraucht.
 * @returns {'ok'|'wrong'|'locked'}
 */
export function verifyLoginCode(row, challenge, code) {
  if (row.attempts >= CODE_MAX_ATTEMPTS) return 'locked';
  const data = JSON.parse(row.data);
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length === 6 && safeEqual(codeHash(challenge, clean), data.code)) {
    return markUsed(row.id) ? 'ok' : 'locked';
  }
  run('UPDATE tokens SET attempts = attempts + 1 WHERE id = ?', row.id);
  return row.attempts + 1 >= CODE_MAX_ATTEMPTS ? 'locked' : 'wrong';
}

/** Neuen Code für dieselbe Abfrage erzeugen (begrenzt) */
export function resendLoginCode(row, challenge) {
  if (row.sends >= CODE_MAX_SENDS) return { error: 'limit' };
  const wait = row.last_sent_at + CODE_RESEND_GAP_MS - Date.now();
  if (wait > 0) return { error: 'wait', wait: Math.ceil(wait / 1000) };
  const code = newCode();
  const data = { ...JSON.parse(row.data), code: codeHash(challenge, code) };
  const now = Date.now();
  run(`UPDATE tokens SET data = ?, attempts = 0, sends = sends + 1, last_sent_at = ?, expires_at = ?
        WHERE id = ?`, JSON.stringify(data), now, now + CODE_MINUTES * MIN, row.id);
  return { code };
}

export function cleanupTokens(now = Date.now()) {
  // abgelaufene/benutzte Tokens nach einem Tag entfernen (Einladungen bleiben
  // bis zum Widerruf sichtbar, damit der Admin sie erneut senden kann)
  return run(`DELETE FROM tokens WHERE (kind <> 'invite' AND expires_at < ?) OR (used_at IS NOT NULL AND used_at < ?)`,
    now - 24 * 60 * MIN, now - 24 * 60 * MIN).changes;
}
