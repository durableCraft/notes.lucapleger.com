// Einfaches Rate-Limit im Arbeitsspeicher (gleitendes Zeitfenster).
// Gezählt werden in der Regel Fehlversuche; ein Erfolg setzt den Zähler zurück.

export class RateLimiter {
  /** @param {{ windowMs: number, max: number }} opts */
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    const t = setInterval(() => this.cleanup(), Math.min(windowMs, 60_000));
    t.unref();
  }

  recent(key, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter((ts) => ts > now - this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }

  /** @returns {{ ok: boolean, retryAfter: number }} retryAfter in Sekunden */
  check(key, now = Date.now()) {
    const list = this.recent(key, now);
    if (list.length < this.max) return { ok: true, retryAfter: 0 };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000)) };
  }

  hit(key, now = Date.now()) {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  reset(key) { this.hits.delete(key); }

  cleanup() {
    const now = Date.now();
    for (const key of this.hits.keys()) this.recent(key, now);
  }
}

const MIN = 60_000;

export const limits = {
  loginIp: new RateLimiter({ windowMs: 15 * MIN, max: 30 }),
  loginAccount: new RateLimiter({ windowMs: 15 * MIN, max: 8 }),
  setupIp: new RateLimiter({ windowMs: 15 * MIN, max: 10 }),
  passwordUser: new RateLimiter({ windowMs: 15 * MIN, max: 10 }),
};
