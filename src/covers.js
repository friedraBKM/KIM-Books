// Buchcover: erlaubte Quellen für den Cover-Proxy und Suche eines Covers zur ISBN.
import { db } from './db.js';
import { googleFetch } from './google-books.js';
import { cleanIsbn, validIsbn, bestIsbnByWork } from './amazon.js';

// Hosts, von denen Cover geladen werden dürfen (auch Weiterleitungsziele)
const HOSTS = ['books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org', 'portal.dnb.de'];
const REDIRECT_SUFFIXES = ['.archive.org'];

export function allowedCover(url, { redirect = false } = {}) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (HOSTS.includes(u.hostname)) return u.toString();
    if (redirect && REDIRECT_SUFFIXES.some((s) => u.hostname.endsWith(s))) return u.toString();
    return null;
  } catch {
    return null;
  }
}

// Prüft, ob unter der Adresse ein echtes Bild liegt (keine Platzhalter-Grafik)
async function isRealImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) return false;
    if (!allowedCover(res.url, { redirect: true })) return false;
    const size = (await res.arrayBuffer()).byteLength;
    return size > 2000;
  } catch {
    return false;
  }
}

export async function findCoverForIsbn(isbnRaw) {
  const isbn = cleanIsbn(isbnRaw);
  if (!validIsbn(isbn)) return null;
  const candidates = [
    `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`,
    `https://portal.dnb.de/opac/mvb/cover?isbn=${isbn}`,
  ];
  for (const url of candidates) {
    if (await isRealImage(url)) return url;
  }
  try {
    const data = await googleFetch('/volumes', { q: `isbn:${isbn}`, maxResults: '1' });
    const img = data.items?.[0]?.volumeInfo?.imageLinks;
    const url = img?.thumbnail || img?.smallThumbnail;
    if (url) return url.replace(/^http:/, 'https:').replace('&edge=curl', '');
  } catch { /* Google nicht erreichbar */ }
  return null;
}

// Cover für ein Werk nachholen, wenn es keins hat. Gibt true zurück, wenn eins gefunden wurde.
export async function refreshCover(workId, { force = false } = {}) {
  const work = db.prepare('SELECT id, cover FROM works WHERE id = ?').get(workId);
  if (!work || (work.cover && !force)) return false;
  const isbn = bestIsbnByWork().get(workId);
  if (!isbn) return false;
  const url = await findCoverForIsbn(isbn);
  if (!url) return false;
  db.prepare('UPDATE works SET cover = ? WHERE id = ?').run(url, workId);
  return true;
}
