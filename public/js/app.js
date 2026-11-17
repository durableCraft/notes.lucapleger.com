// Notizzettel – App

import { hydrateIcons } from './icons.js';
import { uuid, debounce, longDate, html } from './util.js';
import { NoteStore } from './store.js';
import { Editor } from './editor.js';
import { toast, confirmDialog, Drawer, trackKeyboard } from './ui.js';
import { renderHistory, renderTrash, renderLogin } from './views.js';

const $ = (id) => document.getElementById(id);
const finePointer = window.matchMedia('(pointer: fine)');

const ROUTES = {
  '/': 'editor',
  '/papierkorb': 'trash',
  '/login': 'login',
};

const state = {
  /** @type {NoteStore} */ store: null,
  /** @type {Editor} */ editor: null,
  /** @type {Drawer} */ drawer: null,
  /** Aktueller Zettel: id null = frischer, noch nicht gespeicherter Zettel */
  current: { id: null, saved: '', createdAt: Date.now() },
  view: 'editor',
  channel: null,
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
    setStatus('saved');
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
    el.title = 'Auf diesem Gerät gespeichert';
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

function updateToolbar() {
  $('btn-delete').disabled = !state.current.id;
  const s = state.editor.hasFocus() ? state.editor.state() : {};
  for (const btn of document.querySelectorAll('.fmt-btn[data-cmd]')) {
    btn.setAttribute('aria-pressed', String(!!s[btn.dataset.cmd]));
  }
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
  const view = ROUTES[location.pathname] ?? 'editor';
  if (!ROUTES[location.pathname]) history.replaceState(null, '', '/');
  const prev = state.view;
  state.view = view;
  document.body.dataset.view = view;
  $('view-editor').hidden = view !== 'editor';
  $('view-trash').hidden = view !== 'trash';
  $('view-login').hidden = view !== 'login';
  $('trash-link').setAttribute('aria-current', view === 'trash' ? 'page' : 'false');
  $('account-link').setAttribute('aria-current', view === 'login' ? 'page' : 'false');
  state.drawer?.hide();

  if (view === 'trash') {
    if (prev === 'editor') await saveNow();
    renderTrash($('view-trash'), await state.store.trash());
    document.title = 'Papierkorb – Notizzettel';
  } else if (view === 'login') {
    renderLogin($('view-login'));
    document.title = 'Anmelden – Notizzettel';
  } else {
    document.title = 'Notizzettel';
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
  if (hintChecked) return;
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

async function main() {
  hydrateIcons();
  state.store = await new NoteStore('notizzettel-lokal').open();
  await state.store.purgeExpired();
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

  // Anmeldung (Prototyp)
  $('view-login').addEventListener('submit', (e) => {
    e.preventDefault();
    toast('Die Anmeldung folgt in Schritt 2.');
  });
  $('view-login').addEventListener('click', (e) => {
    if (e.target.closest('#btn-passkey, #btn-forgot')) toast('Folgt in einem späteren Schritt.');
  });

  state.store.addEventListener('change', () => refreshSidebar());

  // Andere Tabs informieren
  if ('BroadcastChannel' in window) {
    state.channel = new BroadcastChannel('notizzettel');
    state.channel.onmessage = () => refreshSidebar();
  }

  // Beim Verlassen sofort speichern
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
    else refreshSidebar();
  });
  window.addEventListener('pagehide', () => saveNow());

  // Strg/⌘+Alt+N: neuer Zettel
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      $('btn-new').click();
    }
  });

  await render();
  await openFresh({ focus: state.view === 'editor' });

  // Browser um dauerhaften Speicher bitten (Chrome/Firefox; Safari ignoriert es)
  navigator.storage?.persist?.().catch(() => {});

  if (!state.store.persistent) {
    toast('Speichern auf diesem Gerät ist nicht möglich (privater Modus?). Zettel gehen beim Schließen verloren.', { duration: 10000 });
  }
}

main().catch((err) => {
  console.error(err);
  document.body.textContent = 'Notizzettel konnte nicht gestartet werden.';
});
