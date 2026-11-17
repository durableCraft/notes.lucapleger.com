// Gemeinsame Bedienelemente: Toast, Dialog, Schublade, Tastatur-Abstand.

import { hydrateIcons } from './icons.js';
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
  dlg.innerHTML = String(html`
    <form method="dialog">
      <h2 class="card-title">${title}</h2>
      <p class="card-sub">${text}</p>
      <div class="dialog-actions">
        <button class="btn" value="cancel" type="submit">${cancel}</button>
        <button class="btn ${danger ? 'btn-primary btn-danger-fill' : 'btn-primary'}" value="ok" type="submit">${ok}</button>
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
