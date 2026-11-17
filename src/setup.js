// Ersteinrichtung: Solange es keinen Benutzer gibt, wird bei jedem Start ein
// einmaliges Setup-Token erzeugt und in der Konsole bzw. im Journal ausgegeben.
// Nur wer es kennt, kann im Assistenten das erste (Admin-)Konto anlegen.

import { readableToken, normalizeReadableToken, sha256, safeEqual } from './crypto.js';
import { userCount } from './users.js';

let tokenHash = null;

export function setupRequired() {
  return userCount() === 0;
}

export function initSetup(cfg) {
  if (!setupRequired()) {
    tokenHash = null;
    return;
  }
  const token = readableToken(4);
  tokenHash = sha256(token);
  const line = '='.repeat(64);
  console.log([
    '',
    line,
    '  Notizzettel – Ersteinrichtung',
    '',
    `  Öffne ${cfg.baseUrl}/setup und gib dieses Setup-Token ein:`,
    '',
    `      ${token}`,
    '',
    '  Das Token gilt bis zum nächsten Neustart des Dienstes.',
    line,
    '',
  ].join('\n'));
}

export function checkSetupToken(input) {
  if (!tokenHash) return false;
  return safeEqual(sha256(normalizeReadableToken(input)), tokenHash);
}

export function consumeSetupToken() {
  tokenHash = null;
}
