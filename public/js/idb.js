// Kleiner Promise-Wrapper um IndexedDB.
// Fällt auf einen Speicher im Arbeitsspeicher zurück, wenn IndexedDB fehlt
// (z. B. blockiert); dann ist `persistent` false.

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function wrap(db) {
  /** Führt fn(store) in einer Transaktion aus und wartet auf deren Abschluss. */
  function tx(storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let result;
      const r = fn(store);
      if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaktion abgebrochen'));
    });
  }

  db.onversionchange = () => db.close();

  return {
    persistent: true,
    get: (s, key) => tx(s, 'readonly', (st) => st.get(key)),
    getAll: (s) => tx(s, 'readonly', (st) => st.getAll()),
    put: (s, value, key) => tx(s, 'readwrite', (st) => (key === undefined ? st.put(value) : st.put(value, key))),
    delete: (s, key) => tx(s, 'readwrite', (st) => st.delete(key)),
    clear: (s) => tx(s, 'readwrite', (st) => st.clear()),
    /** Mehrere Schreibvorgänge atomar: fn(store) */
    batch: (s, fn) => tx(s, 'readwrite', (st) => { fn(st); }),
    close: () => db.close(),
  };
}

function memoryDB(storeNames) {
  const stores = Object.fromEntries(storeNames.map((n) => [n, new Map()]));
  const keyOf = (v) => v.id;
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  return {
    persistent: false,
    get: async (s, key) => clone(stores[s].get(key)),
    getAll: async (s) => [...stores[s].values()].map(clone),
    put: async (s, value, key) => { stores[s].set(key ?? keyOf(value), clone(value)); },
    delete: async (s, key) => { stores[s].delete(key); },
    clear: async (s) => { stores[s].clear(); },
    batch: async (s, fn) => {
      fn({
        put: (v, k) => stores[s].set(k ?? keyOf(v), clone(v)),
        delete: (k) => stores[s].delete(k),
      });
    },
    close: () => {},
  };
}

/**
 * Öffnet (bzw. legt an) eine Datenbank.
 * @param {string} name
 * @param {number} version
 * @param {(db: IDBDatabase, oldVersion: number) => void} upgrade
 * @param {string[]} storeNames  für den Rückfall im Arbeitsspeicher
 */
export async function openDB(name, version, upgrade, storeNames) {
  try {
    if (!globalThis.indexedDB) throw new Error('IndexedDB nicht verfügbar');
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion);
    const db = await request(req);
    return wrap(db);
  } catch (err) {
    console.warn('IndexedDB nicht nutzbar – Zettel werden nur im Arbeitsspeicher gehalten.', err);
    return memoryDB(storeNames);
  }
}

export async function deleteDB(name) {
  if (!globalThis.indexedDB) return;
  await request(indexedDB.deleteDatabase(name)).catch(() => {});
}
