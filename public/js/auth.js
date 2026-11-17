// Setup, Anmeldung, Konto, Abmelden und Übernahme lokaler Zettel

import { api } from './api.js';
import { html } from './util.js';
import { hydrateIcons } from './icons.js';
import { confirmDialog, toast, bindForm, fieldError, formDialog } from './ui.js';
import {
  passkeysSupported, conditionalSupported, loginWithPasskey, registerPasskey,
  passkeyErrorMessage, suggestPasskeyName,
} from './webauthn.js';
import { NoteStore, LOCAL_DB, LEGACY_PREFIX } from './store.js';

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

export const passwordHint = 'Mindestens 8 Zeichen. Ein Satz aus mehreren Wörtern ist sicher und gut zu merken.';

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
      ${features.passkeys && passkeysSupported() ? html`
        <div class="sep">oder</div>
        <button class="btn btn-block" type="button" id="btn-passkey"><span data-icon="key"></span>Mit Passkey anmelden</button>` : ''}
      <div class="card-foot">
        <a class="btn btn-link" href="/" data-link><span data-icon="back"></span>Ohne Anmeldung weiter</a>
        <button class="btn btn-link" type="button" id="btn-forgot">Passwort vergessen?</button>
      </div>
    </div>`);
  hydrateIcons(container);
  const form = container.querySelector('form');
  const errorEl = form.querySelector('.form-error');
  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  };

  // Passkey: im Autofill des E-Mail-Felds anbieten (falls der Browser das kann)
  stopConditionalLogin();
  if (features.passkeys) {
    conditionalSupported().then((ok) => {
      if (!ok || !container.isConnected) return;
      conditionalCtl = new AbortController();
      loginWithPasskey({ conditional: true, signal: conditionalCtl.signal, remember: form.elements.remember.checked })
        .then(({ user }) => afterLogin(user))
        .catch((err) => {
          const msg = passkeyErrorMessage(err);
          if (msg && err.name !== 'AbortError') showError(msg);
        });
    });
  }
  container.querySelector('#btn-passkey')?.addEventListener('click', async (e) => {
    stopConditionalLogin();
    const btn = e.currentTarget;
    btn.disabled = true;
    errorEl.hidden = true;
    try {
      const { user } = await loginWithPasskey({ remember: form.elements.remember.checked });
      await afterLogin(user);
    } catch (err) {
      const msg = passkeyErrorMessage(err);
      if (msg) showError(msg);
    } finally {
      btn.disabled = false;
    }
  });

  bindForm(form, async (data) => {
    stopConditionalLogin();
    const r = await api('POST', '/api/login', {
      email: data.email, password: data.password, remember: data.remember === 'on',
    });
    if (r.twoFactor) {
      renderCodeStep(container, r, () => renderLogin(container, status, { expired }));
      return;
    }
    await afterLogin(r.user);
  });
  container.querySelector('#btn-forgot').addEventListener('click', () => {
    if (!features.passwordReset) {
      confirmDialog({
        title: 'Passwort vergessen?',
        text: 'Bitte wende dich an den Admin dieser Notizzettel-Instanz. Dort lässt sich dein Passwort zurücksetzen.',
        ok: '',
        cancel: 'Schließen',
      });
      return;
    }
    forgotDialog(form.elements.email.value);
  });
}

let conditionalCtl = null;
/** Laufende Passkey-Abfrage im Autofill beenden (z. B. beim Verlassen der Seite) */
export function stopConditionalLogin() {
  conditionalCtl?.abort();
  conditionalCtl = null;
}

/** Zweiter Schritt: Code aus der E-Mail */
function renderCodeStep(container, challenge, onBack) {
  container.innerHTML = String(html`
    <div class="card narrow">
      <h1 class="card-title">Code eingeben</h1>
      <p class="card-sub">Wir haben dir einen Code an <strong>${challenge.email}</strong> geschickt. Er ist ${challenge.minutes} Minuten gültig.</p>
      <form id="code-form" novalidate>
        <p class="form-error" role="alert" hidden></p>
        <label class="field">
          <span class="field-label">6-stelliger Code</span>
          <input class="input input-code" name="code" inputmode="numeric" autocomplete="one-time-code"
                 pattern="[0-9 ]*" maxlength="7" placeholder="000000" required>
        </label>
        <button class="btn btn-primary btn-block" type="submit">Anmelden</button>
      </form>
      <div class="card-foot">
        <button class="btn btn-link" type="button" id="btn-code-back"><span data-icon="back"></span>Zurück</button>
        <button class="btn btn-link" type="button" id="btn-code-resend">Code erneut senden</button>
      </div>
    </div>`);
  hydrateIcons(container);
  const form = container.querySelector('form');
  const input = form.elements.code;
  input.focus();
  bindForm(form, async (data) => {
    try {
      const { user } = await api('POST', '/api/login/code', { challenge: challenge.challenge, code: data.code });
      await afterLogin(user);
    } catch (err) {
      if (err.data?.expired) {
        onBack();
        toast(err.message);
        return;
      }
      input.select();
      throw err;
    }
  });
  // vollständiger Code → direkt absenden
  input.addEventListener('input', () => {
    if (input.value.replace(/\D/g, '').length === 6) form.requestSubmit();
  });
  container.querySelector('#btn-code-back').addEventListener('click', onBack);
  container.querySelector('#btn-code-resend').addEventListener('click', async () => {
    try {
      await api('POST', '/api/login/code/resend', { challenge: challenge.challenge });
      toast('Neuer Code ist unterwegs.');
    } catch (err) {
      if (err.data?.expired) onBack();
      toast(err.message);
    }
  });
}

function forgotDialog(prefill = '') {
  formDialog({
    title: 'Passwort vergessen?',
    sub: 'Gib deine E-Mail-Adresse ein. Du bekommst einen Link, mit dem du ein neues Passwort vergibst.',
    body: html`
      <label class="field">
        <span class="field-label">E-Mail</span>
        <input class="input" type="email" name="email" autocomplete="username" inputmode="email" value="${prefill}" required>
      </label>`,
    submit: 'Link senden',
    onSubmit: async (data) => {
      await api('POST', '/api/password/forgot', { email: data.email });
      return true;
    },
  }).then((sent) => {
    if (sent) toast('Falls es ein Konto mit dieser Adresse gibt, bekommst du gleich eine E-Mail.', { duration: 7000 });
  });
}

// ---------- Einladung annehmen ----------------------------------------------

const linkInvalid = (container, title, text) => {
  container.innerHTML = String(html`
    <div class="card narrow">
      <h1 class="card-title">${title}</h1>
      <p class="card-sub">${text}</p>
      <div class="card-foot">
        <a class="btn btn-link" href="/" data-link><span data-icon="back"></span>Zum Zettel</a>
        <a class="btn btn-small" href="/login" data-link>Anmelden</a>
      </div>
    </div>`);
  hydrateIcons(container);
};

export async function renderInvite(container, token) {
  let inv;
  try {
    inv = await api('GET', `/api/invites/${encodeURIComponent(token)}`);
  } catch (err) {
    linkInvalid(container, 'Einladung ungültig', err.status === 404
      ? 'Dieser Einladungslink ist abgelaufen, wurde widerrufen oder schon verwendet. Bitte frag nach einer neuen Einladung.'
      : err.message);
    return;
  }
  container.innerHTML = String(html`
    <div class="card narrow">
      <h1 class="card-title">Willkommen!</h1>
      <p class="card-sub">Du wurdest zu Notizzettel eingeladen. Lege jetzt dein Konto für <strong>${inv.email}</strong> an.</p>
      <form id="invite-form" novalidate>
        <p class="form-error" role="alert" hidden></p>
        <input type="email" name="username" autocomplete="username" value="${inv.email}" hidden>
        <label class="field">
          <span class="field-label">Name</span>
          <input class="input" name="name" autocomplete="name" value="${inv.name}" required>
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
        <label class="check">
          <input type="checkbox" name="remember" checked>
          <span>Angemeldet bleiben</span>
        </label>
        <button class="btn btn-primary btn-block" type="submit">Konto anlegen</button>
      </form>
    </div>`);
  hydrateIcons(container);
  bindForm(container.querySelector('form'), async (data) => {
    if (data.password !== data.password2) throw fieldError('password2', 'Die Passwörter stimmen nicht überein.');
    const { user } = await api('POST', `/api/invites/${encodeURIComponent(token)}`, {
      name: data.name, password: data.password, remember: data.remember === 'on',
    });
    await afterLogin(user);
  });
}

// ---------- Neues Passwort über Link ----------------------------------------

export async function renderReset(container, token) {
  let info;
  try {
    info = await api('GET', `/api/password/reset/${encodeURIComponent(token)}`);
  } catch (err) {
    linkInvalid(container, 'Link ungültig', err.status === 404
      ? 'Dieser Link ist abgelaufen oder wurde schon verwendet. Fordere bei Bedarf einen neuen an.'
      : err.message);
    return;
  }
  container.innerHTML = String(html`
    <div class="card narrow">
      <h1 class="card-title">Neues Passwort</h1>
      <p class="card-sub">Vergib ein neues Passwort für <strong>${info.email}</strong>. Danach meldest du dich überall neu an.</p>
      <form id="reset-form" novalidate>
        <p class="form-error" role="alert" hidden></p>
        <input type="email" name="username" autocomplete="username" value="${info.email}" hidden>
        <label class="field">
          <span class="field-label">Neues Passwort</span>
          <input class="input" type="password" name="password" autocomplete="new-password" required>
          <span class="field-hint">${passwordHint}</span>
        </label>
        <label class="field">
          <span class="field-label">Neues Passwort wiederholen</span>
          <input class="input" type="password" name="password2" autocomplete="new-password" required>
        </label>
        <button class="btn btn-primary btn-block" type="submit">Passwort speichern</button>
      </form>
    </div>`);
  hydrateIcons(container);
  bindForm(container.querySelector('form'), async (data) => {
    if (data.password !== data.password2) throw fieldError('password2', 'Die Passwörter stimmen nicht überein.');
    await api('POST', `/api/password/reset/${encodeURIComponent(token)}`, { password: data.password });
    broadcastReload();
    container.innerHTML = String(html`
      <div class="card narrow">
        <h1 class="card-title">Passwort gespeichert</h1>
        <p class="card-sub">Dein neues Passwort gilt ab sofort. Alle Geräte wurden abgemeldet.</p>
        <a class="btn btn-primary btn-block" href="/login">Jetzt anmelden</a>
      </div>`);
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
        <h2 class="section-title">Passkeys</h2>
        <p class="section-intro">Mit einem Passkey meldest du dich ohne Passwort an – per Fingerabdruck,
          Gesicht oder Geräte-PIN. Ein Code per E-Mail ist dann nicht nötig.</p>
        <div id="passkey-list"><p class="loading">Lädt …</p></div>
        ${passkeysSupported() ? html`
          <button class="btn btn-small" type="button" id="btn-add-passkey"><span data-icon="key"></span>Passkey hinzufügen</button>`
    : html`<p class="note">Dieser Browser kann hier keine Passkeys anlegen. Passkeys brauchen eine sichere Verbindung (HTTPS).</p>`}
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
  setupPasskeys(container);
}

// ---------- nach der Anmeldung ----------------------------------------------

/** App im Konto-Modus neu starten. Lokale Zettel werden danach angeboten. */
export async function afterLogin(user) {
  setCachedUser(user);
  broadcastReload();
  location.assign('/');
}

/**
 * Im Konto-Modus: Zettel, die ohne Anmeldung auf diesem Gerät liegen, anbieten.
 * Übernommene Zettel werden direkt auf den Server geladen. Der lokale Speicher
 * wird erst gelöscht, wenn das geklappt hat (sonst beim nächsten Start erneut).
 * @returns {Promise<number>} Anzahl übernommener Zettel
 */
export async function offerLocalNotes() {
  // Nur öffnen, wenn es die lokale Datenbank gibt – Öffnen würde sie sonst anlegen
  try {
    const dbs = await indexedDB.databases?.();
    if (dbs && !dbs.some((d) => d.name === LOCAL_DB)) return 0;
  } catch { /* databases() nicht unterstützt: normal weiter */ }
  const local = await new NoteStore(LOCAL_DB).open();
  const notes = (await local.all()).filter((n) => !n.purged);
  if (!notes.length) {
    await local.destroy();   // leere Datenbank nicht auf dem Gerät lassen
    return 0;
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
    try {
      for (const n of notes) {
        try {
          await api('PUT', `/api/notes/${n.id}`, {
            html: n.html, createdAt: n.createdAt, updatedAt: n.updatedAt, deletedAt: n.deletedAt,
          });
        } catch (err) {
          if (err.status !== 400 && err.status !== 413) throw err;
          console.warn(`Zettel ${n.id} wurde vom Server abgelehnt: ${err.message}`);
        }
      }
    } catch (err) {
      local.db.close();
      throw err;
    }
  }
  await local.destroy();
  return take ? notes.length : 0;
}

/**
 * Sitzung abgelaufen, aber noch nicht gespeicherte Änderungen im Arbeitsspeicher:
 * Diese werden ohne Konto auf dem Gerät abgelegt und nach der nächsten
 * Anmeldung zur Übernahme angeboten.
 */
export async function rescueToLocal(notes) {
  const keep = notes.filter((n) => !n.purged);
  if (!keep.length) return 0;
  const local = await new NoteStore(LOCAL_DB).open();
  await local.importNotes(keep);
  local.db.close();
  return keep.length;
}

/** Zwischenspeicher früherer Versionen (Zettel des Kontos auf dem Gerät) entfernen */
export async function removeLegacyCaches() {
  try {
    const dbs = await indexedDB.databases?.();
    for (const d of dbs || []) {
      if (d.name?.startsWith(LEGACY_PREFIX)) indexedDB.deleteDatabase(d.name);
    }
  } catch { /* nicht unterstützt */ }
}

// ---------- Abmelden --------------------------------------------------------

export async function logout({ store, sync }) {
  if (sync) await sync.run();
  const pending = store ? (await store.dirty()).length : 0;
  if (pending) {
    const ok = await confirmDialog({
      title: 'Nicht gespeicherte Änderungen',
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
  store?.clearDirty?.();
  clearCachedUser();
  broadcastReload();
  location.assign('/');
}

// ---------- Passkeys verwalten (Mein Konto) ---------------------------------

const fmtDate = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

async function setupPasskeys(container) {
  const list = container.querySelector('#passkey-list');
  const load = async () => {
    let passkeys;
    try {
      ({ passkeys } = await api('GET', '/api/passkeys'));
    } catch (err) {
      list.innerHTML = String(html`<p class="form-error">${err.message}</p>`);
      return;
    }
    list.innerHTML = String(passkeys.length ? html`
      <ul class="row-list passkey-list">
        ${passkeys.map((p) => html`
          <li class="row is-static">
            <span class="avatar" aria-hidden="true"><span data-icon="key"></span></span>
            <span class="row-main">
              <span class="row-title">${p.name}</span>
              <span class="row-sub">hinzugefügt ${fmtDate.format(p.createdAt)}${p.lastUsedAt ? ` · zuletzt genutzt ${fmtDate.format(p.lastUsedAt)}` : ''}</span>
            </span>
            ${p.synced ? html`<span class="row-badges"><span class="badge" title="Wird über deine Geräte synchronisiert (z. B. iCloud-Schlüsselbund)">synchronisiert</span></span>` : ''}
            <span class="row-actions">
              <button class="btn btn-small btn-icon" type="button" data-rename="${p.id}" data-name="${p.name}" aria-label="${p.name} umbenennen" title="Umbenennen"><span data-icon="pencil"></span></button>
              <button class="btn btn-small btn-icon" type="button" data-remove="${p.id}" data-name="${p.name}" aria-label="${p.name} entfernen" title="Entfernen"><span data-icon="trash"></span></button>
            </span>
          </li>`)}
      </ul>` : html`<p class="trash-empty">Noch kein Passkey eingerichtet.</p>`);
    hydrateIcons(list);
  };
  await load();

  list.addEventListener('click', async (e) => {
    const ren = e.target.closest('[data-rename]');
    const rem = e.target.closest('[data-remove]');
    if (ren) {
      const ok = await formDialog({
        title: 'Passkey umbenennen',
        body: html`<label class="field"><span class="field-label">Name</span>
          <input class="input" name="name" value="${ren.dataset.name}" maxlength="60" required></label>`,
        submit: 'Speichern',
        onSubmit: (d) => api('PATCH', `/api/passkeys/${encodeURIComponent(ren.dataset.rename)}`, { name: d.name }),
      });
      if (ok) load();
    } else if (rem) {
      const ok = await confirmDialog({
        title: 'Passkey entfernen?',
        text: `Mit „${rem.dataset.name}“ kannst du dich danach nicht mehr anmelden. Lösche ihn zusätzlich in der Passwort-App deines Geräts, damit er dort nicht mehr angeboten wird.`,
        ok: 'Entfernen',
        danger: true,
      });
      if (!ok) return;
      try {
        await api('DELETE', `/api/passkeys/${encodeURIComponent(rem.dataset.remove)}`);
        toast('Passkey entfernt.');
        load();
      } catch (err) { toast(err.message); }
    }
  });

  container.querySelector('#btn-add-passkey')?.addEventListener('click', async () => {
    const added = await formDialog({
      title: 'Passkey hinzufügen',
      sub: 'Gib dem Passkey einen Namen, an dem du das Gerät erkennst. Danach fragt dein Gerät nach Fingerabdruck, Gesicht oder PIN.',
      body: html`<label class="field"><span class="field-label">Name</span>
        <input class="input" name="name" value="${suggestPasskeyName()}" maxlength="60" required></label>`,
      submit: 'Weiter',
      onSubmit: async (d) => {
        try {
          await registerPasskey(d.name);
          return true;
        } catch (err) {
          const msg = passkeyErrorMessage(err);
          if (msg === null) return false;   // abgebrochen
          throw new Error(msg);
        }
      },
    });
    if (added) {
      toast('Passkey gespeichert. Du kannst dich jetzt damit anmelden.');
      load();
    }
  });
}
