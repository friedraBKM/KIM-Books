import { el, api } from './common.js';

const $ = (id) => document.getElementById(id);

load();
$('ki-start').addEventListener('click', runAi);

async function load() {
  let d;
  try {
    d = await api('/api/admin/overview');
  } catch (err) {
    message('fehler', err.message);
    return;
  }
  renderAi(d.ai, d.notify);
  $('warnungen').replaceChildren(...d.warnings.map((w) => el('div', { class: 'fehler', text: w })));
  renderReview(d.review);
  renderMerges(d.merges);
  renderWorks(d.works, d.categories);
  renderFlagged(d.flagged);
}

function message(kind, text) {
  $('meldung').replaceChildren(text ? el('div', { class: kind, text }) : '');
}

function fmt(iso) {
  if (!iso) return 'noch nie';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function renderAi(ai, notify) {
  if (!ai.enabled) {
    $('ki-titel').textContent = 'KI-Abgleich ist aus';
    $('ki-text').textContent = 'Es ist kein ANTHROPIC_API_KEY hinterlegt. Gleiche Titel werden trotzdem einfach zusammengelegt, Kategorien fehlen aber.';
    $('ki-start').disabled = true;
  } else {
    $('ki-titel').textContent = ai.running ? 'Abgleich läuft gerade …' : 'Läuft automatisch nach neuen Abgaben';
    const s = ai.lastSummary;
    $('ki-text').textContent = [
      `Letzter Lauf: ${fmt(ai.lastRun)}`,
      s ? `${s.merged} Zuordnungen geändert, ${s.flagged} Sätze markiert` : null,
      `Modell: ${ai.model}`,
      ai.lastError ? `Letzter Fehler: ${ai.lastError}` : null,
    ].filter(Boolean).join(' · ');
    $('ki-start').disabled = ai.running;
  }
  const channels = [notify.email ? 'E-Mail' : null, notify.webhook ? 'Webhook' : null].filter(Boolean);
  $('ki-text').append(el('br'), channels.length
    ? `Benachrichtigung bei manuellen Einträgen: ${channels.join(' und ')}`
    : 'Benachrichtigung bei manuellen Einträgen ist nicht eingerichtet – neue Einträge erscheinen nur hier.');
}

async function runAi() {
  $('ki-start').disabled = true;
  $('ki-titel').textContent = 'Abgleich läuft gerade … (kann eine Minute dauern)';
  try {
    const r = await api('/api/admin/reconcile', { method: 'POST' });
    message('erfolg', r.queued ? 'Ein Abgleich läuft bereits; danach folgt einer mit den neuesten Daten.' : 'Abgleich abgeschlossen.');
  } catch (err) {
    message('fehler', `Abgleich fehlgeschlagen: ${err.message}`);
  }
  load();
}

async function act(fn, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return;
  try {
    await fn();
    message('', '');
  } catch (err) {
    message('fehler', err.message);
  }
  load();
}

function table(headers, rows, emptyText) {
  if (!rows.length) return el('div', { class: 'leer-hinweis', text: emptyText });
  return el('table', {},
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))),
    el('tbody', {}, ...rows),
  );
}

function isbnCell(e) {
  const s = e.isbn_suggestion;
  const isbnAct = (action) => () => act(() => api(`/api/admin/editions/${e.id}/isbn`, { method: 'POST', body: { action } }));
  const check = (url) => (url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'bei Amazon prüfen' }) : null);
  const describe = (x) => `${x.title}${x.authors ? ` – ${x.authors}` : ''}${x.publisher ? `, ${x.publisher}` : ''}${x.year ? ` ${x.year}` : ''} (ISBN ${x.isbn}, ${x.source})`;

  if (e.source !== 'manual') return el('td', { class: 'neben', text: '–' });
  if (e.isbn_status === 'auto' || e.isbn_status === 'confirmed') {
    return el('td', {},
      el('div', { text: `${e.isbn_status === 'auto' ? 'Automatisch verknüpft' : 'Bestätigt'}: ${s ? describe(s) : e.isbn}` }),
      el('div', { class: 'knoepfe' }, check(e.isbnLink), el('button', { class: 'textlink', type: 'button', text: 'Verwerfen', onclick: isbnAct('reject') })),
    );
  }
  if (e.isbn_status === 'suggested' && s) {
    return el('td', {},
      el('div', { text: `Vorschlag: ${describe(s)}` }),
      s.reason ? el('div', { class: 'neben klein', text: s.reason }) : null,
      el('div', { class: 'knoepfe' },
        check(e.suggestionLink),
        el('button', { class: 'voll', type: 'button', text: 'Übernehmen', onclick: isbnAct('accept') }),
        el('button', { class: 'textlink', type: 'button', text: 'Verwerfen', onclick: isbnAct('reject') }),
      ),
    );
  }
  return el('td', {},
    el('div', { class: 'neben', text: e.isbn_status === 'rejected' ? 'Vorschlag verworfen – Link führt zur Amazon-Suche' : e.isbn_status ? 'Keine ISBN gefunden – Link führt zur Amazon-Suche' : 'Noch nicht gesucht (Quelle nicht erreichbar)' }),
    el('button', { class: 'textlink', type: 'button', text: 'Erneut suchen', onclick: isbnAct('retry') }),
  );
}

function renderReview(items) {
  $('pruefen').replaceChildren(table(['Titel', 'Autor', 'Zugeordnet zu', 'Stimmen', 'Amazon-Link', ''], items.map((e) => {
    const title = el('input', { type: 'text', 'aria-label': 'Titel', maxlength: '200' });
    title.value = e.title;
    const authors = el('input', { type: 'text', 'aria-label': 'Autor', maxlength: '200' });
    authors.value = e.authors;
    return el('tr', {},
      el('td', {}, title),
      el('td', {}, authors),
      el('td', { text: e.siblings > 1 ? `${e.work_title} (mit ${e.siblings - 1} weiteren Ausgaben)` : 'noch eigenständig' }),
      el('td', { text: String(e.votes) }),
      isbnCell(e),
      el('td', {}, e.needs_review ? el('div', { class: 'knoepfe' },
        el('button', {
          class: 'voll', type: 'button', text: 'Bestätigen',
          onclick: () => act(() => api(`/api/admin/editions/${e.id}/review`, { method: 'POST', body: { title: title.value, authors: authors.value } })),
        }),
        el('button', {
          class: 'textlink', type: 'button', text: 'Löschen',
          onclick: () => act(() => api(`/api/admin/editions/${e.id}`, { method: 'DELETE' }), `„${e.title}“ samt Stimmen löschen?`),
        }),
      ) : el('span', { class: 'neben klein', text: 'Eintrag bestätigt' })),
    );
  }), 'Nichts zu prüfen.'));
}

function renderMerges(editions) {
  $('zusammengefuehrt').replaceChildren(table(['Zusammengeführt zu', 'Ausgabe', 'Begründung der KI', ''], editions.map((e) => el('tr', {},
    el('td', { class: 'titel', text: e.work_title }),
    el('td', { text: [e.subtitle ? `${e.title} – ${e.subtitle}` : e.title, e.authors, e.year, e.language].filter(Boolean).join(' · ') }),
    el('td', { class: 'neben', text: e.merge_reason || '–' }),
    el('td', {}, el('button', {
      class: 'sekundaer', type: 'button', text: 'Trennen',
      onclick: () => act(() => api(`/api/admin/editions/${e.id}/separate`, { method: 'POST' })),
    })),
  )), 'Bisher wurde nichts zusammengeführt.'));
}

function renderWorks(works, categories) {
  $('werke').replaceChildren(table(['Titel', 'Nennungen', 'Kategorie', 'Amazon', ''], works.map((w) => {
    const select = el('select', { 'aria-label': `Kategorie für ${w.title}` },
      el('option', { value: '', text: w.category ? '' : '– noch keine –' }),
      ...categories.map((c) => el('option', { value: c, text: c })),
      el('option', { value: '__neu', text: 'Neue Kategorie …' }),
    );
    select.value = w.category || '';
    select.addEventListener('change', () => {
      let value = select.value;
      if (value === '__neu') value = (window.prompt('Name der neuen Kategorie:') || '').trim();
      if (!value) { select.value = w.category || ''; return; }
      act(() => api(`/api/admin/works/${w.id}/category`, { method: 'POST', body: { category: value } }));
    });
    const isbn = el('input', { type: 'text', 'aria-label': `ISBN für ${w.title}`, placeholder: 'ISBN', maxlength: '17', inputmode: 'numeric' });
    isbn.value = w.isbn_override || '';
    return el('tr', {},
      el('td', { class: 'titel' }, w.title, el('div', { class: 'neben', text: w.authors })),
      el('td', { text: String(w.count) }),
      el('td', {}, select, w.category_locked ? el('div', { class: 'neben klein', text: 'von dir festgelegt' }) : null),
      el('td', {},
        w.amazon ? el('a', { href: w.amazon.url, target: '_blank', rel: 'noopener noreferrer', text: w.amazon.exact ? 'prüfen' : 'nur Suche – prüfen' }) : null,
        el('div', { class: 'knoepfe' }, isbn, el('button', {
          class: 'sekundaer', type: 'button', text: 'Speichern',
          onclick: () => act(() => api(`/api/admin/works/${w.id}/isbn`, { method: 'POST', body: { isbn: isbn.value } })),
        })),
      ),
      el('td', {}, el('button', {
        class: 'textlink', type: 'button', text: 'Löschen',
        onclick: () => act(() => api(`/api/admin/works/${w.id}`, { method: 'DELETE' }), `„${w.title}“ mit allen Stimmen löschen?`),
      })),
    );
  }), 'Noch keine Bücher.'));
}

function renderFlagged(items) {
  $('saetze').replaceChildren(table(['Buch', 'Satz', 'Hinweis der KI', ''], items.map((v) => el('tr', {},
    el('td', { class: 'titel', text: v.work_title }),
    el('td', { text: `„${v.why}“` }),
    el('td', { class: 'neben', text: v.why_note || '' }),
    el('td', {}, el('div', { class: 'knoepfe' },
      el('button', { class: 'sekundaer', type: 'button', text: 'Freigeben', onclick: () => act(() => api(`/api/admin/votes/${v.id}/why`, { method: 'POST', body: { status: 'ok' } })) }),
      el('button', { class: 'textlink', type: 'button', text: 'Ausblenden', onclick: () => act(() => api(`/api/admin/votes/${v.id}/why`, { method: 'POST', body: { status: 'hidden' } })) }),
    )),
  )), 'Keine markierten Sätze.'));
}
