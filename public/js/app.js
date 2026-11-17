// Notizzettel – App

import { hydrateIcons } from './icons.js';
import { uuid, debounce, longDate, html } from './util.js';
import { NoteStore, LOCAL_DB } from './store.js';
import { Editor } from './editor.js';
import { toast, confirmDialog, Drawer, trackKeyboard } from './ui.js';
import { renderHistory, renderTrash } from './views.js';
import { api } from './api.js';
import { Sync } from './sync.js';
import {
  cachedUser, rememberUser, renderSetup, renderLogin, renderAccount, logout, TAB_ID,
  offerLocalNotes, rescueToLocal, removeLegacyCaches,
} from './auth.js';

const $ = (id) => document.getElementById(id);
const finePointer = window.matchMedia('(pointer: fine)');

const ROUTES = {
  '/': 'editor',
  '/papierkorb': 'trash',
  '/login': 'login',
  '/setup': 'setup',
  '/konto': 'account',
};
const VIEWS = ['editor', 'trash', 'login', 'setup', 'account'];

const state = {
  /** @type {NoteStore} */ store: null,
  /** @type {Editor} */ editor: null,
  /** @type {Drawer} */ drawer: null,
  /** Aktueller Zettel: id null = frischer, noch nicht gespeicherter Zettel */
  current: { id: null, saved: '', createdAt: Date.now() },
  view: 'editor',
  channel: null,
  /** Antwort von /api/status (null = Server nicht erreichbar) */
  status: null,
  /** angemeldeter Benutzer (Zettel liegen dann nur auf dem Server) */
  user: null,
  sessionExpired: false,
  /** @type {Sync|null} */ sync: null,
};

// ---------- Speichern -------------------------------------------------------
// Gespeichert wird immer eine Momentaufnahme (Zettel + Inhalt zum Zeitpunkt
// des Auslösens). So kann der Editor sofort einen anderen Zettel zeigen,
// während das Speichern im Hintergrund noch läuft.

let saveChain = Promise.resolve();
const saveSoon = debounce(() => { saveNow(); }, 500);

function queue(task) {
  saveChain = saveChain.then(task).catch((err) => {
    console.error(err);
    setStatus('error');
  });
  return saveChain;
}

/** Speichert den aktuellen Zettel (falls geändert). */
function saveNow() {
  saveSoon.cancel();
  const snap = {
    cur: state.current,
    content: state.editor.getContent(),
    empty: state.editor.isEmpty(),
  };
  return queue(() => doSave(snap));
}

async function doSave({ cur, content, empty }) {
  if (!cur.id) {
    if (empty) return;   // erst ab dem ersten Zeichen speichern
    cur.id = uuid();
  }
  if (content === cur.saved) return;
  cur.saved = content;
  const note = await state.store.save(cur.id, content);
  cur.createdAt = note.createdAt;
  state.channel?.postMessage('change');
  if (cur === state.current) {
    // Mit Konto meldet erst der Server "Gespeichert" (Ereignis 'pushed')
    if (!state.user) setStatus('saved');
    updateToolbar();
    maybeShowHomescreenHint();
  }
}

/** Verlässt den aktuellen Zettel: speichern, leer gewordene Zettel entfernen. */
function leaveCurrent() {
  const cur = state.current;
  const empty = state.editor.isEmpty();
  saveNow();
  return queue(async () => {
    if (cur.id && empty) {
      await state.store.remove(cur.id);
      state.channel?.postMessage('change');
    }
  });
}

// ---------- Zettel öffnen ---------------------------------------------------

/** Zeigt sofort einen frischen, leeren Zettel (ohne den alten zu speichern). */
function resetToFresh() {
  state.current = { id: null, saved: '', createdAt: Date.now() };
  state.editor.setContent('');
  showStamp();
  updateToolbar();
  setStatus('');
  $('view-editor').scrollTop = 0;
}

async function openFresh({ focus = true } = {}) {
  const leaving = leaveCurrent();
  resetToFresh();
  if (focus) focusEditor(true);
  await leaving;
  await refreshSidebar();
}

async function openNote(id) {
  if (id === state.current.id) return;
  const leaving = leaveCurrent();
  const note = await state.store.get(id);
  await leaving;
  if (!note || note.deletedAt) {
    resetToFresh();
    await refreshSidebar();
    return;
  }
  state.current = { id: note.id, saved: note.html, createdAt: note.createdAt };
  state.editor.setContent(note.html);
  showStamp();
  updateToolbar();
  setStatus('');
  $('view-editor').scrollTop = 0;
  focusEditor(false);
  await refreshSidebar();
}

/** Auf Geräten mit Maus direkt den Cursor setzen; mobil keine Tastatur aufzwingen. */
function focusEditor(fresh) {
  if (!finePointer.matches && !fresh) return;
  if (fresh) state.editor.focus(); else state.editor.focusEnd();
}

async function deleteCurrent() {
  const empty = state.editor.isEmpty();
  await saveNow();
  const { id } = state.current;
  if (!id) return;
  const { store } = state;
  resetToFresh();
  if (finePointer.matches) state.editor.focus();
  if (empty) {
    // leerer Zettel: einfach verwerfen
    await store.remove(id);
  } else {
    await store.moveToTrash(id);
    toast('Zettel in den Papierkorb gelegt.', {
      action: 'Rückgängig',
      onAction: async () => {
        await store.restore(id);
        state.channel?.postMessage('change');
        await navigate('/');
        await openNote(id);
      },
    });
  }
  state.channel?.postMessage('change');
  await refreshSidebar();
}

/** Änderungen vom Server am gerade offenen Zettel übernehmen */
async function onRemoteChange(ids) {
  const cur = state.current;
  if (!cur.id || !ids.includes(cur.id)) return;
  const note = await state.store.get(cur.id);
  if (!note || note.deletedAt) {
    resetToFresh();
    toast('Dieser Zettel wurde auf einem anderen Gerät gelöscht.');
    return;
  }
  // Nur ersetzen, wenn hier gerade nichts Ungespeichertes steht
  const untouched = !saveSoon.pending() && state.editor.getContent() === cur.saved;
  if (untouched && note.html !== cur.saved) {
    const hadFocus = state.editor.hasFocus();
    cur.saved = note.html;
    cur.createdAt = note.createdAt;
    state.editor.setContent(note.html);
    showStamp();
    if (hadFocus) state.editor.focusEnd();
  }
}

// ---------- Anzeige ---------------------------------------------------------

function showStamp() {
  const t = $('stamp');
  t.textContent = longDate(state.current.createdAt);
  t.dateTime = new Date(state.current.createdAt).toISOString();
}

let statusTimer = null;
function setStatus(kind) {
  const el = $('status');
  clearTimeout(statusTimer);
  if (kind === 'saved') {
    el.innerHTML = String(html`<span data-icon="check"></span><span>Gespeichert</span>`);
    el.title = state.user ? 'Auf dem Server gespeichert' : 'Auf diesem Gerät gespeichert';
    hydrateIcons(el);
    el.classList.add('is-visible');
    statusTimer = setTimeout(() => el.classList.remove('is-visible'), 2500);
  } else if (kind === 'error') {
    el.innerHTML = String(html`<span data-icon="warning"></span><span>Nicht gespeichert</span>`);
    el.title = 'Speichern fehlgeschlagen';
    hydrateIcons(el);
    el.classList.add('is-visible');
  } else {
    el.classList.remove('is-visible');
  }
}

/** Dauerhafte Anzeige, wenn der Abgleich nicht klappt */
function setSyncBadge(kind) {
  const el = $('sync-badge');
  if (!kind) {
    el.hidden = true;
    return;
  }
  const map = {
    offline: ['cloudOff', 'Offline', 'Keine Verbindung zum Server.'],
    unsaved: ['cloudOff', 'Nicht gespeichert', 'Keine Verbindung zum Server. Deine Änderungen werden übertragen, sobald die Verbindung wieder da ist – schließe die Seite bis dahin nicht.'],
    error: ['warning', 'Nicht gespeichert', 'Der Server hat einen Fehler gemeldet. Es wird regelmäßig erneut versucht – schließe die Seite bis dahin nicht.'],
    auth: ['cloudOff', 'Abgemeldet', 'Deine Sitzung ist abgelaufen. Melde dich an, um weiterzuschreiben.'],
  };
  const [icon, label, title] = map[kind];
  el.innerHTML = String(html`<span data-icon="${icon}"></span><span>${label}</span>`);
  el.title = title;
  hydrateIcons(el);
  el.hidden = false;
}

function updateAccountLink() {
  const link = $('account-link');
  link.setAttribute('href', state.user ? '/konto' : '/login');
  $('account-label').textContent = state.user ? state.user.name : 'Anmelden';
}

function updateToolbar() {
  $('btn-delete').disabled = !state.current.id;
  const s = state.editor.hasFocus() ? state.editor.state() : {};
  for (const btn of document.querySelectorAll('.fmt-btn[data-cmd]')) {
    btn.setAttribute('aria-pressed', String(!!s[btn.dataset.cmd]));
  }
}

let sidebarTimer = null;
/** Mehrere Änderungen kurz hintereinander nur einmal darstellen */
function scheduleSidebar() {
  if (sidebarTimer) return;
  sidebarTimer = setTimeout(() => {
    sidebarTimer = null;
    refreshSidebar();
  }, 30);
}

async function refreshSidebar() {
  const [notes, trash] = await Promise.all([state.store.list(), state.store.trash()]);
  renderHistory($('history'), notes, state.current.id);
  const count = $('trash-count');
  count.hidden = trash.length === 0;
  count.textContent = String(trash.length);
  if (state.view === 'trash') renderTrash($('view-trash'), trash);
}

// ---------- Router ----------------------------------------------------------

function navigate(path, { replace = false } = {}) {
  if (path !== location.pathname) {
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
  }
  return render();
}

async function render() {
  const path = location.pathname;
  let view = ROUTES[path];
  if (!view) {
    history.replaceState(null, '', '/');
    view = 'editor';
  }
  // Weiterleitungen je nach Anmeldestatus
  if (view === 'login' && state.user && !state.sessionExpired) return navigate('/konto', { replace: true });
  if (view === 'account' && !state.user) return navigate('/login', { replace: true });

  const prev = state.view;
  state.view = view;
  document.body.dataset.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  $('trash-link').setAttribute('aria-current', view === 'trash' ? 'page' : 'false');
  $('account-link').setAttribute('aria-current', ['login', 'account', 'setup'].includes(view) ? 'page' : 'false');
  state.drawer?.hide();
  if (prev === 'editor' && view !== 'editor') await saveNow();

  const status = state.status ?? { setupRequired: false, user: state.user, features: {} };
  if (view === 'trash') {
    renderTrash($('view-trash'), await state.store.trash());
    document.title = 'Papierkorb – Notizzettel';
  } else if (view === 'login') {
    renderLogin($('view-login'), status, { expired: state.sessionExpired });
    document.title = 'Anmelden – Notizzettel';
  } else if (view === 'setup') {
    renderSetup($('view-setup'), status);
    document.title = 'Einrichtung – Notizzettel';
  } else if (view === 'account') {
    renderAccount($('view-account'), state.user, {
      onLogout: () => logout({ store: state.store, sync: state.sync }),
    });
    document.title = 'Mein Konto – Notizzettel';
  } else {
    document.title = 'Notizzettel';
  }
  // Fokus auf das erste Eingabefeld von Karten (nur mit Maus/Tastatur)
  if (view !== 'editor' && view !== 'trash' && finePointer.matches) {
    $(`view-${view}`).querySelector('input:not([type=hidden]):not([type=checkbox])')?.focus();
  }
}

// ---------- Hinweis: Home-Bildschirm (Safari) -------------------------------

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function appleDevice() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const macSafari = /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg\/|Firefox|OPR\//.test(ua);
  return ios ? 'ios' : macSafari ? 'mac' : null;
}

let hintChecked = false;
async function maybeShowHomescreenHint() {
  if (hintChecked || state.user) return;
  hintChecked = true;
  const device = appleDevice();
  if (!device || isStandalone()) return;
  if (await state.store.getMeta('hint-homescreen')) return;

  const how = device === 'ios'
    ? 'Teilen → „Zum Home-Bildschirm“'
    : 'Ablage → „Zum Dock hinzufügen“';
  const hint = document.createElement('aside');
  hint.className = 'hint';
  hint.innerHTML = String(html`
    <strong>Tipp:</strong> Deine Zettel liegen nur auf diesem Gerät. Damit Safari sie nicht nach
    7&nbsp;Tagen ohne Besuch löscht: ${how} – oder melde dich an.
    <button type="button" class="icon-btn" aria-label="Hinweis schließen"><span data-icon="close"></span></button>`);
  hydrateIcons(hint);
  hint.querySelector('button').addEventListener('click', () => {
    hint.remove();
    state.editor.focus();
  });
  $('view-editor').prepend(hint);
  await state.store.setMeta('hint-homescreen', Date.now());
}

// ---------- Start -----------------------------------------------------------

/** Fragt den Server nach Einrichtung und Anmeldung. */
async function loadStatus() {
  const cached = cachedUser();
  try {
    state.status = await api('GET', '/api/status', undefined, { timeout: 8000 });
  } catch {
    // Server nicht erreichbar: vorerst ohne Konto (lokal) weiterschreiben
    state.status = null;
    state.user = null;
    return;
  }
  state.user = state.status.user;
  if (state.user) rememberUser(state.user);
  else if (cached) state.sessionExpired = true;
}

async function main() {
  hydrateIcons();
  await loadStatus();
  removeLegacyCaches();
  // Mit Konto: nichts auf dem Gerät speichern, nur im Arbeitsspeicher halten
  state.store = state.user
    ? await new NoteStore('konto', { synced: true, memory: true }).open()
    : await new NoteStore(LOCAL_DB).open();
  await state.store.purgeExpired();
  if (state.status?.setupRequired && location.pathname === '/') history.replaceState(null, '', '/setup');
  updateAccountLink();
  // Leer gebliebene Zettel (z. B. Fenster geschlossen nach Löschen allen Texts) entfernen
  for (const n of await state.store.list()) {
    if (!n.title && !n.html.replace(/<[^>]*>/g, '')) await state.store.remove(n.id);
  }

  const editor = new Editor($('editor'));
  state.editor = editor;
  editor.addEventListener('change', () => {
    saveSoon();
    updateToolbar();
  });
  editor.addEventListener('selection', updateToolbar);
  editor.addEventListener('focus', () => { document.body.classList.add('is-editing'); updateToolbar(); });
  editor.addEventListener('blur', () => { document.body.classList.remove('is-editing'); updateToolbar(); });

  state.drawer = new Drawer({ panel: $('sidebar'), backdrop: $('backdrop'), toggle: $('btn-menu') });
  trackKeyboard();

  // Formatknöpfe: Fokus im Editor lassen (sonst schließt mobil die Tastatur)
  for (const btn of document.querySelectorAll('.fmt-btn')) {
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('mousedown', (e) => e.preventDefault());
  }
  for (const btn of document.querySelectorAll('.fmt-btn[data-cmd]')) {
    btn.addEventListener('click', () => editor.format(btn.dataset.cmd));
  }
  $('btn-done').addEventListener('click', () => editor.el.blur());

  $('btn-new').addEventListener('click', async () => {
    await navigate('/');
    await openFresh();
  });
  $('btn-delete').addEventListener('click', deleteCurrent);

  $('history').addEventListener('click', async (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;
    await navigate('/');
    await openNote(item.dataset.id);
  });

  // Links innerhalb der App
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', render);

  // Papierkorb
  $('view-trash').addEventListener('click', async (e) => {
    const restoreBtn = e.target.closest('[data-restore]');
    if (restoreBtn) {
      const id = restoreBtn.dataset.restore;
      await state.store.restore(id);
      state.channel?.postMessage('change');
      toast('Zettel wiederhergestellt.', {
        action: 'Öffnen',
        onAction: async () => { await navigate('/'); await openNote(id); },
      });
      return;
    }
    if (e.target.closest('#btn-empty-trash')) {
      const n = (await state.store.trash()).length;
      const ok = await confirmDialog({
        title: 'Papierkorb leeren?',
        text: `${n === 1 ? '1 Zettel wird' : `${n} Zettel werden`} endgültig gelöscht. Das lässt sich nicht rückgängig machen.`,
        ok: 'Endgültig löschen',
        danger: true,
      });
      if (ok) {
        await state.store.emptyTrash();
        state.channel?.postMessage('change');
        toast('Papierkorb geleert.');
      }
    }
  });

  document.addEventListener('notizzettel:user', (e) => {
    state.user = e.detail;
    updateAccountLink();
  });

  state.store.addEventListener('change', scheduleSidebar);

  // Andere Tabs informieren (bei An-/Abmeldung neu laden)
  if ('BroadcastChannel' in window) {
    state.channel = new BroadcastChannel('notizzettel');
    state.channel.onmessage = (e) => {
      if (e.data?.type === 'reload') {
        if (e.data.from !== TAB_ID) location.reload();
      } else scheduleSidebar();
    };
  }

  // Abgleich mit dem Server
  if (state.user) {
    const sync = new Sync(state.store);
    state.sync = sync;
    const updateBadge = () => {
      const s = sync.state;
      if (s === 'ok' || s === 'syncing' || s === 'idle') setSyncBadge(null);
      else if (s === 'offline') setSyncBadge(sync.pending ? 'unsaved' : 'offline');
      else setSyncBadge(s);
    };
    sync.addEventListener('state', updateBadge);
    sync.addEventListener('pushed', () => {
      updateBadge();
      if (!sync.pending) setStatus('saved');
    });
    sync.addEventListener('remote', (e) => onRemoteChange(e.detail.ids));
    // Sitzung abgelaufen: offene Änderungen ohne Konto auf dem Gerät sichern,
    // nach der nächsten Anmeldung werden sie zur Übernahme angeboten.
    sync.addEventListener('unauthorized', async () => {
      const first = !state.sessionExpired;
      state.sessionExpired = true;
      const rescued = await rescueToLocal(await state.store.dirty());
      if (first) {
        toast(rescued
          ? 'Deine Sitzung ist abgelaufen. Deine letzten Änderungen sind auf diesem Gerät gesichert – nach der Anmeldung kannst du sie übernehmen.'
          : 'Deine Sitzung ist abgelaufen.', { duration: 10000 });
        navigate('/login');
      }
    });
    await sync.start();
  } else if (state.sessionExpired) {
    toast('Deine Sitzung ist abgelaufen. Deine Zettel bleiben erhalten.', {
      action: 'Anmelden', onAction: () => navigate('/login'), duration: 10000,
    });
  }

  // Beim Verlassen sofort speichern (mit Konto: direkt an den Server)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow().then(() => state.sync?.run());
    else refreshSidebar();
  });
  window.addEventListener('pagehide', () => {
    saveNow().then(() => state.sync?.flush());
  });
  // Warnen, wenn Änderungen den Server nicht erreichen konnten
  window.addEventListener('beforeunload', (e) => {
    const sync = state.sync;
    if (!sync || ['ok', 'syncing', 'idle'].includes(sync.state)) return;
    if (sync.pending || saveSoon.pending()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Strg/⌘+Alt+N: neuer Zettel
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      $('btn-new').click();
    }
  });

  await render();
  await openFresh({ focus: state.view === 'editor' });

  if (state.user) {
    // Zettel, die ohne Anmeldung auf diesem Gerät liegen, ins Konto übernehmen?
    try {
      const taken = await offerLocalNotes();
      if (taken) {
        await state.sync.run();
        toast(taken === 1 ? '1 Zettel übernommen.' : `${taken} Zettel übernommen.`);
      }
    } catch {
      toast('Die Zettel auf diesem Gerät konnten nicht übernommen werden. Sie bleiben erhalten und werden beim nächsten Start erneut angeboten.', { duration: 10000 });
    }
  } else {
    // Browser um dauerhaften Speicher bitten (Chrome/Firefox; Safari ignoriert es)
    navigator.storage?.persist?.().catch(() => {});
    if (!state.store.persistent) {
      toast('Speichern auf diesem Gerät ist nicht möglich (privater Modus?). Zettel gehen beim Schließen verloren.', { duration: 10000 });
    } else if (!state.status) {
      toast('Der Server ist gerade nicht erreichbar. Deine Zettel werden vorerst nur auf diesem Gerät gespeichert.', { duration: 10000 });
    }
  }
}

main().catch((err) => {
  console.error(err);
  document.body.textContent = 'Notizzettel konnte nicht gestartet werden.';
});
