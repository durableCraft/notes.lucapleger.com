// Verwaltung (nur für Admins): Benutzer, Einladungen, E-Mail (SMTP), Sicherheit.
// Notizen anderer Benutzer sind hier bewusst nicht sichtbar.

import { api } from './api.js';
import { html, dateOnly } from './util.js';
import { hydrateIcons } from './icons.js';
import { toast, confirmDialog, formDialog, bindForm, linkBox } from './ui.js';
import { passwordHint } from './auth.js';

const TABS = [['users', 'Benutzer'], ['mail', 'E-Mail'], ['security', 'Sicherheit']];
let currentTab = 'users';

const fmtDateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

/** Gut lesbares Startpasswort, z. B. "kafu-mive-tolo-rabe" */
function suggestPassword() {
  const c = 'bdfghklmnprstvz';
  const v = 'aeiou';
  const r = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const syl = () => c[r(c.length)] + v[r(v.length)];
  return Array.from({ length: 4 }, () => syl() + syl()).join('-');
}

const roleSelect = (role = 'user') => html`
  <label class="field">
    <span class="field-label">Rolle</span>
    <select class="input" name="role">
      <option value="user" ${role === 'user' ? 'selected' : ''}>Benutzer</option>
      <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin – darf verwalten</option>
    </select>
  </label>`;

export async function renderAdmin(container, me) {
  container.innerHTML = String(html`
    <div class="card card-wide">
      <h1 class="card-title">Verwaltung</h1>
      <p class="card-sub">Zugänge, E-Mail-Versand und Sicherheit. Die Zettel der Benutzer sind hier nicht einsehbar.</p>
      <div class="tabs-wrap">
        <div class="segmented glass tabs" role="tablist" aria-label="Bereiche">
          ${TABS.map(([key, label]) => html`<button type="button" class="tab" role="tab" data-tab="${key}"
            aria-selected="${key === currentTab ? 'true' : 'false'}">${label}</button>`)}
        </div>
      </div>
      <div class="tab-panel" id="admin-panel" role="tabpanel"></div>
    </div>`);
  hydrateIcons(container);
  const panel = container.querySelector('#admin-panel');
  const tabs = container.querySelector('.tabs');

  async function show(tab) {
    currentTab = tab;
    tabs.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    panel.innerHTML = '<p class="loading">Lädt …</p>';
    try {
      if (tab === 'users') await renderUsers(panel, me, () => show('users'));
      else if (tab === 'mail') await renderMail(panel, me, () => show('mail'));
      else await renderSecurity(panel, () => show('security'), show);
    } catch (err) {
      panel.innerHTML = String(html`<p class="form-error">${err.message}</p>`);
    }
  }
  tabs.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) show(t.dataset.tab);
  });
  await show(currentTab);
}

// ---------- Benutzer ------------------------------------------------------------

async function renderUsers(panel, me, refresh) {
  const data = await api('GET', '/api/admin/users');
  const { users, invites, smtpConfigured } = data;
  panel.innerHTML = String(html`
    <div class="toolbar-row">
      <button class="btn btn-small btn-primary" type="button" data-act="invite"><span data-icon="mail"></span>Einladen</button>
      <button class="btn btn-small" type="button" data-act="create"><span data-icon="userPlus"></span>Benutzer anlegen</button>
    </div>
    ${smtpConfigured ? '' : html`<p class="note">SMTP ist noch nicht eingerichtet. Einladungen bekommst du dann als Link zum Weitergeben.</p>`}
    <ul class="row-list" aria-label="Benutzer">
      ${users.map((u) => html`
        <li>
          <button class="row" type="button" data-user="${u.id}">
            <span class="avatar ${u.disabled ? 'is-off' : ''}" aria-hidden="true">${(u.name || u.email).trim().charAt(0).toUpperCase()}</span>
            <span class="row-main">
              <span class="row-title">${u.name}${u.id === me.id ? ' (du)' : ''}</span>
              <span class="row-sub">${u.email}</span>
            </span>
            <span class="row-badges">
              ${u.role === 'admin' ? html`<span class="badge">Admin</span>` : ''}
              ${u.disabled ? html`<span class="badge badge-off">Deaktiviert</span>` : ''}
            </span>
            <span class="row-meta">${u.lastLoginAt ? `zuletzt ${dateOnly(u.lastLoginAt)}` : 'noch nie angemeldet'}</span>
            <span class="row-chevron" data-icon="chevronRight"></span>
          </button>
        </li>`)}
    </ul>
    ${invites.length ? html`
      <h2 class="section-title section-gap">Offene Einladungen</h2>
      <ul class="row-list" aria-label="Offene Einladungen">
        ${invites.map((i) => html`
          <li class="row is-static">
            <span class="avatar avatar-invite" aria-hidden="true"><span data-icon="mail"></span></span>
            <span class="row-main">
              <span class="row-title">${i.name || i.email}</span>
              <span class="row-sub">${i.name ? `${i.email} · ` : ''}${i.expired ? 'abgelaufen' : `gültig bis ${dateOnly(i.expiresAt)}`}</span>
            </span>
            <span class="row-badges">
              ${i.role === 'admin' ? html`<span class="badge">Admin</span>` : ''}
              ${i.expired ? html`<span class="badge badge-off">Abgelaufen</span>` : ''}
            </span>
            <span class="row-actions">
              <button class="btn btn-small" type="button" data-resend="${i.id}" data-email="${i.email}">${smtpConfigured ? 'Erneut senden' : 'Neuer Link'}</button>
              <button class="btn btn-small btn-icon" type="button" data-revoke="${i.id}" data-email="${i.email}" aria-label="Einladung an ${i.email} widerrufen" title="Widerrufen"><span data-icon="trash"></span></button>
            </span>
          </li>`)}
      </ul>` : ''}`);
  hydrateIcons(panel);

  panel.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-act="invite"]')) {
      if (await inviteDialog(smtpConfigured)) refresh();
    } else if (t.closest('[data-act="create"]')) {
      if (await createDialog()) refresh();
    } else if (t.closest('[data-user]')) {
      const u = users.find((x) => x.id === Number(t.closest('[data-user]').dataset.user));
      if (await userDialog(u, me, smtpConfigured)) refresh();
    } else if (t.closest('[data-resend]')) {
      const b = t.closest('[data-resend]');
      try {
        const r = await api('POST', `/api/admin/invites/${b.dataset.resend}/resend`);
        await showLink(r, b.dataset.email, 'Einladung');
        refresh();
      } catch (err) { toast(err.message); }
    } else if (t.closest('[data-revoke]')) {
      const b = t.closest('[data-revoke]');
      const ok = await confirmDialog({
        title: 'Einladung widerrufen?',
        text: `Der Link für ${b.dataset.email} funktioniert danach nicht mehr.`,
        ok: 'Widerrufen',
        danger: true,
      });
      if (!ok) return;
      try {
        await api('DELETE', `/api/admin/invites/${b.dataset.revoke}`);
        toast('Einladung widerrufen.');
        refresh();
      } catch (err) { toast(err.message); }
    }
  };
}

/** Zeigt einen Link (Einladung/Reset) mit Hinweis zum Mailversand */
function showLink(r, email, what) {
  let sub;
  if (r.mailed) sub = `Die E-Mail an ${email} ist unterwegs. Du kannst den Link zusätzlich selbst weitergeben:`;
  else if (r.mailError) sub = `Die E-Mail an ${email} konnte nicht verschickt werden (${r.mailError}). Gib den Link selbst weiter:`;
  else sub = `Gib diesen Link an ${email} weiter:`;
  const validity = r.days ? `Gültig für ${r.days} Tage, nur einmal verwendbar.` : `Gültig für ${r.minutes} Minuten, nur einmal verwendbar.`;
  return formDialog({
    title: r.mailed ? `${what} verschickt` : `${what}slink`,
    sub,
    body: html`${linkBox(r.link)}<p class="field-hint">${validity}</p>`,
    cancel: 'Fertig',
  });
}

async function inviteDialog(smtpConfigured) {
  let email = '';
  const r = await formDialog({
    title: 'Einladen',
    sub: smtpConfigured
      ? 'Die Einladung geht per E-Mail raus. Der Link ist 7 Tage gültig und nur einmal verwendbar.'
      : 'SMTP ist nicht eingerichtet: Du bekommst den Link zum Weitergeben. Er ist 7 Tage gültig und nur einmal verwendbar.',
    body: html`
      <label class="field">
        <span class="field-label">E-Mail</span>
        <input class="input" type="email" name="email" inputmode="email" autocomplete="off" required>
      </label>
      <label class="field">
        <span class="field-label">Name <span class="optional">(optional)</span></span>
        <input class="input" name="name" autocomplete="off">
      </label>
      ${roleSelect('user')}`,
    submit: 'Einladung erstellen',
    onSubmit: async (data) => {
      email = data.email.trim();
      return api('POST', '/api/admin/invites', { email, name: data.name, role: data.role });
    },
  });
  if (!r) return false;
  await showLink(r, email, 'Einladung');
  return true;
}

async function createDialog() {
  const r = await formDialog({
    title: 'Benutzer anlegen',
    sub: 'Lege ein Konto mit Startpasswort an. Teile es der Person mit – sie kann es unter „Mein Konto“ ändern.',
    body: html`
      <label class="field">
        <span class="field-label">Name</span>
        <input class="input" name="name" autocomplete="off" required>
      </label>
      <label class="field">
        <span class="field-label">E-Mail</span>
        <input class="input" type="email" name="email" inputmode="email" autocomplete="off" required>
      </label>
      <label class="field">
        <span class="field-label">Startpasswort</span>
        <input class="input" type="text" name="password" autocomplete="off" spellcheck="false" value="${suggestPassword()}" required>
        <span class="field-hint">${passwordHint}</span>
      </label>
      ${roleSelect('user')}`,
    submit: 'Anlegen',
    onSubmit: (data) => api('POST', '/api/admin/users', data),
  });
  if (r) toast(`${r.user.name} wurde angelegt.`);
  return !!r;
}

async function userDialog(u, me, smtpConfigured) {
  const self = u.id === me.id;
  const meta = [
    u.role === 'admin' ? 'Admin' : 'Benutzer',
    u.disabled ? 'deaktiviert' : null,
    u.lastLoginAt ? `zuletzt angemeldet ${fmtDateTime.format(u.lastLoginAt)}` : 'noch nie angemeldet',
    `${u.sessions} aktive ${u.sessions === 1 ? 'Sitzung' : 'Sitzungen'}`,
  ].filter(Boolean).join(' · ');

  const r = await formDialog({
    title: self ? `${u.name} (du)` : u.name,
    sub: `${u.email}\n${meta}`,
    body: html`
      ${roleSelect(u.role)}
      <div class="action-list">
        <button class="btn btn-small" type="button" data-action="password"><span data-icon="key"></span>Passwort zurücksetzen</button>
        <button class="btn btn-small" type="button" data-action="logout"><span data-icon="logout"></span>Überall abmelden</button>
        ${self ? '' : html`
          <button class="btn btn-small" type="button" data-action="toggle"><span data-icon="${u.disabled ? 'check' : 'close'}"></span>${u.disabled ? 'Aktivieren' : 'Deaktivieren'}</button>
          <button class="btn btn-small btn-danger" type="button" data-action="delete"><span data-icon="trash"></span>Konto löschen</button>`}
      </div>`,
    submit: 'Speichern',
    cancel: 'Schließen',
    wide: true,
    onSubmit: async (data) => {
      if (data.role !== u.role) {
        await api('PATCH', `/api/admin/users/${u.id}`, { role: data.role });
        toast(`Rolle von ${u.name} geändert.`);
        if (self && data.role !== 'admin') setTimeout(() => location.assign('/'), 800);
      }
      return { saved: true };
    },
  });
  if (!r) return false;
  if (r.saved) return true;

  try {
    switch (r.action) {
      case 'password': return await passwordDialog(u, smtpConfigured);
      case 'logout':
        await api('POST', `/api/admin/users/${u.id}/logout`);
        toast(self ? 'Deine anderen Geräte wurden abgemeldet.' : `${u.name} wurde auf allen Geräten abgemeldet.`);
        return true;
      case 'toggle':
        if (!u.disabled && !(await confirmDialog({
          title: `${u.name} deaktivieren?`,
          text: 'Die Person wird sofort abgemeldet und kann sich nicht mehr anmelden. Ihre Zettel bleiben erhalten.',
          ok: 'Deaktivieren',
          danger: true,
        }))) return false;
        await api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled });
        toast(u.disabled ? `${u.name} ist wieder aktiv.` : `${u.name} wurde deaktiviert.`);
        return true;
      case 'delete':
        if (!(await confirmDialog({
          title: `Konto von ${u.name} löschen?`,
          text: `Das Konto ${u.email} und alle Zettel darin werden endgültig gelöscht. Das lässt sich nicht rückgängig machen.`,
          ok: 'Endgültig löschen',
          danger: true,
        }))) return false;
        await api('DELETE', `/api/admin/users/${u.id}`);
        toast(`Konto von ${u.name} gelöscht.`);
        return true;
      default: return false;
    }
  } catch (err) {
    toast(err.message, { duration: 6000 });
    return true;
  }
}

async function passwordDialog(u, smtpConfigured) {
  const r = await formDialog({
    title: 'Passwort zurücksetzen',
    sub: `für ${u.name} (${u.email}). Die Person wird dabei überall abgemeldet.`,
    body: html`
      <label class="field">
        <span class="field-label">Neues Passwort</span>
        <input class="input" type="text" name="password" autocomplete="off" spellcheck="false" value="${suggestPassword()}" required>
        <span class="field-hint">Teile es der Person mit. Sie kann es danach unter „Mein Konto“ ändern.</span>
      </label>
      <div class="sep">oder</div>
      <button class="btn btn-block" type="button" data-action="link"><span data-icon="mail"></span>${smtpConfigured ? 'Link per E-Mail senden' : 'Link zum Weitergeben erzeugen'}</button>`,
    submit: 'Passwort setzen',
    onSubmit: async (data) => {
      await api('POST', `/api/admin/users/${u.id}/password`, { password: data.password });
      return { set: true };
    },
  });
  if (!r) return false;
  if (r.set) {
    toast(`Neues Passwort für ${u.name} gesetzt.`);
    return true;
  }
  const res = await api('POST', `/api/admin/users/${u.id}/reset-link`);
  await showLink(res, u.email, 'Reset-Link');
  return true;
}

// ---------- E-Mail ---------------------------------------------------------------

async function renderMail(panel, me, refresh) {
  const { smtp } = await api('GET', '/api/admin/smtp');
  let status;
  if (smtp.testedAt) status = html`<p class="status-line is-ok"><span data-icon="check"></span>Testmail erfolgreich verschickt am ${fmtDateTime.format(smtp.testedAt)}</p>`;
  else if (smtp.host) status = html`<p class="status-line is-warn"><span data-icon="warning"></span>Noch nicht getestet – sende eine Testmail.</p>`;
  else status = html`<p class="status-line"><span data-icon="mail"></span>Noch nicht eingerichtet.</p>`;

  panel.innerHTML = String(html`
    <p class="section-intro">Für Einladungen, „Passwort vergessen“ und den Anmelde-Code.
      Vorgesehen ist Brevo: Server <code>smtp-relay.brevo.com</code>, Port <code>587</code>, STARTTLS,
      Benutzer und SMTP-Schlüssel aus deinem Brevo-Konto.</p>
    ${status}
    <form id="smtp-form" novalidate autocomplete="off">
      <p class="form-error" role="alert" hidden></p>
      <div class="grid-2">
        <label class="field">
          <span class="field-label">Server</span>
          <input class="input" name="host" value="${smtp.host}" placeholder="smtp-relay.brevo.com" spellcheck="false" required>
        </label>
        <label class="field field-port">
          <span class="field-label">Port</span>
          <input class="input" name="port" inputmode="numeric" value="${smtp.port}" required>
        </label>
      </div>
      <label class="field">
        <span class="field-label">Verschlüsselung</span>
        <select class="input" name="security">
          <option value="starttls" ${smtp.security === 'starttls' ? 'selected' : ''}>STARTTLS (meist Port 587)</option>
          <option value="tls" ${smtp.security === 'tls' ? 'selected' : ''}>SSL/TLS (meist Port 465)</option>
          <option value="none" ${smtp.security === 'none' ? 'selected' : ''}>Keine (nur im lokalen Netz)</option>
        </select>
      </label>
      <div class="grid-2 grid-even">
        <label class="field">
          <span class="field-label">Benutzer</span>
          <input class="input" name="user" value="${smtp.user}" autocomplete="off" spellcheck="false">
        </label>
        <label class="field">
          <span class="field-label">Passwort / SMTP-Schlüssel</span>
          <input class="input" type="password" name="pass" autocomplete="new-password"
                 placeholder="${smtp.hasPassword ? 'gespeichert – leer lassen' : ''}">
        </label>
      </div>
      <label class="field">
        <span class="field-label">Absender</span>
        <input class="input" name="from" value="${smtp.from}" placeholder="Notizzettel <notes@deine-domain.de>" spellcheck="false" required>
        <span class="field-hint">Die Adresse muss bei Brevo als Absender bestätigt sein.</span>
      </label>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Speichern</button>
        <button class="btn" type="button" id="btn-test"><span data-icon="mail"></span>Testmail an ${me.email}</button>
      </div>
      <p class="field-hint">Jede Änderung braucht eine neue Testmail. Bis dahin ist der Anmelde-Code per E-Mail ausgesetzt.</p>
    </form>`);
  hydrateIcons(panel);

  const form = panel.querySelector('form');
  const values = () => {
    const d = Object.fromEntries(new FormData(form));
    return { ...d, port: Number(d.port) };
  };
  bindForm(form, async () => {
    await api('PUT', '/api/admin/smtp', values());
    toast('E-Mail-Einstellungen gespeichert.');
    refresh();
  });
  // Testmail: aktuelle Eingaben speichern, dann senden
  const testBtn = panel.querySelector('#btn-test');
  testBtn.addEventListener('click', async () => {
    const errorEl = form.querySelector('.form-error');
    errorEl.hidden = true;
    testBtn.disabled = true;
    testBtn.lastChild.textContent = 'Wird gesendet …';
    try {
      await api('PUT', '/api/admin/smtp', values());
      const r = await api('POST', '/api/admin/smtp/test', {}, { timeout: 60000 });
      toast(`Testmail an ${r.to} verschickt.`);
      refresh();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      testBtn.disabled = false;
      testBtn.lastChild.textContent = `Testmail an ${me.email}`;
    }
  });
}

// ---------- Sicherheit ---------------------------------------------------------

async function renderSecurity(panel, refresh, show) {
  const { security } = await api('GET', '/api/admin/security');
  panel.innerHTML = String(html`
    <div class="setting">
      <div class="setting-text">
        <span class="setting-title" id="twofa-label">Zwei-Faktor-Code per E-Mail</span>
        <span class="setting-desc">Wer sich mit Passwort anmeldet, bekommt zusätzlich einen 6-stelligen Code per E-Mail
          (10 Minuten gültig). Mit „Angemeldet bleiben“ wird nicht erneut gefragt. Anmeldungen per Passkey brauchen keinen Code.</span>
      </div>
      <label class="switch">
        <input type="checkbox" role="switch" id="twofa" aria-labelledby="twofa-label"
          ${security.twofa ? 'checked' : ''} ${!security.smtpTested && !security.twofa ? 'disabled' : ''}>
        <span class="switch-track" aria-hidden="true"></span>
      </label>
    </div>
    ${!security.smtpTested ? html`
      <p class="note">Erst möglich, wenn SMTP eingerichtet ist und eine Testmail erfolgreich verschickt wurde.
        <button class="btn btn-link" type="button" data-goto="mail">Zu den E-Mail-Einstellungen</button></p>` : ''}
    ${security.disabledByConfig ? html`
      <p class="note note-warn">In <code>data/config.json</code> ist <code>"disable2fa": true</code> gesetzt.
        Der Code wird deshalb zurzeit nicht abgefragt – unabhängig von diesem Schalter.</p>` : ''}
    ${security.twofa && !security.active && security.smtpTested === false && !security.disabledByConfig ? html`
      <p class="note note-warn">Eingeschaltet, aber ausgesetzt: Die E-Mail-Einstellungen wurden geändert und noch nicht getestet.</p>` : ''}
    <h2 class="section-title section-gap">Notfall-Zugang</h2>
    <ul class="plain-list">
      <li>Zwei-Faktor abschalten: in <code>data/config.json</code> <code>"disable2fa": true</code> setzen. Wirkt sofort, ohne Neustart.</li>
      <li>Passwort auf dem Server zurücksetzen: <code>node cli.js reset-password &lt;email&gt;</code></li>
    </ul>`);
  hydrateIcons(panel);
  panel.querySelector('[data-goto]')?.addEventListener('click', () => show('mail'));
  const sw = panel.querySelector('#twofa');
  sw.addEventListener('change', async () => {
    sw.disabled = true;
    try {
      await api('PUT', '/api/admin/security', { twofa: sw.checked });
      toast(sw.checked ? 'Zwei-Faktor-Code ist eingeschaltet.' : 'Zwei-Faktor-Code ist ausgeschaltet.');
    } catch (err) {
      sw.checked = !sw.checked;
      toast(err.message, { duration: 6000 });
    }
    refresh();
  });
}
