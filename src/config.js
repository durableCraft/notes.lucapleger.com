// Konfiguration: data/config.json
// Wird beim ersten Start mit Standardwerten angelegt. Umgebungsvariablen
// (PORT, HOST, NOTIZZETTEL_DATA) überschreiben einzelne Werte – praktisch für Tests.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = path.resolve(process.env.NOTIZZETTEL_DATA || path.join(rootDir, 'data'));
export const configPath = path.join(dataDir, 'config.json');

export const defaults = {
  // Netzwerk
  port: 3100,
  host: '127.0.0.1',
  // Öffentliche Adresse (Links in Mails, Passkey-RP-ID). Ohne abschließenden Schrägstrich.
  baseUrl: 'http://localhost:3100',
  // Hinter NGINX Proxy Manager: true bzw. Anzahl der Proxys oder IP/Subnetz des Proxys
  trustProxy: false,
  // NOTFALL: true schaltet die Zwei-Faktor-Abfrage ab – unabhängig von der Admin-Oberfläche
  disable2fa: false,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file} ist kein gültiges JSON: ${err.message}`);
  }
}

/** Lädt die Konfiguration; legt data/ und config.json bei Bedarf an. */
export function loadConfig() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let fileCfg = readJson(configPath);
  if (!fileCfg) {
    fileCfg = { ...defaults };
    fs.writeFileSync(configPath, `${JSON.stringify(fileCfg, null, 2)}\n`, { mode: 0o600 });
    console.log(`Konfiguration angelegt: ${configPath}`);
  }
  const cfg = { ...defaults, ...fileCfg };
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.BASE_URL) cfg.baseUrl = process.env.BASE_URL;
  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');
  cfg.secureCookies = cfg.baseUrl.startsWith('https://');
  cfg.disable2fa = cfg.disable2fa === true;
  return cfg;
}

/** Liest nur den Notfall-Schalter frisch von der Platte (ohne Neustart wirksam). */
export function readDisable2fa() {
  if (process.env.NOTIZZETTEL_DISABLE_2FA === '1') return true;
  const cfg = readJson(configPath);
  return cfg?.disable2fa === true;
}
