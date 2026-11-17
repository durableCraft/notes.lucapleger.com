// Zettel-Speicher im Browser (IndexedDB).
// Ein Zettel: { id, html, title, createdAt, updatedAt, deletedAt, purged, dirty }
//   deletedAt  null = aktiv, sonst Zeitpunkt des Löschens (Papierkorb)
//   purged     endgültig gelöscht – nur im Konto-Modus als Grabstein, bis der
//              Server es bestätigt hat
//   dirty      lokal geändert, noch nicht mit dem Server abgeglichen
//
// Ohne Anmeldung: eine Datenbank "notizzettel-lokal".
// Mit Anmeldung:  je Konto eine eigene Datenbank als Zwischenspeicher (synced = true).

import { openDB, deleteDB } from './idb.js';
import { titleOf } from './sanitize.js';
import { DAY } from './util.js';

export const TRASH_DAYS = 30;
export const LOCAL_DB = 'notizzettel-lokal';
export const userDbName = (userId) => `notizzettel-konto-${userId}`;

const NOTES = 'notes';
const META = 'meta';

const isActive = (n) => !n.deletedAt && !n.purged;
const isTrashed = (n) => !!n.deletedAt && !n.purged;

export class NoteStore extends EventTarget {
  /**
   * @param {string} dbName
   * @param {{ synced?: boolean }} [opts]  synced: Konto-Modus mit Server-Abgleich
   */
  constructor(dbName, { synced = false } = {}) {
    super();
    this.dbName = dbName;
    this.synced = synced;
    this.db = null;
  }

  async open() {
    this.db = await openDB(this.dbName, 1, (db) => {
      if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    }, [NOTES, META]);
    return this;
  }

  get persistent() { return this.db?.persistent ?? false; }

  /** @param {{ type: string, id?: string, remote?: boolean }} detail */
  changed(detail) {
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }

  async all() { return this.db.getAll(NOTES); }

  /** Aktive Zettel, neueste zuerst */
  async list() {
    return (await this.all()).filter(isActive).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Papierkorb, zuletzt gelöschte zuerst */
  async trash() {
    return (await this.all()).filter(isTrashed).sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async dirty() { return (await this.all()).filter((n) => n.dirty); }

  async get(id) {
    const n = await this.db.get(NOTES, id);
    return n && !n.purged ? n : undefined;
  }

  async getRaw(id) { return this.db.get(NOTES, id); }

  /** Speichert Inhalt; legt den Zettel bei Bedarf an. */
  async save(id, html, now = Date.now()) {
    const existing = await this.get(id);
    const note = {
      id,
      html,
      title: titleOf(html),
      createdAt: existing?.createdAt ?? now,
      updatedAt: Math.max(now, (existing?.updatedAt ?? 0) + 1),
      deletedAt: existing?.deletedAt ?? null,
      purged: false,
      dirty: true,
    };
    await this.db.put(NOTES, note);
    this.changed({ type: 'save', id });
    return note;
  }

  async update(id, patch, type, now = Date.now()) {
    const note = await this.get(id);
    if (!note) return null;
    Object.assign(note, patch, { updatedAt: Math.max(now, note.updatedAt + 1), dirty: true });
    await this.db.put(NOTES, note);
    this.changed({ type, id });
    return note;
  }

  async moveToTrash(id, now = Date.now()) {
    const note = await this.get(id);
    if (!note || note.deletedAt) return;
    await this.update(id, { deletedAt: now }, 'trash', now);
  }

  async restore(id, now = Date.now()) {
    const note = await this.get(id);
    if (!note || !note.deletedAt) return;
    await this.update(id, { deletedAt: null }, 'restore', now);
  }

  /** Endgültig entfernen. Im Konto-Modus bleibt ein Grabstein bis zum Abgleich. */
  async remove(id, now = Date.now()) {
    const note = await this.getRaw(id);
    if (!note) return;
    if (this.synced) {
      await this.db.put(NOTES, tombstone(note, now));
    } else {
      await this.db.delete(NOTES, id);
    }
    this.changed({ type: 'remove', id });
  }

  async emptyTrash(now = Date.now()) {
    const trashed = await this.trash();
    await this.db.batch(NOTES, (st) => trashed.forEach((n) => {
      if (this.synced) st.put(tombstone(n, now)); else st.delete(n.id);
    }));
    this.changed({ type: 'empty' });
    return trashed.length;
  }

  /** Löscht Zettel, die länger als TRASH_DAYS im Papierkorb liegen (nur lokal). */
  async purgeExpired(now = Date.now()) {
    const limit = now - TRASH_DAYS * DAY;
    const expired = (await this.trash()).filter((n) => n.deletedAt < limit && !n.dirty);
    if (expired.length) {
      await this.db.batch(NOTES, (st) => expired.forEach((n) => st.delete(n.id)));
      this.changed({ type: 'purge' });
    }
    return expired.length;
  }

  // ---------- Abgleich -------------------------------------------------------

  /** Server hat den Stand übernommen: als abgeglichen markieren (falls unverändert). */
  async markSynced(id, updatedAt) {
    const note = await this.getRaw(id);
    if (!note || note.updatedAt !== updatedAt) return;
    if (note.purged) await this.db.delete(NOTES, id);
    else await this.db.put(NOTES, { ...note, dirty: false });
  }

  /**
   * Stand vom Server übernehmen (neueste Änderung gewinnt).
   * @returns {Promise<boolean>} true, wenn sich lokal etwas geändert hat
   */
  async applyRemote(sn, { force = false } = {}) {
    const local = await this.getRaw(sn.id);
    if (local && !force) {
      if (local.dirty && local.updatedAt > sn.updatedAt) return false;   // eigener Stand ist neuer
      if (!local.dirty && local.updatedAt === sn.updatedAt
          && !!local.deletedAt === !!sn.deletedAt && !!local.purged === !!sn.purged) return false;
    }
    if (sn.purged) {
      if (!local) return false;
      await this.db.delete(NOTES, sn.id);
    } else {
      await this.db.put(NOTES, {
        id: sn.id,
        html: sn.html,
        title: sn.title ?? titleOf(sn.html),
        createdAt: sn.createdAt,
        updatedAt: sn.updatedAt,
        deletedAt: sn.deletedAt ?? null,
        purged: false,
        dirty: false,
      });
    }
    this.changed({ type: 'remote', id: sn.id, remote: true });
    return true;
  }

  /** Zettel aus einem anderen Speicher übernehmen (z. B. lokale Zettel beim Login). */
  async importNotes(notes) {
    let count = 0;
    for (const n of notes) {
      if (n.purged) continue;
      const existing = await this.getRaw(n.id);
      if (existing && existing.updatedAt >= n.updatedAt) continue;
      await this.db.put(NOTES, { ...n, purged: false, dirty: true });
      count++;
    }
    if (count) this.changed({ type: 'import' });
    return count;
  }

  async getMeta(key) { return this.db.get(META, key); }
  async setMeta(key, value) { return this.db.put(META, value, key); }

  async destroy() {
    this.db?.close();
    await deleteDB(this.dbName);
  }
}

function tombstone(note, now) {
  return {
    ...note,
    html: '',
    title: '',
    deletedAt: note.deletedAt ?? now,
    updatedAt: Math.max(now, note.updatedAt + 1),
    purged: true,
    dirty: true,
  };
}
