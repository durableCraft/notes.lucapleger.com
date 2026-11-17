// Serverseitige Bereinigung von Zettel-Inhalten (ohne DOM).
// Ergebnis enthält nur <b>, <i>, <u>, <br> (ohne Attribute) und escapten Text.

const FORMAT = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', ins: 'u' };
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'tr', 'ul',
]);

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
      return '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Bereinigt HTML auf b/i/u/br. */
export function sanitizeNote(input) {
  let s = String(input ?? '');
  // Inhalte, die nie Text sind, komplett entfernen
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  s = s.replace(/<(script|style|template|noscript|iframe|object|svg|math|textarea|title|head)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

  const out = [];
  const depth = { b: 0, i: 0, u: 0 };
  const order = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|[^<]+|</g;
  let m;
  while ((m = re.exec(s))) {
    if (m[2] === undefined) {
      out.push(escapeText(decodeEntities(m[0]).replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>'));
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'br') { if (!closing) out.push('<br>'); continue; }
    const f = FORMAT[tag];
    if (f) {
      if (!closing) {
        if (depth[f]++ === 0) { out.push(`<${f}>`); order.push(f); }
      } else if (depth[f] > 0 && --depth[f] === 0) {
        out.push(`</${f}>`);
        order.splice(order.lastIndexOf(f), 1);
      }
      continue;
    }
    if (BLOCK.has(tag)) {
      // Blockgrenzen werden zu Zeilenumbrüchen (aber keine doppelten)
      const last = out[out.length - 1];
      if (out.length && last !== '<br>') out.push('<br>');
    }
    // alle anderen Tags verwerfen, Inhalt bleibt
  }
  for (const f of order.reverse()) out.push(`</${f}>`);
  let html = out.join('');
  // leere Formate entfernen
  let prev;
  do { prev = html; html = html.replace(/<(b|i|u)><\/\1>/g, ''); } while (html !== prev);
  return html;
}

/** Klartext aus Zettel-HTML */
export function noteText(html) {
  return decodeEntities(String(html).replace(/<br>/g, '\n').replace(/<[^>]*>/g, ''));
}

/** Titel = erste nicht-leere Zeile */
export function noteTitle(html) {
  const line = noteText(html).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
