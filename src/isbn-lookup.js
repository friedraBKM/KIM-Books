// Sucht für manuell eingetragene Bücher die ISBN, damit der Amazon-Link
// exakt auf das Buch führt. Quellen: Deutsche Nationalbibliothek, Google Books,
// Open Library. Automatisch übernommen wird nur ein eindeutiger Treffer
// (Titel und Autor stimmen exakt, genau eine ISBN). Alles andere wird dem
// Admin als Vorschlag gezeigt.
import { db, normalize, firstAuthorKey } from './db.js';
import { config } from './config.js';
import { cleanIsbn, validIsbn } from './amazon.js';
import { googleFetch } from './google-books.js';

const TIMEOUT = 8000;

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// Haupttitel ohne Untertitel, für den Vergleich ("Titel : Untertitel", "Titel - Untertitel")
const TITLE_SPLIT = /\s[:/\-–]\s|:\s/;
function mainTitle(title) {
  return normalize(String(title || '').split(TITLE_SPLIT)[0]);
}

function authorMatches(candidateAuthors, wantedKey) {
  if (!wantedKey) return true;
  return String(candidateAuthors || '').split(/[,;]| und | and /).some((a) => firstAuthorKey(a) === wantedKey);
}

async function fromDnb(title, authorKey) {
  const parts = [`tit="${title.replace(/"/g, '')}"`];
  if (authorKey) parts.push(`per=${authorKey}`);
  const query = encodeURIComponent(parts.join(' and '));
  const res = await get(`https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=${query}&recordSchema=oai_dc&maximumRecords=20`);
  const xml = await res.text();
  const records = xml.split(/<record[\s>]/).slice(1);
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const all = (block, tag) => [...block.matchAll(new RegExp(`<dc:${tag}[^>]*>([^<]*)</dc:${tag}>`, 'g'))].map((m) => decode(m[1]).trim());
  return records.flatMap((block) => {
    const fullTitle = all(block, 'title')[0] || '';
    const authors = all(block, 'creator').map((c) => c.replace(/\s*\[.*?\]\s*/g, '').split(',').reverse().join(' ').trim()).join(', ');
    const year = (all(block, 'date')[0] || '').slice(0, 4);
    const publisher = all(block, 'publisher')[0] || '';
    const isbns = [...block.matchAll(/<dc:identifier[^>]*tel:ISBN[^>]*>([^<]*)</g)]
      .map((m) => cleanIsbn(m[1].split(/\s/)[0]))
      .filter(validIsbn);
    return [...new Set(isbns)].map((isbn) => ({
      source: 'Deutsche Nationalbibliothek', title: fullTitle.split(' / ')[0], authors, year, publisher, isbn, language: 'de', cover: null,
    }));
  });
}

async function fromGoogle(title, authorKey) {
  const q = `intitle:"${title.replace(/"/g, '')}"${authorKey ? ` inauthor:${authorKey}` : ''}`;
  const data = await googleFetch('/volumes', { q, maxResults: '20', printType: 'books' });
  return (data.items || []).flatMap((item) => {
    const v = item.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const isbn = cleanIsbn((ids.find((i) => i.type === 'ISBN_13') || ids.find((i) => i.type === 'ISBN_10'))?.identifier);
    if (!validIsbn(isbn)) return [];
    const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || null;
    return [{
      source: 'Google Books', title: v.title || '', authors: (v.authors || []).join(', '),
      year: (v.publishedDate || '').slice(0, 4), publisher: v.publisher || '', isbn, language: v.language || '',
      cover: img ? img.replace(/^http:/, 'https:').replace('&edge=curl', '') : null,
    }];
  });
}

// Open Library mischt die ISBNs aller Ausgaben eines Werks. Deshalb nur als
// Vorschlag nutzbar, nie für die automatische Übernahme.
async function fromOpenLibrary(title, authorKey) {
  const params = new URLSearchParams({ title, limit: '5', fields: 'title,author_name,isbn,first_publish_year' });
  if (authorKey) params.set('author', authorKey);
  const ua = `KIM-Books${config.openLibraryContact ? ` (${config.openLibraryContact})` : ''}`;
  const data = await (await get(`https://openlibrary.org/search.json?${params}`, { 'User-Agent': ua })).json();
  return (data.docs || []).flatMap((d) => {
    const isbn = (d.isbn || []).map(cleanIsbn).find((i) => i.length === 13 && i.startsWith('9783') && validIsbn(i))
      || (d.isbn || []).map(cleanIsbn).find(validIsbn);
    if (!isbn) return [];
    return [{
      source: 'Open Library', title: d.title || '', authors: (d.author_name || []).join(', '),
      year: d.first_publish_year ? String(d.first_publish_year) : '', publisher: '', isbn, language: '', cover: null, weak: true,
    }];
  });
}

// Reine Entscheidungslogik, getrennt testbar.
export function decide(wantedTitle, wantedAuthors, candidates) {
  const t = mainTitle(wantedTitle);
  const a = firstAuthorKey(wantedAuthors);
  const matching = candidates.filter((c) => mainTitle(c.title) === t && authorMatches(c.authors, a));
  const strong = matching.filter((c) => !c.weak);
  const isbns = new Set(strong.map((c) => c.isbn));

  if (isbns.size === 1) return { status: 'auto', pick: strong[0] };

  // Vorschlag: bevorzugt DNB, dann deutsch, dann neuestes Erscheinungsjahr
  const rank = (c) => [c.weak ? 1 : 0, c.source === 'Deutsche Nationalbibliothek' ? 0 : 1, c.language === 'de' ? 0 : 1, -(Number(c.year) || 0)];
  const sorted = [...(matching.length ? matching : candidates.filter((c) => authorMatches(c.authors, a)))]
    .sort((x, y) => {
      const rx = rank(x);
      const ry = rank(y);
      for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] - ry[i];
      return 0;
    });
  if (!sorted.length) return { status: 'none', pick: null };
  return {
    status: 'suggested',
    pick: sorted[0],
    reason: matching.length ? `${isbns.size || 'mehrere'} Ausgaben gefunden` : 'Titel weicht ab',
  };
}

export async function lookupIsbn(editionId) {
  const e = db.prepare("SELECT id, title, authors FROM editions WHERE id = ? AND source = 'manual'").get(editionId);
  if (!e) return null;
  const authorKey = firstAuthorKey(e.authors);
  const title = String(e.title).split(TITLE_SPLIT)[0].trim();

  const results = await Promise.allSettled([
    fromDnb(title, authorKey),
    fromGoogle(title, authorKey),
    fromOpenLibrary(title, authorKey),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`ISBN-Suche (${['DNB', 'Google', 'Open Library'][i]}) fehlgeschlagen:`, r.reason?.message);
  });
  if (results.every((r) => r.status === 'rejected')) throw new Error('Keine Buchquelle erreichbar.');
  const candidates = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const result = decide(e.title, e.authors, candidates);

  if (result.status === 'auto') {
    const p = result.pick;
    db.prepare(`UPDATE editions SET isbn = ?, isbn_status = 'auto', isbn_suggestion = ?, language = COALESCE(language, ?), cover = COALESCE(cover, ?) WHERE id = ?`)
      .run(p.isbn, JSON.stringify(p), p.language || null, p.cover, e.id);
    db.prepare('UPDATE works SET cover = COALESCE(cover, ?) WHERE id = (SELECT work_id FROM editions WHERE id = ?)').run(p.cover, e.id);
  } else {
    db.prepare('UPDATE editions SET isbn_status = ?, isbn_suggestion = ? WHERE id = ?')
      .run(result.status, result.pick ? JSON.stringify({ ...result.pick, reason: result.reason }) : null, e.id);
  }
  return result;
}

// Beim Start: manuelle Einträge ohne bisherige Suche nachholen.
export async function lookupPending() {
  const rows = db.prepare("SELECT id FROM editions WHERE source = 'manual' AND isbn IS NULL AND isbn_status IS NULL").all();
  for (const row of rows) {
    try {
      await lookupIsbn(row.id);
    } catch (err) {
      console.warn(`ISBN-Suche für Ausgabe ${row.id} fehlgeschlagen:`, err.message);
    }
  }
  if (rows.length) console.log(`ISBN-Suche für ${rows.length} manuelle Einträge nachgeholt.`);
}
