// Bereinigung von Zettel-Inhalten im Browser.
// Erlaubt sind ausschließlich <b>, <i>, <u> und <br>. Alles andere wird zu Text
// bzw. Zeilenumbrüchen. Der Server bereinigt zusätzlich noch einmal.

const FORMAT_TAGS = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', INS: 'u' };

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL',
]);

// Inhalt komplett verwerfen
const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG',
  'MATH', 'HEAD', 'TITLE', 'META', 'LINK', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO',
  'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION',
]);

const BR = Symbol('br');

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** style-Attribut als Text auswerten (unabhängig von CSP und CSSOM) */
function styleOf(el) {
  const out = {};
  const attr = el.getAttribute('style');
  if (!attr) return out;
  for (const decl of attr.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).replace(/!important/i, '').trim().toLowerCase();
  }
  return out;
}

/** Formate, die ein Element (per Tag oder Inline-Style) einschaltet bzw. ausschaltet. */
function formatsOf(el) {
  const on = new Set();
  const off = new Set();
  const tag = FORMAT_TAGS[el.tagName];
  if (tag) on.add(tag);
  const st = styleOf(el);
  const w = st['font-weight'];
  if (w) {
    if (w === 'bold' || w === 'bolder' || Number(w) >= 600) on.add('b');
    else { on.delete('b'); off.add('b'); }
  }
  const fs = st['font-style'];
  if (fs) {
    if (fs.startsWith('italic') || fs.startsWith('oblique')) on.add('i');
    else if (fs === 'normal') { on.delete('i'); off.add('i'); }
  }
  if (/underline/.test(`${st['text-decoration'] || ''} ${st['text-decoration-line'] || ''}`)) on.add('u');
  return { on, off, pre: /^pre/.test(st['white-space'] || '') };
}

/**
 * Wandelt einen DOM-Teilbaum in bereinigtes, kanonisches HTML.
 * @param {Node} root
 * @param {{ keepNewlines: boolean }} opts  keepNewlines: \n im Text ist ein Umbruch
 *        (Editor mit white-space: pre-wrap). Sonst wird Whitespace wie in HTML
 *        zusammengefasst (eingefügtes HTML).
 */
function serialize(root, { keepNewlines }) {
  // 1. Flache Liste aus Textstücken (mit Formatmenge) und Umbrüchen
  const segs = [];
  let pendingBreak = false;
  const lastIsBreak = () => segs.length === 0 || segs[segs.length - 1] === BR;
  const flush = () => {
    if (pendingBreak) { segs.push(BR); pendingBreak = false; }
  };
  const br = () => { flush(); segs.push(BR); };
  const text = (s, f) => {
    if (!s) return;
    flush();
    segs.push({ s, f });
  };

  function walk(node, active, pre) {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE) {
        const v = n.nodeValue.replace(/\r/g, '');
        if (keepNewlines || pre) {
          v.split('\n').forEach((part, i) => {
            if (i > 0) br();
            text(part, active);
          });
        } else {
          const s = v.replace(/[\t\n ]+/g, ' ');
          if (s === ' ' && lastIsBreak()) continue;
          text(s, active);
        }
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = n.tagName;
      if (DROP_TAGS.has(tag)) continue;
      if (tag === 'BR') { br(); continue; }

      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock && !lastIsBreak()) pendingBreak = true;

      const { on, off, pre: preStyle } = formatsOf(n);
      const next = new Set(active);
      off.forEach((f) => next.delete(f));
      on.forEach((f) => next.add(f));
      walk(n, next, pre || preStyle || tag === 'PRE');

      if (isBlock && !lastIsBreak()) pendingBreak = true;
    }
  }
  walk(root, new Set(), false);

  // 2. Ausgabe mit fester Verschachtelung b > i > u
  const ORDER = ['b', 'i', 'u'];
  let out = '';
  let stack = [];
  for (const seg of segs) {
    if (seg === BR) { out += '<br>'; continue; }
    const want = ORDER.filter((f) => seg.f.has(f));
    let k = 0;
    while (k < stack.length && k < want.length && stack[k] === want[k]) k++;
    for (let j = stack.length - 1; j >= k; j--) out += `</${stack[j]}>`;
    for (let j = k; j < want.length; j++) out += `<${want[j]}>`;
    stack = want;
    out += escapeText(seg.s);
  }
  for (let j = stack.length - 1; j >= 0; j--) out += `</${stack[j]}>`;
  return out;
}

function parse(htmlString) {
  // DOMParser führt keine Skripte aus und lädt keine Ressourcen.
  return new DOMParser().parseFromString(`<!doctype html><body>${htmlString}`, 'text/html').body;
}

/** Bereinigt beliebiges (z. B. eingefügtes) HTML. */
export function sanitizePasted(htmlString) {
  const body = parse(htmlString);
  let s = serialize(body, { keepNewlines: false });
  s = s.replace(/^(?:<br>)+/, '').replace(/(?:<br>)+$/, '');
  return s;
}

/** Klartext → Zettel-HTML */
export function textToHtml(text) {
  return escapeText(text.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
}

/**
 * Liest den Inhalt des Editors aus (white-space: pre-wrap) und liefert
 * bereinigtes, kanonisches HTML. Ein abschließender Platzhalter-<br>
 * des Browsers wird entfernt.
 */
export function serializeEditor(el) {
  let s = serialize(el, { keepNewlines: true });
  s = s.replace(/<br>$/, '');
  return s;
}

/** Bereitet gespeichertes HTML für den Editor vor (Umkehrung von serializeEditor). */
export function htmlForEditor(stored) {
  // Erneut bereinigen – gespeicherte Daten sind nicht automatisch vertrauenswürdig.
  let s = serialize(parse(stored), { keepNewlines: true });
  if (s.endsWith('<br>')) s += '<br>';
  return s;
}

/** Klartext aus Zettel-HTML (für Titel/Vorschau) */
export function htmlToText(stored) {
  const body = parse(stored.replace(/<br>/g, '\n'));
  return body.textContent || '';
}

/** Titel = erste nicht-leere Zeile */
export function titleOf(stored) {
  const line = htmlToText(stored).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
