// Abgleich mit dem Server (nur mit Anmeldung). Die Zettel liegen dabei nur im
// Arbeitsspeicher: Änderungen werden kurz nach dem Tippen hochgeladen,
// Änderungen anderer Geräte regelmäßig geholt.
// Konflikte: die neueste Änderung (updatedAt) gewinnt.
//
// Ereignisse:
//   'state'   detail: 'syncing' | 'ok' | 'offline' | 'auth' | 'error'
//   'pushed'  detail: { count }          – Änderungen vom Server bestätigt
//   'remote'  detail: { ids: string[] }  – Zettel wurden vom Server geändert

import { api } from './api.js';

const INTERVAL_MS = 30_000;
const SOON_MS = 300;

export class Sync extends EventTarget {
  /** @param {import('./store.js').NoteStore} store */
  constructor(store) {
    super();
    this.store = store;
    this.state = 'idle';
    this.running = null;
    this.again = false;
    this.soonTimer = null;
    this.stopped = false;
    /** Es gibt Änderungen, die der Server noch nicht bestätigt hat */
    this.pending = false;
  }

  /** Startet den Abgleich; das Promise endet nach dem ersten Laden. */
  start() {
    const first = this.run();
    this.interval = setInterval(() => this.run(), INTERVAL_MS);
    window.addEventListener('online', () => this.run());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.run();
    });
    this.store.addEventListener('change', (e) => {
      if (e.detail?.remote) return;
      this.pending = true;
      this.soon();
    });
    return first;
  }

  /** Beim Schließen der Seite: offene Änderungen noch absenden (keepalive). */
  async flush() {
    for (const n of await this.store.dirty()) {
      api('PUT', `/api/notes/${n.id}`, bodyOf(n), { keepalive: true }).catch(() => {});
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.interval);
    clearTimeout(this.soonTimer);
  }

  /** Kurz nach einer lokalen Änderung abgleichen (gebündelt) */
  soon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.run(), SOON_MS);
  }

  setState(s) {
    if (s === this.state) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }

  /** Startet einen Abgleich; läuft schon einer, folgt direkt danach ein weiterer. */
  run() {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.doRun().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.run();
      }
    });
    return this.running;
  }

  async doRun() {
    const { store } = this;
    const changed = new Set();
    let pushed = 0;
    try {
      this.setState('syncing');

      // 1. Hochladen
      for (const n of await store.dirty()) {
        let r;
        try {
          r = await api('PUT', `/api/notes/${n.id}`, bodyOf(n));
        } catch (err) {
          // Ein einzelner abgelehnter Zettel (z. B. zu groß) blockiert nicht den Rest
          if (err.status === 400 || err.status === 413) {
            console.warn(`Zettel ${n.id} wurde vom Server abgelehnt: ${err.message}`);
            continue;
          }
          throw err;
        }
        pushed++;
        if (r.applied) {
          await store.markSynced(n.id, n.updatedAt);
        } else if (await store.applyRemote(r.note)) {
          changed.add(n.id);      // Server hatte einen neueren Stand
        }
      }

      // 2. Holen
      const since = (await store.getMeta('rev')) || 0;
      const r = await api('GET', `/api/notes?since=${since}`);
      for (const sn of r.notes) {
        if (await store.applyRemote(sn)) changed.add(sn.id);
      }
      await store.setMeta('rev', r.rev);
      await store.setMeta('lastSync', Date.now());
      this.pending = (await store.dirty()).length > 0;
      this.setState('ok');
    } catch (err) {
      this.pending = (await store.dirty()).length > 0;
      if (err.status === 401) {
        this.setState('auth');
        this.dispatchEvent(new Event('unauthorized'));
      }
      else if (err.status === 0) this.setState('offline');
      else {
        console.warn('Abgleich fehlgeschlagen:', err.message);
        this.setState('error');
      }
    }
    if (pushed) this.dispatchEvent(new CustomEvent('pushed', { detail: { count: pushed } }));
    if (changed.size) this.dispatchEvent(new CustomEvent('remote', { detail: { ids: [...changed] } }));
  }
}

function bodyOf(n) {
  return n.purged
    ? { purged: true, updatedAt: n.updatedAt, deletedAt: n.deletedAt, createdAt: n.createdAt }
    : { html: n.html, createdAt: n.createdAt, updatedAt: n.updatedAt, deletedAt: n.deletedAt };
}
