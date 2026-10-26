import { el, api, store, voterToken, ensureAccess } from './common.js';

const $ = (id) => document.getElementById(id);
const STATUS = { neu: 'Neu', geplant: 'Geplant', umgesetzt: 'Umgesetzt', verworfen: 'Verworfen' };

let ideas = [];
let sort = store.get('kim_ideen_sort') === 'beliebt' ? 'beliebt' : 'neu';

init();

async function init() {
  await ensureAccess($('gate'), $('inhalt'));
  $('idee-form').addEventListener('submit', submit);
  $('sort-neu').addEventListener('click', () => setSort('neu'));
  $('sort-beliebt').addEventListener('click', () => setSort('beliebt'));
  setSort(sort);
  await load();
  setInterval(load, 30000);
}

function setSort(value) {
  sort = value;
  store.set('kim_ideen_sort', value);
  $('sort-neu').setAttribute('aria-pressed', String(value === 'neu'));
  $('sort-beliebt').setAttribute('aria-pressed', String(value === 'beliebt'));
  render();
}

async function load() {
  try {
    ideas = (await api(`/api/ideas?voter=${encodeURIComponent(voterToken())}`)).ideas;
    // Wer die Ideen-Seite sieht, hat alle Ideen gesehen: Zähler im Menü zurücksetzen
    if (ideas.length) store.set('kim_ideen_seen', String(Math.max(...ideas.map((i) => i.id))));
    render();
  } catch { /* beim nächsten Intervall erneut */ }
}

function when(iso) {
  // SQLite liefert UTC ohne Zeitzone
  const d = new Date(`${iso.replace(' ', 'T')}Z`);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 7) return `vor ${days} Tagen`;
  return d.toLocaleDateString('de-DE');
}

function render() {
  const list = [...ideas];
  if (sort === 'beliebt') list.sort((a, b) => b.votes - a.votes || b.id - a.id);
  $('idee-anzahl').textContent = list.length === 1 ? '1 Idee' : `${list.length} Ideen`;
  if (!list.length) {
    $('ideen-liste').replaceChildren(el('div', { class: 'karte leer neben', text: 'Noch keine Ideen. Mach den Anfang!' }));
    return;
  }
  $('ideen-liste').replaceChildren(...list.map((i) => el('article', { class: 'idee' },
    el('button', {
      class: 'plus',
      type: 'button',
      'aria-pressed': String(i.mine),
      'aria-label': `${i.mine ? '+1 zurücknehmen' : '+1 geben'} für: ${i.text}`,
      onclick: () => vote(i),
    }, el('b', { text: String(i.votes) }), el('span', { text: '+1' })),
    el('div', { class: 'titel', text: i.text }),
    i.details ? el('p', { class: 'details', text: i.details }) : null,
    el('div', { class: 'meta' },
      el('span', { class: `status ${i.status}`, text: STATUS[i.status] || i.status }),
      el('span', { text: when(i.created_at) }),
    ),
  )));
}

async function vote(idea) {
  try {
    const r = await api(`/api/ideas/${idea.id}/vote`, { method: 'POST', body: { voter: voterToken() } });
    idea.mine = r.voted;
    idea.votes += r.voted ? 1 : -1;
    render();
  } catch (err) {
    showStatus('fehler', err.message);
  }
}

async function submit(event) {
  event.preventDefault();
  const button = event.submitter || $('idee-form').querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/ideas', { method: 'POST', body: { text: $('idee-text').value, details: $('idee-mehr').value } });
    $('idee-form').reset();
    $('idee-form').querySelector('details').open = false;
    showStatus('erfolg', 'Danke! Deine Idee steht jetzt im Speicher.');
    setSort('neu');
    await load();
  } catch (err) {
    showStatus('fehler', err.message);
  } finally {
    button.disabled = false;
  }
}

function showStatus(kind, text) {
  $('idee-status').replaceChildren(kind === 'fehler' ? el('div', { class: 'fehler', text }) : el('p', { class: 'idee-ok', text }));
  setTimeout(() => $('idee-status').replaceChildren(), 5000);
}
