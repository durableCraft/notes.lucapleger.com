// Der Zettel-Editor: contenteditable mit genau drei Formaten (b, i, u).

import { sanitizePasted, textToHtml, serializeEditor, htmlForEditor } from './sanitize.js';

const COMMANDS = { b: 'bold', i: 'italic', u: 'underline' };

export class Editor extends EventTarget {
  /** @param {HTMLElement} el */
  constructor(el) {
    super();
    this.el = el;
    this.suppress = false;

    try { document.execCommand('styleWithCSS', false, false); } catch { /* egal */ }

    el.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    el.addEventListener('input', () => this.onInput());
    el.addEventListener('keydown', (e) => this.onKeyDown(e));
    el.addEventListener('paste', (e) => this.onPaste(e));
    el.addEventListener('drop', (e) => this.onDrop(e));
    // Verschieben innerhalb des Zettels dem Browser überlassen
    el.addEventListener('dragstart', () => { this.internalDrag = true; });
    el.addEventListener('dragend', () => { this.internalDrag = false; });
    el.addEventListener('focus', () => this.dispatchEvent(new Event('focus')));
    el.addEventListener('blur', () => this.dispatchEvent(new Event('blur')));
    document.addEventListener('selectionchange', () => {
      if (this.hasFocus()) this.dispatchEvent(new Event('selection'));
    });
  }

  hasFocus() { return document.activeElement === this.el; }

  focus() {
    this.el.focus({ preventScroll: true });
  }

  /** Cursor ans Ende setzen */
  focusEnd() {
    this.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(this.el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Inhalt setzen, ohne input-Ereignis auszulösen */
  setContent(stored) {
    this.el.innerHTML = stored ? htmlForEditor(stored) : '';
    this.updateEmpty();
  }

  /** Bereinigter Inhalt (kanonisches HTML) */
  getContent() { return serializeEditor(this.el); }

  /** Leer = kein einziges Zeichen (Umbrüche allein zählen nicht) */
  isEmpty() {
    return this.el.textContent.length === 0;
  }

  updateEmpty() {
    this.el.classList.toggle('is-empty', this.el.textContent.length === 0);
  }

  /** Formatierung umschalten: 'bold' | 'italic' | 'underline' */
  format(cmd) {
    if (!this.hasFocus()) this.focus();
    document.execCommand(cmd, false, null);
    this.dispatchEvent(new Event('selection'));
  }

  /** Aktiver Zustand der Formate an der Cursorposition */
  state() {
    const s = {};
    for (const cmd of Object.values(COMMANDS)) {
      try { s[cmd] = document.queryCommandState(cmd); } catch { s[cmd] = false; }
    }
    return s;
  }

  insertHtml(cleanHtml) {
    if (!cleanHtml) return;
    document.execCommand('insertHTML', false, cleanHtml);
  }

  // ---------- Ereignisse ----------------------------------------------------

  onBeforeInput(e) {
    switch (e.inputType) {
      case 'insertParagraph':
        // Nur <br>, keine <div>/<p>
        e.preventDefault();
        document.execCommand('insertLineBreak');
        break;
      case 'formatFontName':
      case 'formatFontColor':
      case 'formatBackColor':
      case 'formatSetBlockTextDirection':
      case 'formatJustifyCenter':
      case 'formatJustifyFull':
      case 'formatJustifyLeft':
      case 'formatJustifyRight':
      case 'formatIndent':
      case 'formatOutdent':
      case 'formatSuperscript':
      case 'formatSubscript':
      case 'formatStrikeThrough':
      case 'insertOrderedList':
      case 'insertUnorderedList':
      case 'insertHorizontalRule':
      case 'insertLink':
        e.preventDefault();
        break;
      default:
    }
  }

  onInput() {
    this.updateEmpty();
    this.dispatchEvent(new Event('change'));
  }

  onKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey) {
      const cmd = COMMANDS[e.key.toLowerCase()];
      if (cmd) {
        e.preventDefault();
        this.format(cmd);
        return;
      }
    }
    // Tab rückt ein, statt den Fokus zu verlassen
    if (e.key === 'Tab' && !mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\t');
    }
  }

  onPaste(e) {
    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    this.insertHtml(html ? sanitizePasted(html) : textToHtml(text));
  }

  onDrop(e) {
    const dt = e.dataTransfer;
    if (!dt || this.internalDrag) return;
    e.preventDefault();
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    const clean = html ? sanitizePasted(html) : textToHtml(text);
    if (!clean) return;
    // Cursor an die Ablegestelle setzen
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
    else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    this.focus();
    if (range && this.el.contains(range.startContainer)) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    this.insertHtml(clean);
  }
}
