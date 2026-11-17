// Zettel-Speicher im Browser (IndexedDB).
// Ein Zettel: { id, html, title, createdAt, updatedAt, deletedAt, dirty }
//   deletedAt  null = aktiv, sonst Zeitpunkt des Löschens (Papierkorb)
//   dirty      lokal geändert, noch nicht mit dem Server abgeglichen (ab Schritt 2)

import { openDB, deleteDB } from './idb.js';
import { titleOf } from './sanitize.js';
import { DAY } from './util.js';

export const TRASH_DAYS = 30;
const NOTES = 'notes';
const META = 'meta';

export class NoteStore extends EventTarget {
  /** @param {string} dbName  z. B. "notizzettel-lokal" */
  constructor(dbName) {
    super();
    this.dbName = dbName;
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

  changed(detail) {
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }

  async all() { return this.db.getAll(NOTES); }

  /** Aktive Zettel, neueste zuerst */
  async list() {
    const notes = await this.all();
    return notes.filter((n) => !n.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Papierkorb, zuletzt gelöschte zuerst */
  async trash() {
    const notes = await this.all();
    return notes.filter((n) => n.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async get(id) { return this.db.get(NOTES, id); }

  /** Speichert Inhalt; legt den Zettel bei Bedarf an. */
  async save(id, html, now = Date.now()) {
    const existing = await this.get(id);
    const note = {
      id,
      html,
      title: titleOf(html),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: existing?.deletedAt ?? null,
      dirty: true,
    };
    await this.db.put(NOTES, note);
    this.changed({ type: 'save', id });
    return note;
  }

  async moveToTrash(id, now = Date.now()) {
    const note = await this.get(id);
    if (!note || note.deletedAt) return;
    note.deletedAt = now;
    note.updatedAt = now;
    note.dirty = true;
    await this.db.put(NOTES, note);
    this.changed({ type: 'trash', id });
  }

  async restore(id, now = Date.now()) {
    const note = await this.get(id);
    if (!note || !note.deletedAt) return;
    note.deletedAt = null;
    note.updatedAt = now;
    note.dirty = true;
    await this.db.put(NOTES, note);
    this.changed({ type: 'restore', id });
  }

  /** Endgültig entfernen (ohne Papierkorb) */
  async remove(id) {
    await this.db.delete(NOTES, id);
    this.changed({ type: 'remove', id });
  }

  async emptyTrash() {
    const trashed = await this.trash();
    await this.db.batch(NOTES, (st) => trashed.forEach((n) => st.delete(n.id)));
    this.changed({ type: 'empty' });
    return trashed.length;
  }

  /** Löscht Zettel, die länger als TRASH_DAYS im Papierkorb liegen. */
  async purgeExpired(now = Date.now()) {
    const limit = now - TRASH_DAYS * DAY;
    const expired = (await this.trash()).filter((n) => n.deletedAt < limit);
    if (expired.length) {
      await this.db.batch(NOTES, (st) => expired.forEach((n) => st.delete(n.id)));
      this.changed({ type: 'purge' });
    }
    return expired.length;
  }

  async getMeta(key) { return this.db.get(META, key); }
  async setMeta(key, value) { return this.db.put(META, value, key); }

  async destroy() {
    this.db?.close();
    await deleteDB(this.dbName);
  }
}
