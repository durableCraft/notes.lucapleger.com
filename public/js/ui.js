// Gemeinsame Bedienelemente: Toast, Dialog, Schublade, Tastatur-Abstand.

import { hydrateIcons, wrapLabels } from './icons.js';
import { html } from './util.js';

// ---------- Toast -----------------------------------------------------------

let toastTimer = null;

/**
 * Zeigt eine kurze Meldung. Optional mit Aktion (z. B. "Rückgängig").
 * @param {string} text
 * @param {{ action?: string, onAction?: () => void, duration?: number }} [opts]
 */
export function toast(text, opts = {}) {
  const el = document.getElementById('toast');
  const btn = document.getElementById('toast-action');
  document.getElementById('toast-text').textContent = text;
  clearTimeout(toastTimer);

  btn.hidden = !opts.action;
  btn.onclick = null;
  if (opts.action) {
    btn.textContent = opts.action;
    wrapLabels(btn);
    btn.onclick = () => {
      hideToast();
      opts.onAction?.();
    };
  }
  // Animation neu starten
  el.hidden = true;
  void el.offsetWidth;
  el.hidden = false;
  toastTimer = setTimeout(hideToast, opts.duration ?? (opts.action ? 7000 : 3500));
}

export function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast').hidden = true;
}

// ---------- Dialog ----------------------------------------------------------

/**
 * Bestätigungsdialog als Papierkarte.
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, text, ok = 'OK', cancel = 'Abbrechen', danger = false }) {
  const dlg = document.getElementById('dialog');
  dlg.classList.remove('dialog-wide');
  dlg.innerHTML = String(html`
    <form method="dialog">
      <h2 class="card-title">${title}</h2>
      <p class="card-sub">${text}</p>
      <div class="dialog-actions">
        <button class="btn" value="cancel" type="submit">${cancel}</button>
        ${ok ? html`<button class="btn ${danger ? 'btn-danger-fill' : 'btn-primary'}" value="ok" type="submit">${ok}</button>` : ''}
      </div>
    </form>`);
  hydrateIcons(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
    dlg.querySelector('[value="cancel"]').focus();
  });
}

// ---------- Formulare ------------------------------------------------------

/**
 * Verbindet ein Formular mit einer asynchronen Aktion: Knopf sperren,
 * Fehler im Formular anzeigen, betroffenes Feld markieren.
 */
export function bindForm(form, action) {
  const errorEl = form.querySelector('.form-error');
  const submit = form.querySelector('[type="submit"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit?.disabled) return;
    errorEl.hidden = true;
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    if (submit) submit.disabled = true;
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
      if (submit) submit.disabled = false;
    }
  });
}

export function fieldError(field, message) {
  const err = new Error(message);
  err.field = field;
  return err;
}

/** Text in die Zwischenablage (mit Rückfall für unsichere Verbindungen) */
export async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (input) {
      input.focus();
      input.select();
      try { return document.execCommand('copy'); } catch { return false; }
    }
    return false;
  }
}

/** Link-Feld mit Kopieren-Knopf (für Einladungen und Reset-Links) */
export function linkBox(link) {
  return html`<div class="link-box">
    <input class="input" type="text" value="${link}" readonly aria-label="Link">
    <button class="btn btn-small" type="button" data-copy><span data-icon="copy"></span>Kopieren</button>
  </div>`;
}

/**
 * Dialog mit Formular als Papierkarte.
 * - Absenden ruft onSubmit(data, form) auf; ohne Fehler schließt der Dialog
 *   und liefert dessen Rückgabewert (Standard: true).
 * - Knöpfe mit data-action schließen den Dialog und liefern { action }.
 * - Abbrechen/Escape liefert null.
 * @returns {Promise<any>}
 */
export function formDialog({ title, sub = '', body = '', submit = '', cancel = 'Abbrechen', danger = false, onSubmit, wide = false }) {
  const dlg = document.getElementById('dialog');
  dlg.classList.toggle('dialog-wide', wide);
  dlg.innerHTML = String(html`
    <form novalidate>
      <h2 class="card-title">${title}</h2>
      ${sub ? html`<p class="card-sub">${sub}</p>` : ''}
      <p class="form-error" role="alert" hidden></p>
      ${html.raw(String(body))}
      <div class="dialog-actions">
        ${cancel ? html`<button class="btn" type="button" data-cancel>${cancel}</button>` : ''}
        ${submit ? html`<button class="btn ${danger ? 'btn-danger-fill' : 'btn-primary'}" type="submit">${submit}</button>` : ''}
      </div>
    </form>`);
  hydrateIcons(dlg);
  const form = dlg.querySelector('form');
  return new Promise((resolve) => {
    let result = null;
    bindForm(form, async (data, f) => {
      const r = onSubmit ? await onSubmit(data, f) : true;
      result = r === undefined ? true : r;
      dlg.close();
    });
    form.addEventListener('click', async (e) => {
      if (e.target.closest('[data-cancel]')) dlg.close();
      const act = e.target.closest('[data-action]');
      if (act) {
        result = { action: act.dataset.action };
        dlg.close();
      }
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        const input = copy.parentElement.querySelector('input');
        if (await copyText(input.value, input)) toast('Link kopiert.');
      }
    });
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
    form.querySelector('input:not([readonly]):not([type=hidden]), select')?.focus();
  });
}

// ---------- Schublade (Verlauf auf schmalen Bildschirmen) -------------------

export class Drawer {
  constructor({ panel, backdrop, toggle }) {
    this.panel = panel;
    this.backdrop = backdrop;
    this.toggleBtn = toggle;
    this.mq = window.matchMedia('(max-width: 899px)');
    this.open = false;

    toggle.addEventListener('click', () => (this.open ? this.hide() : this.show()));
    backdrop.addEventListener('click', () => this.hide());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.hide();
    });
    this.mq.addEventListener('change', () => { if (!this.mq.matches) this.hide(true); });
    this.initSwipe();
    this.syncInert();
  }

  get isDrawer() { return this.mq.matches; }

  show() {
    if (!this.isDrawer) return;
    this.open = true;
    this.backdrop.hidden = false;
    requestAnimationFrame(() => this.backdrop.classList.add('is-visible'));
    this.panel.classList.add('is-open');
    this.toggleBtn.setAttribute('aria-expanded', 'true');
    this.syncInert();
    this.panel.querySelector('[aria-current="true"], a, button')?.focus({ preventScroll: true });
  }

  hide(immediate = false) {
    if (!this.open && !immediate) return;
    this.open = false;
    this.panel.classList.remove('is-open');
    this.backdrop.classList.remove('is-visible');
    this.toggleBtn.setAttribute('aria-expanded', 'false');
    this.syncInert();
    const done = () => { if (!this.open) this.backdrop.hidden = true; };
    if (immediate) done(); else setTimeout(done, 250);
  }

  /** Geschlossene Schublade ist für Tastatur/Screenreader nicht erreichbar */
  syncInert() {
    this.panel.inert = this.isDrawer && !this.open;
  }

  /** Vom linken Rand wischen öffnet, nach links wischen schließt. */
  initSwipe() {
    const EDGE = 24;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let decided = false;
    let fromOpen = false;
    let dx = 0;
    const width = () => this.panel.getBoundingClientRect().width;

    document.addEventListener('touchstart', (e) => {
      if (!this.isDrawer || e.touches.length !== 1) return;
      const t = e.touches[0];
      fromOpen = this.open;
      if (!fromOpen && t.clientX > EDGE) return;
      if (fromOpen && document.querySelector('dialog[open]')) return;
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
      decided = false;
      dx = 0;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // nur waagerechte Gesten
        if (Math.abs(dy) > Math.abs(dx) || (fromOpen ? dx > 0 : dx < 0)) {
          tracking = false;
          return;
        }
        decided = true;
        this.panel.classList.add('is-dragging');
        if (!fromOpen) this.backdrop.hidden = false;
      }
      const w = width();
      const offset = fromOpen ? Math.min(0, dx) : Math.min(0, -w + dx);
      this.panel.style.transform = `translateX(${offset}px)`;
      this.backdrop.style.opacity = String(1 + offset / w);
    }, { passive: true });

    const end = () => {
      if (!tracking) return;
      tracking = false;
      if (!decided) return;
      this.panel.classList.remove('is-dragging');
      this.panel.style.transform = '';
      this.backdrop.style.opacity = '';
      const threshold = Math.min(80, width() / 3);
      if (fromOpen) {
        if (dx < -threshold) this.hide(); else this.show();
      } else if (dx > threshold) this.show();
      else this.hide(true);
    };
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
  }
}

// ---------- Formatleiste über der Bildschirmtastatur ------------------------

/** Setzt --kb-offset, damit fixierte Leisten über der Tastatur sitzen. */
export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    const covered = window.innerHeight - (vv.height + vv.offsetTop);
    root.style.setProperty('--kb-offset', `${-Math.max(0, Math.round(covered))}px`);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
