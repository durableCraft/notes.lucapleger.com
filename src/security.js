// Zwei-Faktor-Code per E-Mail: Einstellung, Wirksamkeit, Notfall-Schalter

import { getSetting, setSetting } from './db.js';
import { readDisable2fa } from './config.js';
import { smtpTested } from './mailer.js';

/** Einstellung in der Admin-Oberfläche */
export function twoFactorSetting() {
  return getSetting('twofa', false) === true;
}

export function setTwoFactor(on) {
  setSetting('twofa', !!on);
}

/**
 * Wird der Code beim Login tatsächlich abgefragt?
 * Nur mit getestetem SMTP – und nie, wenn data/config.json "disable2fa": true enthält.
 */
export function twoFactorActive() {
  return twoFactorSetting() && smtpTested() && !readDisable2fa();
}

export function securityStatus() {
  return {
    twofa: twoFactorSetting(),
    active: twoFactorActive(),
    smtpTested: smtpTested(),
    disabledByConfig: readDisable2fa(),
  };
}

/** l***@example.com */
export function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`;
}
