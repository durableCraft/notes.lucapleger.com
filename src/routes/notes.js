// Notizen-API mit Abgleich nach "neueste Änderung gewinnt".
//
//   GET    /api/notes?since=REV      Änderungen seit REV (inkl. Grabsteine)
//   PUT    /api/notes/:id            vollständiger Zustand eines Zettels
//   DELETE /api/notes/:id            → Papierkorb
//   POST   /api/notes/:id/restore    aus dem Papierkorb zurück
//   DELETE /api/trash                Papierkorb leeren (endgültig)
//
// Jeder Zettel trägt updatedAt (Zeitpunkt der letzten Änderung laut Gerät).
// Ein PUT mit älterem updatedAt als auf dem Server wird nicht übernommen;
// die Antwort enthält dann den neueren Server-Stand.

import { Router } from 'express';
import { one, all, run, tx, nextRev, currentRev } from '../db.js';
import { badRequest, notFound } from '../http.js';
import { requireUser } from '../session.js';
import { sanitizeNote, noteTitle } from '../sanitize.js';

export const notesRoutes = Router();
notesRoutes.use(['/notes', '/trash'], requireUser);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HTML = 512 * 1024;
const CLOCK_SKEW_MS = 60_000;

function noteJson(r) {
  return {
    id: r.id,
    html: r.html,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at ?? null,
    purged: !!r.purged,
    rev: r.rev,
  };
}

function checkId(id) {
  if (!UUID_RE.test(id)) throw badRequest('Ungültige Zettel-ID.');
  return id.toLowerCase();
}

function timestamp(value, name, { optional = false } = {}) {
  if (value === null || value === undefined) {
    if (optional) return null;
    throw badRequest(`${name} fehlt.`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw badRequest(`${name} ist ungültig.`);
  // Uhren von Geräten in der Zukunft dürfen nicht dauerhaft "gewinnen"
  return Math.min(n, Date.now() + CLOCK_SKEW_MS);
}

const getNote = (userId, id) => one('SELECT * FROM notes WHERE user_id = ? AND id = ?', userId, id);

// ---------- Abgleich ---------------------------------------------------------

notesRoutes.get('/notes', (req, res) => {
  const since = Math.max(0, Number.parseInt(req.query.since, 10) || 0);
  const rows = since === 0
    ? all('SELECT * FROM notes WHERE user_id = ? AND purged = 0 ORDER BY rev', req.user.id)
    : all('SELECT * FROM notes WHERE user_id = ? AND rev > ? ORDER BY rev', req.user.id, since);
  res.json({ rev: currentRev(), notes: rows.map(noteJson) });
});

notesRoutes.put('/notes/:id', (req, res) => {
  const id = checkId(req.params.id);
  const b = req.body || {};
  const purged = b.purged === true;
  const updatedAt = timestamp(b.updatedAt, 'updatedAt');
  const deletedAt = purged ? (timestamp(b.deletedAt, 'deletedAt', { optional: true }) ?? updatedAt)
    : timestamp(b.deletedAt, 'deletedAt', { optional: true });
  let html = '';
  if (!purged) {
    if (typeof b.html !== 'string') throw badRequest('Inhalt fehlt.');
    if (b.html.length > MAX_HTML) throw badRequest('Der Zettel ist zu groß.');
    html = sanitizeNote(b.html);
  }

  const result = tx(() => {
    const existing = getNote(req.user.id, id);
    if (existing && existing.updated_at > updatedAt) {
      return { applied: false, note: existing };
    }
    const createdAt = existing?.created_at ?? (timestamp(b.createdAt, 'createdAt', { optional: true }) ?? updatedAt);
    const rev = nextRev();
    run(`INSERT INTO notes (user_id, id, html, title, created_at, updated_at, deleted_at, purged, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           html = excluded.html, title = excluded.title, updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at, purged = excluded.purged, rev = excluded.rev`,
    req.user.id, id, html, purged ? '' : noteTitle(html), createdAt, updatedAt,
    deletedAt, purged ? 1 : 0, rev);
    return { applied: true, note: getNote(req.user.id, id) };
  });
  res.json({ applied: result.applied, note: noteJson(result.note), rev: currentRev() });
});

// ---------- Papierkorb (wie im API-Entwurf) ----------------------------------

function setDeleted(req, deleted) {
  const id = checkId(req.params.id);
  return tx(() => {
    const n = getNote(req.user.id, id);
    if (!n || n.purged) throw notFound('Zettel nicht gefunden.');
    if (!!n.deleted_at === deleted) return n;
    const now = Date.now();
    run('UPDATE notes SET deleted_at = ?, updated_at = ?, rev = ? WHERE user_id = ? AND id = ?',
      deleted ? now : null, Math.max(now, n.updated_at + 1), nextRev(), req.user.id, id);
    return getNote(req.user.id, id);
  });
}

notesRoutes.delete('/notes/:id', (req, res) => {
  res.json({ note: noteJson(setDeleted(req, true)), rev: currentRev() });
});

notesRoutes.post('/notes/:id/restore', (req, res) => {
  res.json({ note: noteJson(setDeleted(req, false)), rev: currentRev() });
});

notesRoutes.delete('/trash', (req, res) => {
  const count = tx(() => {
    const ids = all('SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL AND purged = 0', req.user.id);
    const now = Date.now();
    for (const { id } of ids) purgeNote(req.user.id, id, now);
    return ids.length;
  });
  res.json({ purged: count, rev: currentRev() });
});

/** Endgültig löschen: Inhalt weg, Grabstein bleibt für den Abgleich */
export function purgeNote(userId, id, now = Date.now()) {
  run(`UPDATE notes SET html = '', title = '', purged = 1, updated_at = MAX(updated_at + 1, ?), rev = ?
        WHERE user_id = ? AND id = ?`, now, nextRev(), userId, id);
}
