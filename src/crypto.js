// Passwörter (scrypt) und Tokens. Tokens und Codes werden nur gehasht gespeichert.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// N = 2^15, r = 8, p = 1 → ca. 32 MB Speicher, ~50–100 ms pro Prüfung
const PARAMS = { logN: 15, r: 8, p: 1, keylen: 64 };

function scryptOpts(logN, r, p) {
  const N = 2 ** logN;
  return { N, r, p, maxmem: 256 * N * r };
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 512;

/** Format: scrypt$logN$r$p$salt(b64)$hash(b64) */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { logN, r, p, keylen } = PARAMS;
  const hash = await scrypt(String(password).normalize('NFKC'), salt, keylen, scryptOpts(logN, r, p));
  return `scrypt$${logN}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Für unbekannte Benutzer: gleiche Rechenzeit wie bei einer echten Prüfung
let dummyHash = null;

export async function verifyPassword(password, stored) {
  if (!stored) {
    dummyHash ??= await hashPassword('dummy-password-for-timing');
    await verifyPassword(password, dummyHash);
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logN, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'),
    expected.length, scryptOpts(Number(logN), Number(r), Number(p)));
  return crypto.timingSafeEqual(actual, expected);
}

/** Zufälliges Token (base64url) */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Gut abtippbares Token, z. B. für den Setup-Assistenten: XXXX-XXXX-XXXX-XXXX */
export function readableToken(groups = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O, 1/I
  const out = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    out.push(s);
  }
  return out.join('-');
}

/** Normalisiert eine Eingabe für readableToken (Groß-/Kleinschreibung, Leerzeichen) */
export function normalizeReadableToken(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');
}
