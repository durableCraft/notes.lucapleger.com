// Kleine Hilfsfunktionen

/** UUID v4 – auch ohne sicheren Kontext (z. B. http://192.168…). */
export function uuid() {
  if (globalThis.crypto?.randomUUID) {
    try { return crypto.randomUUID(); } catch { /* unsicherer Kontext */ }
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Template-Tag: interpolierte Werte werden escaped, html.raw() bleibt roh. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += (v && v.__raw) ? v.value : Array.isArray(v) ? v.map((x) => (x && x.__raw ? x.value : escapeHtml(x))).join('') : escapeHtml(v ?? '');
    out += strings[i + 1];
  });
  return { __raw: true, value: out, toString() { return out; } };
}
html.raw = (value) => ({ __raw: true, value: String(value) });

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  d.pending = () => t !== null;
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

// ---------- Datum/Zeit ------------------------------------------------------

const DAY = 864e5;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** Montag 00:00 der Woche von d */
function startOfWeek(d) {
  const x = new Date(startOfDay(d));
  const dow = (x.getDay() + 6) % 7; // Mo = 0
  x.setDate(x.getDate() - dow);
  return x.getTime();
}

/** Gruppe für den Verlauf: today | yesterday | week | older */
export function groupOf(ts, now = Date.now()) {
  const today = startOfDay(now);
  if (ts >= today) return 'today';
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (ts >= y.getTime()) return 'yesterday';
  if (ts >= startOfWeek(now)) return 'week';
  return 'older';
}

export const groupLabels = {
  today: 'Heute',
  yesterday: 'Gestern',
  week: 'Diese Woche',
  older: 'Älter',
};

const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtWeekday = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
const fmtDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtLong = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });

/** Kurze Zeitangabe passend zur Gruppe */
export function shortTime(ts, now = Date.now()) {
  const g = groupOf(ts, now);
  if (g === 'today' || g === 'yesterday') return fmtTime.format(ts);
  if (g === 'week') return fmtWeekday.format(ts).replace('.', '');
  return fmtDate.format(ts);
}

export function longDate(ts) { return fmtLong.format(ts); }
export function dateOnly(ts) { return fmtDate.format(ts); }

export function daysLeft(deletedAt, keepDays, now = Date.now()) {
  return Math.max(0, Math.ceil((deletedAt + keepDays * DAY - now) / DAY));
}

export { DAY };
