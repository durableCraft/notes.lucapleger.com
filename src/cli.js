// Befehle für cli.js

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { backup } from 'node:sqlite';
import { dataDir } from './config.js';
import { openDb, getDb, dbPath, all, run, tx } from './db.js';
import { findUserByEmail, setPassword } from './users.js';
import { destroyUserSessions } from './session.js';

const HELP = `Notizzettel – Kommandozeile

  node cli.js backup [ziel.db]
      Erstellt eine konsistente Kopie der Datenbank – auch während der Dienst läuft.
      Ohne Ziel: data/backups/notizzettel-JJJJMMTT-HHMMSS.db

  node cli.js reset-password <email>
      Setzt ein neues, zufälliges Passwort und gibt es aus.
      Alle Sitzungen des Kontos werden beendet.

  node cli.js users
      Listet alle Benutzer auf.

Hinweis: Als Dienst-Benutzer ausführen, z. B. runuser -u notizzettel -- node cli.js backup
Notfall bei Zwei-Faktor-Problemen: in data/config.json "disable2fa": true setzen.`;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function requireDb() {
  if (!fs.existsSync(dbPath)) {
    console.error(`Keine Datenbank gefunden: ${dbPath}\nWurde der Dienst schon einmal gestartet?`);
    return false;
  }
  openDb();
  return true;
}

/** Gut lesbares Zufallspasswort, z. B. "kafu-mive-tolo-rabe" */
function randomPassword() {
  const c = 'bdfghklmnprstvz';
  const v = 'aeiou';
  const syl = () => c[crypto.randomInt(c.length)] + v[crypto.randomInt(v.length)];
  return Array.from({ length: 4 }, () => syl() + syl()).join('-');
}

async function cmdBackup(target) {
  if (!requireDb()) return 1;
  const dest = path.resolve(target || path.join(dataDir, 'backups', `notizzettel-${stamp()}.db`));
  if (fs.existsSync(dest)) {
    console.error(`Ziel existiert bereits: ${dest}`);
    return 1;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const pages = await backup(getDb(), dest);
  fs.chmodSync(dest, 0o600);
  const size = fs.statSync(dest).size;
  console.log(`Backup erstellt: ${dest} (${(size / 1024).toFixed(0)} KB, ${pages} Seiten)`);
  console.log('Tipp: Sichere zusätzlich data/config.json.');
  return 0;
}

async function cmdResetPassword(email) {
  if (!email) {
    console.error('Bitte gib die E-Mail-Adresse an: node cli.js reset-password <email>');
    return 1;
  }
  if (!requireDb()) return 1;
  const user = findUserByEmail(email.trim().toLowerCase());
  if (!user) {
    console.error(`Kein Benutzer mit der E-Mail-Adresse ${email}.`);
    return 1;
  }
  const password = randomPassword();
  await setPassword(user.id, password);
  tx(() => {
    destroyUserSessions(user.id);
    run("DELETE FROM tokens WHERE kind IN ('reset', 'login_code') AND user_id = ?", user.id);
  });
  console.log(`Neues Passwort für ${user.email}:\n\n    ${password}\n`);
  console.log('Bitte nach der Anmeldung unter "Mein Konto" ändern.');
  if (user.disabled) console.log('Achtung: Das Konto ist deaktiviert. Ein Admin muss es wieder aktivieren.');
  return 0;
}

function cmdUsers() {
  if (!requireDb()) return 1;
  const users = all('SELECT email, name, role, disabled, last_login_at FROM users ORDER BY email');
  if (!users.length) {
    console.log('Noch keine Benutzer. Die Ersteinrichtung ist offen.');
    return 0;
  }
  for (const u of users) {
    const last = u.last_login_at ? new Date(u.last_login_at).toLocaleString('de-DE') : 'nie';
    console.log(`${u.email.padEnd(32)} ${u.role.padEnd(6)} ${u.disabled ? 'deaktiviert ' : ''}${u.name} (zuletzt angemeldet: ${last})`);
  }
  return 0;
}

export async function runCli(args) {
  const [cmd, ...rest] = args;
  try {
    switch (cmd) {
      case 'backup': return await cmdBackup(rest[0]);
      case 'reset-password': return await cmdResetPassword(rest[0]);
      case 'users': return cmdUsers();
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return 0;
      default:
        console.error(`Unbekannter Befehl: ${cmd}\n`);
        console.log(HELP);
        return 1;
    }
  } catch (err) {
    console.error(`Fehler: ${err.message}`);
    return 1;
  } finally {
    try { getDb().close(); } catch { /* nicht geöffnet */ }
  }
}
