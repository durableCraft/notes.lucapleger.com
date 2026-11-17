// Benutzer-Hilfen

import { one, run } from './db.js';
import { hashPassword, PASSWORD_MIN, PASSWORD_MAX } from './crypto.js';
import { badRequest, str } from './http.js';

export function userCount() {
  return one('SELECT COUNT(*) AS n FROM users').n;
}

export function findUserByEmail(email) {
  return one('SELECT * FROM users WHERE email = ?', email);
}

export function findUser(id) {
  return one('SELECT * FROM users WHERE id = ?', id);
}

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw badRequest(`Das Passwort muss mindestens ${PASSWORD_MIN} Zeichen lang sein.`);
  }
  if (password.length > PASSWORD_MAX) throw badRequest('Das Passwort ist zu lang.');
  return password;
}

export function checkName(name) {
  return str(name, { name: 'Name', min: 1, max: 100 });
}

export async function createUser({ email, name, password, role }) {
  if (findUserByEmail(email)) throw badRequest('Diese E-Mail-Adresse ist bereits vergeben.');
  const now = Date.now();
  const hash = password ? await hashPassword(password) : null;
  const res = run(`INSERT INTO users (email, name, password_hash, role, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)`, email, name, hash, role, now, now);
  return findUser(Number(res.lastInsertRowid));
}

export async function setPassword(userId, password) {
  const hash = await hashPassword(password);
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, Date.now(), userId);
}
