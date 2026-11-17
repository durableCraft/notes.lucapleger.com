// Wiederkehrende Aufgaben (täglich): Papierkorb leeren, Sitzungen aufräumen.

import { all, run, tx } from './db.js';
import { purgeNote } from './routes/notes.js';
import { cleanupSessions } from './session.js';
import { cleanupTokens } from './tokens.js';

const DAY = 86_400_000;
export const TRASH_DAYS = 30;
const TOMBSTONE_DAYS = 180;

export function runDailyJobs(now = Date.now()) {
  const purged = tx(() => {
    const expired = all(`SELECT user_id, id FROM notes
                          WHERE purged = 0 AND deleted_at IS NOT NULL AND deleted_at < ?`, now - TRASH_DAYS * DAY);
    for (const n of expired) purgeNote(n.user_id, n.id, now);
    return expired.length;
  });
  // Grabsteine nach langer Zeit entfernen (Geräte, die so lange offline waren,
  // haben die Zettel inzwischen ohnehin selbst aus dem Papierkorb gelöscht)
  const tombstones = run('DELETE FROM notes WHERE purged = 1 AND updated_at < ?', now - TOMBSTONE_DAYS * DAY).changes;
  const sessions = cleanupSessions();
  cleanupTokens(now);
  if (purged || tombstones || sessions) {
    console.log(`Aufräumen: ${purged} Zettel aus dem Papierkorb gelöscht, ${tombstones} Grabsteine, ${sessions} abgelaufene Sitzungen.`);
  }
}

export function startJobs() {
  const tick = () => {
    try { runDailyJobs(); } catch (err) { console.error('Aufräumen fehlgeschlagen:', err); }
  };
  tick();
  setInterval(tick, DAY).unref();
}
