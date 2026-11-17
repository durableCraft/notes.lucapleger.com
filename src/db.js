// SQLite über das eingebaute node:sqlite (keine nativen Pakete).

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from './config.js';

export const dbPath = path.join(dataDir, 'notizzettel.db');

// Jede Migration genau einmal, Reihenfolge = Version (PRAGMA user_version).
const migrations = [
  // 1: Benutzer, Sitzungen, Notizen, Einstellungen
  `
  CREATE TABLE users (
    id             INTEGER PRIMARY KEY,
    email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    name           TEXT    NOT NULL,
    password_hash  TEXT,
    role           TEXT    NOT NULL CHECK (role IN ('user', 'admin')),
    disabled       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_login_at  INTEGER
  );

  CREATE TABLE sessions (
    token_hash    TEXT    PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persistent    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    user_agent    TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);

  -- Notizen: id wird im Client erzeugt (UUID). Pro Benutzer eindeutig.
  -- updated_at = Zeitpunkt der letzten Änderung laut Client (neueste gewinnt)
  -- rev        = fortlaufende Server-Revision für den Abgleich
  -- purged     = endgültig gelöscht (Grabstein, damit andere Geräte es erfahren)
  CREATE TABLE notes (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT    NOT NULL,
    html        TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    purged      INTEGER NOT NULL DEFAULT 0,
    rev         INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  ) WITHOUT ROWID;
  CREATE INDEX notes_user_rev ON notes(user_id, rev);

  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  INSERT INTO settings (key, value) VALUES ('rev', '0');
  `,
  // 2: Einmal-Tokens (Einladungen, Passwort-Reset, Anmelde-Codes)
  `
  CREATE TABLE tokens (
    id          INTEGER PRIMARY KEY,
    token_hash  TEXT    NOT NULL UNIQUE,
    kind        TEXT    NOT NULL CHECK (kind IN ('invite', 'reset', 'login_code')),
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    email       TEXT,
    name        TEXT,
    role        TEXT,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    attempts    INTEGER NOT NULL DEFAULT 0,
    sends       INTEGER NOT NULL DEFAULT 1,
    last_sent_at INTEGER,
    data        TEXT
  );
  CREATE INDEX tokens_kind ON tokens(kind, expires_at);
  `,
  // 3: Passkeys (WebAuthn)
  `
  ALTER TABLE users ADD COLUMN webauthn_id TEXT;
  CREATE TABLE passkeys (
    id            TEXT    PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key    BLOB    NOT NULL,
    counter       INTEGER NOT NULL DEFAULT 0,
    transports    TEXT,
    device_type   TEXT,
    backed_up     INTEGER NOT NULL DEFAULT 0,
    name          TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
  );
  CREATE INDEX passkeys_user ON passkeys(user_id);
  `,
];

let db = null;

export function openDb(file = dbPath) {
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate();
  return db;
}

export function getDb() {
  if (!db) throw new Error('Datenbank ist nicht geöffnet');
  return db;
}

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < migrations.length; v++) {
    tx(() => {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Führt fn in einer Transaktion aus (verschachtelt über Savepoints). */
let depth = 0;
export function tx(fn) {
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

// Vorbereitete Statements werden zwischengespeichert.
const cache = new Map();
export function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export const one = (sql, ...params) => stmt(sql).get(...params);
export const all = (sql, ...params) => stmt(sql).all(...params);
export const run = (sql, ...params) => stmt(sql).run(...params);

// ---------- Einstellungen ----------------------------------------------------

export function getSetting(key, fallback = null) {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}

/** Nächste globale Revision (innerhalb einer Transaktion aufrufen). */
export function nextRev() {
  run("UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev'");
  return Number(one("SELECT value FROM settings WHERE key = 'rev'").value);
}

export function currentRev() {
  return Number(one("SELECT value FROM settings WHERE key = 'rev'").value);
}
