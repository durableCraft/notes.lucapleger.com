// Setup, Anmeldung, Konto, Abmelden und Übernahme lokaler Zettel

import { api } from './api.js';
import { html } from './util.js';
import { hydrateIcons } from './icons.js';
import { confirmDialog, toast } from './ui.js';
import { NoteStore, LOCAL_DB, userDbName } from './store.js';

const USER_KEY = 'notizzettel.user';

// ---------- zuletzt angemeldeter Benutzer (für Offline-Start) ---------------

export function cachedUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)) || null; } catch { return null; }
}

export function rememberUser(user) { setCachedUser(user); }

function setCachedUser(user) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* egal */ }
}

function clearCachedUser() {
  try { localStorage.removeItem(USER_KEY); } catch { /* egal */ }
}

/** Kennung dieses Tabs – eigene Rundrufe werden ignoriert */
export const TAB_ID = Math.random().toString(36).slice(2);

/** Andere Tabs neu laden lassen (Anmeldung/Abmeldung) */
function broadcastReload() {
  try {
    const ch = new BroadcastChannel('notizzettel');
    ch.postMessage({ type: 'reload', from: TAB_ID });
    ch.close();
  } catch { /* egal */ }
}

// ---------- Formulare -------------------------------------------------------

/**
 * Verbindet ein Formular mit einer asynchronen Aktion: Knopf sperren,
 * Fehler im Formular anzeigen, betroffenes Feld markieren.
 */
function bindForm(form, action) {
  const errorEl = form.querySelector('.form-error');
  const submit = form.querySelector('[type="submit"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    errorEl.hidden = true;
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    submit.disabled = true;
    try {
      await action(Object.fromEntries(new FormData(form)), form);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      const field = err.data?.field || err.field;
      const input = field && form.elements[field];
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    } finally {
      submit.disabled = false;
    }
  });
}

function fieldError(field, message) {
  const err = new Error(message);
  err.field = field;
  return err;
}

const passwordHint = 'Mindestens 8 Zeichen. Ein Satz aus mehreren Wörtern ist sicher und gut zu merken.';

// ---------- Ersteinrichtung -------------------------------------------------

export function renderSetup(container, status) {
  if (!status.setupRequired) {
    container.innerHTML = String(html`
      <div class="card narrow">
        <h1 class="card-title">Bereits eingerichtet</h1>
        <p class="card-sub">Notizzettel ist schon eingerichtet. Neue Zugänge vergibt der Admin.</p>
        <div class="card-foot">
          <a class="btn btn-link" href="/" data-link><span data-icon="back"></span>Zum Zettel</a>
          <a class="btn btn-small" href="/login" data-link>Anmelden</a>
        </div>
      </div>`);
    hydrateIcons(container);
    return;
  }
  container.innerHTML = String(html`
    <div class="card narrow">
      <h1 class="card-title">Willkommen!</h1>
      <p class="card-sub">Lege das erste Konto an. Es bekommt Admin-Rechte und kann später weitere Zugänge vergeben.</p>
      <form id="setup-form" novalidate>
        <p class="form-error" role="alert" hidden></p>
        <label class="field">
          <span class="field-label">Setup-Token</span>
          <input class="input input-token" name="token" autocomplete="off" autocapitalize="characters"
                 spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" required>
          <span class="field-hint">Steht in der Konsole bzw. im Journal des Dienstes, z.&nbsp;B. <code>journalctl -u notizzettel</code></span>
        </label>
        <label class="field">
          <span class="field-label">Name</span>
          <input class="input" name="name" autocomplete="name" required>
        </label>
        <label class="field">
          <span class="field-label">E-Mail</span>
          <input class="input" type="email" name="email" autocomplete="username" inputmode="email" required>
        </label>
        <label class="field">
          <span class="field-label">Passwort</span>
          <input class="input" type="password" name="password" autocomplete="new-password" required>
          <span class="field-hint">${passwordHint}</span>
        </label>
        <label class="field">
          <span class="field-label">Passwort wiederholen</span>
          <input class="input" type="password" name="password2" autocomplete="new-password" required>
        </label>
        <button class="btn btn-primary btn-block" type="submit">Konto anlegen</button>
      </form>
    </div>`);
  hydrateIcons(container);
  bindForm(container.querySelector('form'), async (data) => {
    if (data.password !== data.password2) throw fieldError('password2', 'Die Passwörter stimmen nicht überein.');
    const { user } = await api('POST', '/api/setup', {
      token: data.token, name: data.name, email: data.email, password: data.password,
    });
    await afterLogin(user);
  });
}

// ---------- Anmeldung -------------------------------------------------------

export function renderLogin(container, status, { expired = false } = {}) {
  const { features } = status;
  container.innerHTML = String(html`
    <div class="card narrow">
      <h1 class="card-title">Anmelden</h1>
      <p class="card-sub">Mit Konto liegen deine Zettel sicher auf dem Server und sind auf all deinen Geräten da.</p>
      ${expired ? html`<p class="note">Deine Sitzung ist abgelaufen. Bitte melde dich erneut an – Änderungen auf diesem Gerät gehen dabei nicht verloren.</p>` : ''}
      <form id="login-form" novalidate>
        <p class="form-error" role="alert" hidden></p>
        <label class="field">
          <span class="field-label">E-Mail</span>
          <input class="input" type="email" name="email" autocomplete="username webauthn" inputmode="email" required>
        </label>
        <label class="field">
          <span class="field-label">Passwort</span>
          <input class="input" type="password" name="password" autocomplete="current-password" required>
        </label>
        <label class="check">
          <input type="checkbox" name="remember" checked>
          <span>Angemeldet bleiben</span>
        </label>
        <button class="btn btn-primary btn-block" type="submit">Anmelden</button>
      </form>
      ${features.passkeys ? html`
        <div class="sep">oder</div>
        <button class="btn btn-block" type="button" id="btn-passkey"><span data-icon="key"></span>Mit Passkey anmelden</button>` : ''}
      <div class="card-foot">
        <a class="btn btn-link" href="/" data-link><span data-icon="back"></span>Ohne Anmeldung weiter</a>
        <button class="btn btn-link" type="button" id="btn-forgot">Passwort vergessen?</button>
      </div>
    </div>`);
  hydrateIcons(container);
  bindForm(container.querySelector('form'), async (data) => {
    const { user } = await api('POST', '/api/login', {
      email: data.email, password: data.password, remember: data.remember === 'on',
    });
    await afterLogin(user);
  });
  container.querySelector('#btn-forgot').addEventListener('click', () => {
    if (features.passwordReset) return; // folgt mit SMTP
    confirmDialog({
      title: 'Passwort vergessen?',
      text: 'Bitte wende dich an den Admin dieser Notizzettel-Instanz. Dort lässt sich dein Passwort zurücksetzen.',
      ok: 'Verstanden',
      cancel: 'Schließen',
    });
  });
}

// ---------- Mein Konto ------------------------------------------------------

export function renderAccount(container, user, { onLogout }) {
  container.innerHTML = String(html`
    <div class="card">
      <h1 class="card-title">Mein Konto</h1>
      <p class="card-sub">${user.email} · ${user.role === 'admin' ? 'Admin' : 'Benutzer'}</p>

      <section class="card-section">
        <h2 class="section-title">Name</h2>
        <form id="name-form" novalidate>
          <p class="form-error" role="alert" hidden></p>
          <div class="inline-form">
            <input class="input" name="name" autocomplete="name" value="${user.name}" aria-label="Name" required>
            <button class="btn" type="submit">Speichern</button>
          </div>
        </form>
      </section>

      <section class="card-section">
        <h2 class="section-title">Passwort ändern</h2>
        <form id="password-form" novalidate>
          <p class="form-error" role="alert" hidden></p>
          <input type="email" name="username" autocomplete="username" value="${user.email}" hidden>
          <label class="field">
            <span class="field-label">Aktuelles Passwort</span>
            <input class="input" type="password" name="current" autocomplete="current-password" required>
          </label>
          <label class="field">
            <span class="field-label">Neues Passwort</span>
            <input class="input" type="password" name="password" autocomplete="new-password" required>
            <span class="field-hint">${passwordHint}</span>
          </label>
          <label class="field">
            <span class="field-label">Neues Passwort wiederholen</span>
            <input class="input" type="password" name="password2" autocomplete="new-password" required>
          </label>
          <button class="btn" type="submit">Passwort ändern</button>
          <p class="field-hint">Deine anderen Geräte werden dabei abgemeldet.</p>
        </form>
      </section>

      <div class="card-foot">
        <a class="btn btn-link" href="/" data-link><span data-icon="back"></span>Zurück zum Zettel</a>
        <button class="btn btn-small btn-danger" type="button" id="btn-logout"><span data-icon="logout"></span>Abmelden</button>
      </div>
    </div>`);
  hydrateIcons(container);

  bindForm(container.querySelector('#name-form'), async (data) => {
    const r = await api('PUT', '/api/account', { name: data.name });
    setCachedUser(r.user);
    Object.assign(user, r.user);
    document.dispatchEvent(new CustomEvent('notizzettel:user', { detail: r.user }));
    toast('Name gespeichert.');
  });
  bindForm(container.querySelector('#password-form'), async (data, form) => {
    if (data.password !== data.password2) throw fieldError('password2', 'Die neuen Passwörter stimmen nicht überein.');
    await api('PUT', '/api/account/password', { current: data.current, password: data.password });
    form.reset();
    toast('Passwort geändert.');
  });
  container.querySelector('#btn-logout').addEventListener('click', onLogout);
}

// ---------- nach der Anmeldung ----------------------------------------------

/** Lokale Zettel übernehmen bzw. verwerfen, dann App im Konto-Modus neu starten. */
export async function afterLogin(user) {
  const previous = cachedUser();
  setCachedUser(user);

  // Zwischenspeicher eines anderen Kontos aufräumen (nur ohne offene Änderungen)
  if (previous && previous.id !== user.id) {
    const old = await new NoteStore(userDbName(previous.id), { synced: true }).open();
    if ((await old.dirty()).length === 0) await old.destroy(); else old.db.close();
  }

  await transferLocalNotes(user);
  broadcastReload();
  location.assign('/');
}

async function transferLocalNotes(user) {
  const local = await new NoteStore(LOCAL_DB).open();
  const notes = (await local.all()).filter((n) => !n.purged);
  if (!notes.length) {
    local.db.close();
    return;
  }
  const active = notes.filter((n) => !n.deletedAt).length;
  let take = true;
  if (active > 0) {
    const label = active === 1 ? '1 Notiz' : `${active} Notizen`;
    for (;;) {
      take = await confirmDialog({
        title: 'Zettel übernehmen?',
        text: `${label} auf diesem Gerät – ins Konto übernehmen?`,
        ok: 'Übernehmen',
        cancel: 'Nein',
      });
      if (take) break;
      const discard = await confirmDialog({
        title: 'Lokale Zettel verwerfen?',
        text: `Wenn du sie nicht übernimmst, werden ${active === 1 ? 'die Notiz' : `die ${active} Notizen`} auf diesem Gerät endgültig gelöscht. Das lässt sich nicht rückgängig machen.`,
        ok: 'Endgültig verwerfen',
        cancel: 'Zurück',
        danger: true,
      });
      if (discard) break;
    }
  }
  if (take) {
    // auch der Papierkorb wird mitgenommen
    const target = await new NoteStore(userDbName(user.id), { synced: true }).open();
    await target.importNotes(notes);
    target.db.close();
  }
  await local.destroy();
}

// ---------- Abmelden --------------------------------------------------------

export async function logout({ store, sync }) {
  if (sync) {
    await sync.run();
    if (sync.state === 'offline') {
      toast('Zum Abmelden brauchst du eine Verbindung zum Server.');
      return;
    }
  }
  const pending = store ? (await store.dirty()).length : 0;
  if (pending) {
    const ok = await confirmDialog({
      title: 'Nicht abgeglichene Änderungen',
      text: `${pending === 1 ? '1 Änderung ist' : `${pending} Änderungen sind`} noch nicht auf dem Server und ${pending === 1 ? 'geht' : 'gehen'} beim Abmelden verloren.`,
      ok: 'Trotzdem abmelden',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await api('POST', '/api/logout');
  } catch (err) {
    if (err.status === 0) {
      toast('Zum Abmelden brauchst du eine Verbindung zum Server.');
      return;
    }
  }
  sync?.stop();
  // Zwischenspeicher dieses Kontos vom Gerät entfernen
  await store?.destroy();
  clearCachedUser();
  broadcastReload();
  location.assign('/');
}
