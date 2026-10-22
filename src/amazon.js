// Amazon-Links: exakt über die ISBN (ISBN-10 = Amazon-Produktnummer bei Büchern),
// sonst eine Amazon-Suche. Der Partner-Tag wird erst im Browser angehängt.
import { db } from './db.js';

const BASE = 'https://www.amazon.de';

export function cleanIsbn(value) {
  return String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
}

export function validIsbn(value) {
  const isbn = cleanIsbn(value);
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((s, c, i) => s + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(isbn)) {
    const sum = [...isbn].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0;
  }
  return false;
}

// Nur ISBN-13 mit Präfix 978 lässt sich in eine ISBN-10 umrechnen.
export function isbn13to10(isbn13) {
  const isbn = cleanIsbn(isbn13);
  if (!/^978\d{10}$/.test(isbn)) return null;
  const core = isbn.slice(3, 12);
  const sum = [...core].reduce((s, c, i) => s + Number(c) * (10 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : String(check));
}

export function linkForIsbn(isbn) {
  const clean = cleanIsbn(isbn);
  if (!validIsbn(clean)) return null;
  const isbn10 = clean.length === 10 ? clean : isbn13to10(clean);
  if (isbn10) return { url: `${BASE}/dp/${isbn10}`, exact: true };
  // 979er-ISBN: keine ISBN-10, Amazon-Suche nach der ISBN trifft in der Regel genau das Buch
  return { url: `${BASE}/s?k=${clean}&i=stripbooks`, exact: false };
}

export function searchLink(title, authors) {
  const q = [title, String(authors || '').split(',')[0]].filter(Boolean).join(' ');
  return { url: `${BASE}/s?k=${encodeURIComponent(q)}&i=stripbooks`, exact: false };
}

// Wählt für jedes Werk die beste ISBN: vom Admin gesetzte ISBN, sonst die
// deutsche Ausgabe mit den meisten Nennungen, sonst die meistgenannte mit ISBN.
export function bestIsbnByWork() {
  const works = db.prepare('SELECT id, isbn_override FROM works').all();
  const editions = db.prepare(`
    SELECT e.work_id, e.isbn, e.language, COUNT(v.id) AS votes
    FROM editions e LEFT JOIN votes v ON v.edition_id = e.id
    WHERE e.isbn IS NOT NULL
    GROUP BY e.id
    ORDER BY (e.language = 'de') DESC, votes DESC, e.id ASC
  `).all();
  const best = new Map();
  for (const e of editions) if (!best.has(e.work_id)) best.set(e.work_id, e.isbn);
  const result = new Map();
  for (const w of works) {
    const isbn = w.isbn_override || best.get(w.id);
    if (isbn) result.set(w.id, isbn);
  }
  return result;
}

export function amazonLinks() {
  const works = db.prepare('SELECT id, title, authors FROM works').all();
  const isbns = bestIsbnByWork();
  const result = new Map();
  for (const w of works) {
    const isbn = isbns.get(w.id);
    result.set(w.id, (isbn && linkForIsbn(isbn)) || searchLink(w.title, w.authors));
  }
  return result;
}
