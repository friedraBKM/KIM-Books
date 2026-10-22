import { el, coverImg, api, store, voterToken, ensureAccess } from './common.js';

const MAX = 3;
const $ = (id) => document.getElementById(id);

let selected = [];
let shelfBooks = [];
let maxWhy = 280;
let hadSubmission = false;
let lastQuery = '';

init();

async function init() {
  const cfg = await ensureAccess($('gate'), $('inhalt'));
  maxWhy = cfg.maxWhyLength || 280;

  try {
    const existing = await api(`/api/submission?voter=${encodeURIComponent(voterToken())}`);
    selected = existing.books || [];
    hadSubmission = selected.length > 0;
    if (hadSubmission) showStatus('hinweis', 'Du hast schon abgestimmt. Du kannst deine Auswahl hier ändern und erneut eintragen.', false, false);
  } catch { /* neu */ }

  // Übernahme von der Ergebnisseite
  const pick = store.get('kim_pick');
  if (pick) {
    store.remove('kim_pick');
    try { addBook(JSON.parse(pick)); } catch { /* ignorieren */ }
  }

  $('suche').addEventListener('submit', (event) => {
    event.preventDefault();
    search($('q').value.trim(), false);
  });
  $('manuell').addEventListener('submit', (event) => {
    event.preventDefault();
    addBook({ kind: 'manual', title: $('m-titel').value.trim(), authors: $('m-autor').value.trim(), cover: null });
    $('manuell').reset();
    $('manuell').hidden = true;
  });
  $('manuell-abbrechen').addEventListener('click', () => { $('manuell').hidden = true; });
  $('absenden').addEventListener('click', submit);

  render();
  loadShelf();
}

async function loadShelf() {
  try {
    shelfBooks = (await api('/api/shelf')).books;
  } catch {
    shelfBooks = [];
  }
  renderShelf();
}

function bookKey(b) {
  return b.kind === 'shelf' ? `w${b.workId}` : b.kind === 'manual' ? `m${b.title}|${b.authors}`.toLowerCase() : `${b.source}:${b.sourceId}`;
}

function isSelected(b) {
  return selected.some((s) => bookKey(s) === bookKey(b));
}

function addBook(book) {
  if (selected.length >= MAX) {
    showStatus('fehler', 'Du hast schon drei Bücher ausgewählt. Entferne erst eines.');
    return;
  }
  if (isSelected(book)) return;
  selected.push({ ...book, why: book.why || '' });
  $('treffer').replaceChildren();
  $('q').value = '';
  render();
  const cards = $('auswahl').querySelectorAll('textarea');
  cards[cards.length - 1]?.focus();
}

function render() {
  $('zaehler').textContent = `${selected.length} von ${MAX} ausgewählt`;
  $('hinzufuegen').hidden = selected.length >= MAX;
  $('absenden').disabled = selected.length === 0;
  $('absenden').textContent = hadSubmission ? 'Änderungen speichern' : 'Meine Bücher eintragen';

  $('auswahl').replaceChildren(...selected.map((b, i) => {
    const id = `why-${i}`;
    const textarea = el('textarea', { id, rows: '2', maxlength: String(maxWhy), placeholder: 'Ein, zwei Sätze reichen.' });
    textarea.value = b.why || '';
    const counter = el('span', { class: 'neben klein', text: `${textarea.value.length}/${maxWhy} Zeichen · wird ohne Namen angezeigt` });
    textarea.addEventListener('input', () => {
      b.why = textarea.value;
      counter.textContent = `${textarea.value.length}/${maxWhy} Zeichen · wird ohne Namen angezeigt`;
    });
    return el('article', { class: 'karte buch' },
      coverImg(b.cover),
      el('div', { class: 'info' },
        el('div', { class: 'zeile' },
          el('div', {},
            el('div', { class: 'kicker', text: `Buch ${i + 1}` }),
            el('div', { class: 'titel', text: b.title }),
            el('div', { class: 'neben', text: [b.authors, b.meta].filter(Boolean).join(' · ') }),
            b.kind === 'manual' ? el('div', { class: 'neben klein', text: 'Selbst eingetragen – wird noch geprüft.' }) : null,
          ),
          el('button', { class: 'sekundaer', type: 'button', onclick: () => { selected.splice(i, 1); render(); }, text: 'Entfernen' }),
        ),
        el('label', { for: id, text: 'Was hat dieses Buch bei dir verändert?' }),
        textarea,
        counter,
      ),
    );
  }));

  if (selected.length === 0) {
    $('auswahl').append(el('div', { class: 'karte leer neben', text: 'Noch kein Buch ausgewählt. Lieber zwei echte Must-Reads als drei halbe.' }));
  }
  renderShelf();
}

function renderShelf() {
  const available = shelfBooks.filter((b) => !isSelected({ kind: 'shelf', workId: b.id }));
  $('regal-bereich').hidden = available.length === 0 || selected.length >= MAX;
  $('regal').replaceChildren(...available.map((b) => shelfEntry({
    kind: 'shelf', workId: b.id, title: b.title, authors: b.authors, cover: b.cover, count: b.count,
  })));
}

function shelfEntry(book) {
  return el('div', { class: 'eintrag regal' },
    coverImg(book.cover, true),
    el('div', { class: 'info' },
      el('div', { class: 'titel', text: book.title }),
      el('div', { class: 'neben', text: `${book.authors || ''}${book.count ? ` · ${book.count}× genannt` : ''}` }),
    ),
    el('button', { class: 'sekundaer', type: 'button', onclick: () => addBook(book), text: 'Übernehmen' }),
  );
}

async function search(q, external) {
  if (q.length < 2) return;
  lastQuery = q;
  const box = $('treffer');
  box.replaceChildren(el('div', { class: 'neben', text: 'Suche läuft …' }));
  let data;
  try {
    data = await api(`/api/search?q=${encodeURIComponent(q)}${external ? '&external=1' : ''}`);
  } catch (err) {
    box.replaceChildren(el('div', { class: 'fehler', text: err.message }));
    return;
  }
  if (q !== lastQuery) return;

  const shelf = data.shelf.filter((b) => !isSelected(b));
  const ext = data.external.filter((b) => !isSelected(b));
  const total = shelf.length + ext.length;

  const close = el('button', { class: 'textlink', type: 'button', 'aria-label': 'Suche schließen', onclick: () => box.replaceChildren(), text: 'Schließen' });
  const panel = el('div', { class: 'treffer', role: 'region', 'aria-label': 'Suchergebnisse' },
    el('div', { class: 'kopfzeile' },
      el('span', { class: 'klein', text: total ? `${total} Treffer für „${q}“ – welches Buch meinst du?` : `Keine Treffer für „${q}“.` }),
      close,
    ),
  );

  if (shelf.length) {
    panel.append(el('div', { class: 'gruppe kicker', text: 'Schon im Regal' }));
    shelf.forEach((b) => panel.append(shelfEntry(b)));
  }
  if (ext.length) {
    panel.append(el('div', { class: 'gruppe kicker', text: 'Aus der Buchsuche' }));
    ext.forEach((b) => {
      const meta = [b.year, b.publisher, b.language === 'de' ? 'Deutsch' : b.language === 'en' ? 'Englisch' : b.language].filter(Boolean).join(' · ');
      panel.append(el('div', { class: 'eintrag' },
        coverImg(b.cover, true),
        el('div', { class: 'info' },
          el('div', { class: 'titel', text: b.subtitle ? `${b.title} – ${b.subtitle}` : b.title }),
          el('div', { class: 'neben', text: [b.authors, meta].filter(Boolean).join(' · ') }),
        ),
        el('button', { class: 'sekundaer', type: 'button', onclick: () => addBook({ ...b, meta }), text: 'Auswählen' }),
      ));
    });
  }

  const fuss = el('div', { class: 'fuss' });
  if (!data.externalSearched) {
    fuss.append(el('button', { class: 'textlink', type: 'button', onclick: () => search(q, true), text: 'Nicht dabei? In der Buchsuche weitersuchen' }));
  }
  fuss.append(el('button', {
    class: 'textlink',
    type: 'button',
    onclick: () => {
      box.replaceChildren();
      $('manuell').hidden = false;
      $('m-titel').value = q;
      $('m-autor').focus();
    },
    text: 'Buch nicht gefunden? Selbst eintragen',
  }));
  panel.append(fuss);
  box.replaceChildren(panel);
}

async function submit() {
  const button = $('absenden');
  button.disabled = true;
  try {
    await api('/api/submission', {
      method: 'POST',
      body: {
        voter: voterToken(),
        books: selected.map((b) => ({
          kind: b.kind,
          workId: b.workId,
          source: b.source,
          sourceId: b.sourceId,
          title: b.title,
          subtitle: b.subtitle,
          authors: b.authors,
          year: b.year,
          publisher: b.publisher,
          language: b.language,
          cover: b.cover,
          isbn: b.isbn,
          why: b.why || '',
        })),
      },
    });
    hadSubmission = true;
    const fresh = await api(`/api/submission?voter=${encodeURIComponent(voterToken())}`);
    selected = fresh.books || selected;
    render();
    loadShelf();
    showStatus('erfolg', 'Danke! Deine Bücher stehen jetzt im Regal.', true);
  } catch (err) {
    showStatus('fehler', err.message);
  } finally {
    button.disabled = selected.length === 0;
  }
}

function showStatus(kind, text, withLink = false, scroll = true) {
  const box = el('div', { class: kind }, text);
  if (withLink) box.append(' ', el('a', { href: '/ergebnisse', text: 'Zu den Ergebnissen' }));
  $('status').replaceChildren(box);
  if (scroll) $('status').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
