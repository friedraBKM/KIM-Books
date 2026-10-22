import { el, coverImg, api, store, ensureAccess } from './common.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 20000;

let data = null;
let category = 'Alle';
const open = new Set();

init();

async function init() {
  await ensureAccess($('gate'), $('inhalt'));
  $('praesentation').addEventListener('click', () => setPresentation(true));
  $('praesentation-ende').addEventListener('click', () => setPresentation(false));
  if (new URLSearchParams(location.search).get('praesentation') === '1') setPresentation(true);
  await load();
  setInterval(load, REFRESH_MS);
}

function setPresentation(on) {
  document.body.classList.toggle('praesentation', on);
  $('praesentation-ende').hidden = !on;
  if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

async function load() {
  try {
    data = await api('/api/results');
  } catch {
    return; // beim nächsten Intervall erneut
  }
  render();
}

function render() {
  const { stats, categories, books } = data;

  $('kennzahlen').replaceChildren(
    tile(stats.participants, 'Teilnehmende'),
    tile(stats.nominations, 'Nennungen'),
    tile(stats.books, 'Verschiedene Bücher'),
  );

  if (category !== 'Alle' && !categories.includes(category)) category = 'Alle';
  $('filter-bereich').hidden = categories.length === 0;
  $('chips').replaceChildren(...['Alle', ...categories].map((c) => el('button', {
    type: 'button',
    'aria-pressed': String(c === category),
    onclick: () => { category = c; render(); },
    text: c,
  })));

  const list = category === 'Alle' ? books : books.filter((b) => b.category === category);
  const max = Math.max(1, ...list.map((b) => b.count));

  if (!list.length) {
    $('rangliste').replaceChildren(el('div', { class: 'leer-hinweis', text: 'Noch keine Bücher eingetragen. Sei die oder der Erste!' }));
    return;
  }

  // Im Filter neu durchnummerieren, Gleichstand behält den Rang.
  let rank = 0;
  let last = null;
  $('rangliste').replaceChildren(...list.map((b, i) => {
    if (b.count !== last) { rank = i + 1; last = b.count; }
    const isOpen = open.has(b.id);
    const bar = el('i');
    bar.style.width = `${Math.round((b.count / max) * 100)}%`;

    const toggle = b.whys.length
      ? el('button', {
          class: 'textlink nur-normal',
          type: 'button',
          'aria-expanded': String(isOpen),
          onclick: () => { isOpen ? open.delete(b.id) : open.add(b.id); render(); },
          text: isOpen ? 'Stimmen ausblenden' : `Warum? (${b.whys.length})`,
        })
      : null;

    const take = el('button', {
      class: 'textlink nur-normal',
      type: 'button',
      onclick: () => {
        store.set('kim_pick', JSON.stringify({ kind: 'shelf', workId: b.id, title: b.title, authors: b.authors, cover: b.cover }));
        location.href = '/';
      },
      text: 'In meine Top 3',
    });

    return el('div', { class: rank === 1 ? 'platz erster' : 'platz' },
      el('div', { class: 'haupt' },
        el('span', { class: 'rang', text: String(rank) }),
        coverImg(b.cover, true),
        el('div', { class: 'info' },
          el('div', { class: 'zeile' },
            el('span', { class: 'titel', text: b.title }),
            el('span', { class: 'neben', text: b.authors }),
          ),
          el('div', { class: 'balkenzeile' },
            el('div', { class: 'balken', 'aria-hidden': 'true' }, bar),
            el('span', { class: 'anzahl', text: `${b.count} ${b.count === 1 ? 'Nennung' : 'Nennungen'}` }),
          ),
        ),
        b.category ? el('span', { class: 'tag', text: b.category }) : null,
        el('div', { class: 'aktionen' }, toggle, take),
      ),
      isOpen ? el('div', { class: 'stimmen' }, ...b.whys.map((w) => el('p', { text: `„${w}“` }))) : null,
    );
  }));
}

function tile(value, label) {
  return el('div', { class: 'kennzahl' }, el('b', { text: String(value) }), el('span', { text: label.toUpperCase() }));
}
