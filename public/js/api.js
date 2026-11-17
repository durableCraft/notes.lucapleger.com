// Zugriff auf die Server-API

export class ApiError extends Error {
  /**
   * @param {number} status  0 = keine Verbindung
   * @param {string} message
   * @param {object|null} data
   */
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }

  get offline() { return this.status === 0; }
}

export async function api(method, path, body, { timeout = 15000 } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Notizzettel': '1',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new ApiError(0, 'Keine Verbindung zum Server. Bist du online?');
  }
  let data = null;
  try { data = await res.json(); } catch { /* kein JSON */ }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || `Unerwarteter Fehler (${res.status}).`, data);
  }
  return data;
}
