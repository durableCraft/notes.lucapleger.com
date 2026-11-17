// Sitzungen über ein HttpOnly-Cookie. In der Datenbank liegt nur der Hash.
//   "Angemeldet bleiben": Cookie mit Max-Age ~1 Jahr, rollierend verlängert
//   sonst: Cookie ohne Ablaufdatum (gilt bis zum Schließen des Browsers),
//          serverseitig zusätzlich 24 h Leerlauf-Grenze

import { randomToken, sha256 } from './crypto.js';
import { one, run } from './db.js';
import { unauthorized, forbidden } from './http.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const PERSISTENT_MS = 365 * DAY;
export const TRANSIENT_IDLE_MS = 24 * HOUR;
const TOUCH_EVERY_MS = HOUR;

let cfg = null;
export function initSessions(config) { cfg = config; }

export function cookieName() {
  // __Host-: nur über HTTPS, nur für genau diesen Host, Pfad /
  return cfg.secureCookies ? '__Host-nz_session' : 'nz_session';
}

function setCookie(res, token, persistent) {
  res.cookie(cookieName(), token, {
    httpOnly: true,
    secure: cfg.secureCookies,
    sameSite: 'lax',
    path: '/',
    ...(persistent ? { maxAge: PERSISTENT_MS } : {}),
  });
}

export function clearCookie(res) {
  res.clearCookie(cookieName(), { httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax', path: '/' });
}

function readCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const name = cookieName();
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

export function createSession(req, res, userId, persistent) {
  const token = randomToken(32);
  const now = Date.now();
  run(`INSERT INTO sessions (token_hash, user_id, persistent, created_at, last_seen_at, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  sha256(token), userId, persistent ? 1 : 0, now, now,
  now + (persistent ? PERSISTENT_MS : TRANSIENT_IDLE_MS),
  String(req.get('user-agent') || '').slice(0, 300));
  run('UPDATE users SET last_login_at = ? WHERE id = ?', now, userId);
  setCookie(res, token, persistent);
}

/** Middleware: setzt req.user und req.sessionHash, falls angemeldet. */
export function loadSession(req, res, next) {
  req.user = null;
  const token = readCookie(req);
  if (!token) return next();
  const hash = sha256(token);
  const now = Date.now();
  const row = one(`
    SELECT s.persistent, s.last_seen_at, s.expires_at,
           u.id, u.email, u.name, u.role, u.disabled
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`, hash);
  if (!row || row.expires_at <= now || row.disabled) {
    if (row) run('DELETE FROM sessions WHERE token_hash = ?', hash);
    clearCookie(res);
    return next();
  }
  // rollierend verlängern (höchstens einmal pro Stunde schreiben)
  if (now - row.last_seen_at > TOUCH_EVERY_MS) {
    run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?',
      now, now + (row.persistent ? PERSISTENT_MS : TRANSIENT_IDLE_MS), hash);
    if (row.persistent) setCookie(res, token, true);
  }
  req.user = { id: row.id, email: row.email, name: row.name, role: row.role };
  req.sessionHash = hash;
  next();
}

export function destroySession(req, res) {
  if (req.sessionHash) run('DELETE FROM sessions WHERE token_hash = ?', req.sessionHash);
  clearCookie(res);
}

/** Alle Sitzungen eines Benutzers beenden (optional außer der aktuellen) */
export function destroyUserSessions(userId, exceptHash = null) {
  if (exceptHash) run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, exceptHash);
  else run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function cleanupSessions() {
  return run('DELETE FROM sessions WHERE expires_at <= ?', Date.now()).changes;
}

export function requireUser(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden());
  next();
}
