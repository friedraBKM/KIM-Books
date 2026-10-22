import { el, coverImg, api, store, ensureAccess } from './common.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 20000;

let data = null;
let amazonTag = '';
let partner = store.get('kim_partner') !== 'off';
let category = 'Alle';
const open = new Set();

init();

async function init() {
  const cfg = await ensureAccess($('gate'), $('inhalt'));
  amazonTag = cfg.amazonTag || '';
  setupPartnerSwitch();
  $('praesentation').addEventListener('click', () => setPresentation(true));
  $('praesentation-ende').addEventListener('click', () => setPresentation(false));
  if (new URLSearchParams(location.search).get('praesentation') === '1') setPresentation(true);
  await load();
  setInterval(load, REFRESH_MS);
}

function setupPartnerSwitch() {
  if (!amazonTag) {
    partner = false;
    return;
  }
  $('amazon-schalter').hidden = false;
  for (const input of document.querySelectorAll('input[name="partner"]')) {
    input.checked = (input.value === 'on') === partner;
    input.addEventListener('change', () => {
      partner = input.value === 'on';
      store.set('kim_partner', partner ? 'on' : 'off');
      if (data) render();
    });
  }
}

function amazonHref(link) {
  if (!link?.url) return null;
  if (!partner || !amazonTag) return link.url;
  return `${link.url}${link.url.includes('?') ? '&' : '?'}tag=${encodeURIComponent(amazonTag)}`;
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
  const usePartner = partner && Boolean(amazonTag);
  $('partner-hinweis').hidden = !usePartner;
  $('link-hinweis').hidden = usePartner;

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
            titleLink(b, usePartner),
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

function titleLink(b, usePartner) {
  const href = amazonHref(b.amazon);
  if (!href) return el('span', { class: 'titel', text: b.title });
  return el('span', {},
    el('a', {
      class: 'titel',
      href,
      target: '_blank',
      rel: usePartner ? 'sponsored noopener noreferrer' : 'noopener noreferrer',
      title: b.amazon.exact ? 'Bei Amazon ansehen' : 'Bei Amazon suchen',
      text: b.title,
    }),
    usePartner ? el('span', { class: 'neben', 'aria-label': 'Partnerlink', text: '*' }) : null,
    b.amazon.exact ? null : el('span', { class: 'neben klein', text: ' (Amazon-Suche)' }),
  );
}

function tile(value, label) {
  return el('div', { class: 'kennzahl' }, el('b', { text: String(value) }), el('span', { text: label.toUpperCase() }));
}
