// Buchsuche: zuerst im eigenen Regal (ohne externe Abfrage), dann bei Bedarf
// in Google Books, ersatzweise in Open Library.
import { db, normalize } from './db.js';
import { config } from './config.js';
import { cleanIsbn, validIsbn } from './amazon.js';

const cache = new Map(); // q -> { at, results }
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;

// Bücher, die schon im Regal stehen. Nur Werke mit mindestens einer Stimme.
export function searchShelf(query, limit = 8) {
  const terms = normalize(query).split(' ').filter((t) => t.length > 1);
  if (!terms.length) return [];
  const rows = db.prepare(`
    SELECT w.id, w.title, w.authors, w.cover, w.category,
           COUNT(DISTINCT v.voter) AS count,
           GROUP_CONCAT(e.title || ' ' || COALESCE(e.subtitle, '') || ' ' || e.authors, ' ') AS haystack
    FROM works w
    JOIN editions e ON e.work_id = w.id
    JOIN votes v ON v.edition_id = e.id
    GROUP BY w.id
  `).all();
  return rows
    .filter((r) => {
      const hay = normalize(`${r.title} ${r.authors} ${r.haystack}`);
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((r) => ({
      kind: 'shelf',
      workId: r.id,
      title: r.title,
      authors: r.authors,
      cover: r.cover,
      category: r.category,
      count: r.count,
    }));
}

export async function searchExternal(query) {
  const key = normalize(query);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.results;

  let results = [];
  let source = 'google';
  try {
    results = await searchGoogle(query);
  } catch (err) {
    console.warn('Google Books nicht erreichbar:', err.message);
  }
  if (!results.length) {
    source = 'openlibrary';
    try {
      results = await searchOpenLibrary(query);
    } catch (err) {
      console.warn('Open Library nicht erreichbar:', err.message);
    }
  }

  results = dedupe(results).slice(0, 8);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results, source });
  return results;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchGoogle(query) {
  const params = new URLSearchParams({ q: query, maxResults: '20', printType: 'books' });
  if (config.googleBooksApiKey) params.set('key', config.googleBooksApiKey);
  const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?${params}`);
  return (data.items || []).map((item) => {
    const v = item.volumeInfo || {};
    const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || null;
    return {
      kind: 'external',
      source: 'google',
      sourceId: item.id,
      title: v.title || '',
      subtitle: v.subtitle || '',
      authors: (v.authors || []).join(', '),
      year: (v.publishedDate || '').slice(0, 4),
      publisher: v.publisher || '',
      language: v.language || '',
      cover: img ? img.replace(/^http:/, 'https:').replace('&edge=curl', '') : null,
      isbn: pickIsbn(v.industryIdentifiers),
    };
  }).filter((r) => r.title);
}

function pickIsbn(identifiers = []) {
  const find = (type) => identifiers.find((i) => i.type === type)?.identifier;
  const isbn = find('ISBN_13') || find('ISBN_10');
  return isbn && validIsbn(isbn) ? cleanIsbn(isbn) : null;
}

// Einmalig beim Start: ISBN für Google-Ausgaben nachtragen, die vor der
// Amazon-Verlinkung gespeichert wurden.
export async function backfillIsbns() {
  if (!config.googleBooksApiKey) return;
  const rows = db.prepare("SELECT id, source_id FROM editions WHERE source = 'google' AND isbn IS NULL").all();
  const update = db.prepare('UPDATE editions SET isbn = ? WHERE id = ?');
  for (const row of rows) {
    try {
      const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(row.source_id)}?key=${config.googleBooksApiKey}`);
      const isbn = pickIsbn(data.volumeInfo?.industryIdentifiers);
      if (isbn) update.run(isbn, row.id);
    } catch (err) {
      console.warn(`ISBN für Ausgabe ${row.id} nicht ermittelt:`, err.message);
    }
  }
  if (rows.length) console.log(`ISBN-Nachpflege: ${rows.length} Ausgaben geprüft.`);
}

async function searchOpenLibrary(query) {
  const params = new URLSearchParams({
    q: query,
    limit: '15',
    fields: 'key,title,subtitle,author_name,first_publish_year,cover_i,language,publisher',
  });
  const ua = `KIM-Books${config.openLibraryContact ? ` (${config.openLibraryContact})` : ''}`;
  const data = await fetchJson(`https://openlibrary.org/search.json?${params}`, { 'User-Agent': ua });
  return (data.docs || []).map((d) => ({
    kind: 'external',
    source: 'openlibrary',
    sourceId: d.key,
    title: d.title || '',
    subtitle: d.subtitle || '',
    authors: (d.author_name || []).slice(0, 3).join(', '),
    year: d.first_publish_year ? String(d.first_publish_year) : '',
    publisher: (d.publisher || [])[0] || '',
    language: (d.language || []).includes('ger') ? 'de' : (d.language || [])[0] || '',
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
  })).filter((r) => r.title);
}

// Google liefert viele gleiche Ausgaben; in der Trefferliste reicht je Titel+Autor eine.
function dedupe(results) {
  const seen = new Set();
  return results.filter((r) => {
    const k = `${normalize(r.title)}|${normalize(r.subtitle)}|${normalize(r.authors)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Einfache Begrenzung pro IP, damit das Google-Kontingent nicht leerläuft.
// Die IP wird nur im Arbeitsspeicher gehalten und nicht gespeichert.
const hits = new Map();
export function rateLimited(ip, max = 40, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}
