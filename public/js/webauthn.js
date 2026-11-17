// Passkeys im Browser (WebAuthn) – ohne Fremdpaket.
// Wandelt die JSON-Optionen des Servers in die Objekte für
// navigator.credentials um und die Antworten zurück in JSON.

import { api } from './api.js';

const toBuf = (b64url) => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};

const toB64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function passkeysSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
}

export async function conditionalSupported() {
  try {
    return passkeysSupported() && !!(await PublicKeyCredential.isConditionalMediationAvailable?.());
  } catch {
    return false;
  }
}

/** Verständliche Meldungen für typische WebAuthn-Fehler */
export function passkeyErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError': return null; // abgebrochen oder Zeit abgelaufen – kein Fehlerhinweis nötig
    case 'AbortError': return null;
    case 'InvalidStateError': return 'Dieser Passkey ist bereits gespeichert.';
    case 'SecurityError': return 'Passkeys funktionieren nur über die eingerichtete Adresse (HTTPS).';
    case 'NotSupportedError': return 'Dieses Gerät unterstützt keine passenden Passkeys.';
    default: return err?.message || 'Der Passkey-Vorgang ist fehlgeschlagen.';
  }
}

// ---------- Passkey anlegen ------------------------------------------------------

export async function registerPasskey(name) {
  const { options } = await api('POST', '/api/passkeys/register/options', {});
  const publicKey = {
    ...options,
    challenge: toBuf(options.challenge),
    user: { ...options.user, id: toBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
  };
  const cred = await navigator.credentials.create({ publicKey });
  const r = cred.response;
  const response = {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      attestationObject: toB64url(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
  };
  return api('POST', '/api/passkeys/register/verify', { response, name });
}

// ---------- Mit Passkey anmelden -------------------------------------------------

/**
 * @param {{ conditional?: boolean, signal?: AbortSignal, remember?: boolean }} opts
 *   conditional: Passkeys im Autofill des E-Mail-Felds anbieten
 */
export async function loginWithPasskey({ conditional = false, signal, remember = true } = {}) {
  const { options, flow } = await api('POST', '/api/passkeys/login/options', {});
  const publicKey = {
    ...options,
    challenge: toBuf(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
  };
  const cred = await navigator.credentials.get({
    publicKey,
    signal,
    ...(conditional ? { mediation: 'conditional' } : {}),
  });
  const r = cred.response;
  const response = {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: r.userHandle ? toB64url(r.userHandle) : undefined,
    },
  };
  return api('POST', '/api/passkeys/login/verify', { flow, response, remember });
}

/** Vorschlag für den Namen eines neuen Passkeys */
export function suggestPasskeyName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Passkey';
}
