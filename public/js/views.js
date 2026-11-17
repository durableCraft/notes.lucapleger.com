// Darstellung: Verlauf, Papierkorb, Anmeldung (Prototyp)

import { html, groupOf, groupLabels, shortTime, dateOnly, daysLeft } from './util.js';
import { hydrateIcons } from './icons.js';
import { TRASH_DAYS } from './store.js';

/** Verlauf in der Seitenleiste */
export function renderHistory(container, notes, currentId) {
  if (!notes.length) {
    container.innerHTML = String(html`<p class="history-empty">Noch keine Zettel.<br>Was du schreibst, erscheint hier.</p>`);
    return;
  }
  const now = Date.now();
  const groups = { today: [], yesterday: [], week: [], older: [] };
  for (const n of notes) groups[groupOf(n.updatedAt, now)].push(n);

  container.innerHTML = Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([key, list]) => String(html`
      <section class="history-group" aria-labelledby="hg-${key}">
        <h2 class="history-label" id="hg-${key}">${groupLabels[key]}</h2>
        <ul class="history-list">
          ${list.map((n) => html`
            <li>
              <button type="button" class="history-item" data-id="${n.id}" aria-current="${n.id === currentId ? 'true' : 'false'}">
                <span class="history-title ${n.title ? '' : 'is-untitled'}">${n.title || 'Ohne Titel'}</span>
                <span class="history-time">${shortTime(n.updatedAt, now)}</span>
              </button>
            </li>`)}
        </ul>
      </section>`))
    .join('');
}

/** Papierkorb als Papierkarte */
export function renderTrash(container, notes) {
  container.innerHTML = String(html`
    <div class="card">
      <h1 class="card-title">Papierkorb</h1>
      <p class="card-sub">Gelöschte Zettel bleiben ${TRASH_DAYS} Tage hier und werden dann endgültig gelöscht.</p>
      ${notes.length ? html`
        <ul class="trash-list">
          ${notes.map((n) => {
            const left = daysLeft(n.deletedAt, TRASH_DAYS);
            return html`
              <li class="trash-item">
                <div class="trash-text">
                  <span class="trash-title">${n.title || 'Ohne Titel'}</span>
                  <span class="trash-meta">Gelöscht am ${dateOnly(n.deletedAt)} · ${left === 1 ? 'noch 1 Tag' : left === 0 ? 'heute' : `noch ${left} Tage`}</span>
                </div>
                <button type="button" class="btn btn-small" data-restore="${n.id}" aria-label="${n.title || 'Ohne Titel'} wiederherstellen">
                  <span data-icon="restore"></span><span class="hide-narrow">Wiederherstellen</span>
                </button>
              </li>`;
          })}
        </ul>` : html`<p class="trash-empty">Der Papierkorb ist leer.</p>`}
      <div class="card-foot">
        <a class="btn btn-link" href="/" data-link><span data-icon="back"></span>Zurück zum Zettel</a>
        ${notes.length ? html`<button type="button" class="btn btn-small btn-danger" id="btn-empty-trash"><span data-icon="trash"></span>Papierkorb leeren</button>` : ''}
      </div>
    </div>`);
  hydrateIcons(container);
}
