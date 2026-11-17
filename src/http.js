// HTTP-Hilfen: Fehler, Sicherheits-Header, Schutz vor Cross-Site-Anfragen.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new HttpError(400, msg, extra);
export const unauthorized = (msg = 'Bitte melde dich an.') => new HttpError(401, msg);
export const forbidden = (msg = 'Keine Berechtigung.') => new HttpError(403, msg);
export const notFound = (msg = 'Nicht gefunden.') => new HttpError(404, msg);

export function tooMany(retryAfter) {
  const min = Math.ceil(retryAfter / 60);
  return new HttpError(429, `Zu viele Versuche. Bitte warte ${min === 1 ? 'eine Minute' : `${min} Minuten`}.`, { retryAfter });
}

export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      // eingefügter Text kann style-Attribute tragen, bevor er bereinigt wird
      "style-src-attr 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  });
  next();
}

/**
 * Schutz vor CSRF für die API:
 * - zustandsändernde Anfragen brauchen den Header "X-Notizzettel: 1"
 *   (fremde Seiten können ihn ohne CORS-Freigabe nicht setzen)
 * - ein mitgesendeter Origin muss zur eigenen Adresse passen
 */
export function csrfGuard(baseUrl) {
  const allowed = new URL(baseUrl).origin;
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.get('x-notizzettel') !== '1') return next(forbidden('Ungültige Anfrage.'));
    const origin = req.get('origin');
    if (origin && origin !== allowed) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* ungültig */ }
      if (host !== req.get('host')) return next(forbidden('Ungültige Herkunft der Anfrage.'));
    }
    next();
  };
}

export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') err = new HttpError(413, 'Der Inhalt ist zu groß.');
  else if (err.type === 'entity.parse.failed') err = badRequest('Ungültige Daten.');
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) {
    // eigene Fehler (z. B. Mail nicht versendbar) sind schon protokolliert
    if (err instanceof HttpError) console.error(`${req.method} ${req.originalUrl}: ${err.message}`);
    else console.error(err);
  }
  if (err.extra?.retryAfter) res.set('Retry-After', String(err.extra.retryAfter));
  const known = err instanceof HttpError || status < 500;
  const body = { error: known ? err.message : 'Interner Fehler. Bitte versuche es später erneut.' };
  if (err.extra && status < 500) Object.assign(body, err.extra);
  res.status(status).json(body);
}

/** Prüft einen String-Wert aus dem Body */
export function str(value, { name, min = 0, max = 1000, trim = true } = {}) {
  if (typeof value !== 'string') throw badRequest(`${name} fehlt.`);
  const v = trim ? value.trim() : value;
  if (v.length < min) throw badRequest(min <= 1 ? `${name} fehlt.` : `${name} ist zu kurz (mindestens ${min} Zeichen).`);
  if (v.length > max) throw badRequest(`${name} ist zu lang.`);
  return v;
}

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;
export function email(value) {
  const v = str(value, { name: 'E-Mail', min: 3, max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(v)) throw badRequest('Bitte gib eine gültige E-Mail-Adresse ein.');
  return v;
}
