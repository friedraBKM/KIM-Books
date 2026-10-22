// Zugriff auf die Google Books API mit Wiederholung bei kurzen Störungen
// und einem Status für den Admin-Bereich.
import { config } from './config.js';

const BASE = 'https://www.googleapis.com/books/v1';

export class GoogleError extends Error {
  constructor(status, reason, message) {
    super(`HTTP ${status}${reason ? ` (${reason})` : ''}: ${message}`);
    this.status = status;
    this.reason = reason;
    this.googleMessage = message;
  }
}

const state = { lastOkAt: null, lastError: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// path z. B. "/volumes" oder "/volumes/abc"; params ohne Key
export async function googleFetch(path, params = {}) {
  const search = new URLSearchParams(params);
  if (config.googleBooksApiKey) search.set('key', config.googleBooksApiKey);
  const url = `${BASE}${path}?${search}`;

  let lastErr;
  for (const wait of [0, 700, 1500]) {
    if (wait) await sleep(wait);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        state.lastOkAt = new Date().toISOString();
        return await res.json();
      }
      let body = null;
      try { body = await res.json(); } catch { /* kein JSON */ }
      const first = body?.error?.errors?.[0] || {};
      const detail = body?.error?.details?.find((d) => d.reason)?.reason;
      lastErr = new GoogleError(res.status, first.reason || detail || '', body?.error?.message || res.statusText);
      // Nur Störungen auf Google-Seite wiederholen, keine Fehler beim Key
      if (res.status < 500) break;
    } catch (err) {
      lastErr = err instanceof GoogleError ? err : new GoogleError(0, 'network', err.message);
    }
  }
  state.lastError = { at: new Date().toISOString(), text: describeGoogleError(lastErr) };
  throw lastErr;
}

export function describeGoogleError(err) {
  const reason = String(err?.reason || '');
  const msg = String(err?.googleMessage || err?.message || '');
  if (err?.status === 0) return 'Keine Verbindung zu Google (Netzwerk oder Zeitüberschreitung).';
  if (err?.status >= 500) return `Störung bei Google (HTTP ${err.status}). Liegt nicht an deinem Key – später erneut testen.`;
  if (err?.status === 429 || /rateLimit|quota/i.test(reason + msg)) return 'Tageskontingent der Books API erschöpft. Morgen geht es wieder, oder in der Google Cloud Console mehr Kontingent beantragen.';
  if (/keyInvalid|API_KEY_INVALID|key not valid/i.test(reason + msg)) return 'Der Key ist ungültig. Bitte in Coolify prüfen (vollständig kopiert, keine Leerzeichen).';
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used|disabled/i.test(reason + msg)) return 'Die Books API ist im Google-Projekt nicht aktiviert (APIs & Services → Library → Books API → Enable).';
  if (/referer|REFERRER|ipRefererBlocked|API_KEY_HTTP_REFERRER_BLOCKED|IP address/i.test(reason + msg)) return 'Der Key ist auf Websites oder andere IP-Adressen beschränkt. In der Google Cloud Console bei „Application restrictions“ auf „None“ oder die Server-IP umstellen.';
  if (/API_KEY_SERVICE_BLOCKED|blocked/i.test(reason + msg)) return 'Der Key darf die Books API nicht nutzen. Bei „API restrictions“ die Books API zulassen.';
  return `Fehler von Google: ${msg || `HTTP ${err?.status}`}`;
}

let lastTest = null;

export async function googleStatus(force = false) {
  if (!config.googleBooksApiKey) {
    return { configured: false, ok: false, text: 'Kein GOOGLE_BOOKS_API_KEY eingetragen. Die Buchsuche nutzt nur Open Library (ohne ISBN, daher keine direkten Amazon-Links).' };
  }
  if (!force && lastTest && Date.now() - lastTest.time < 60 * 1000) return lastTest.result;
  let result;
  try {
    const data = await googleFetch('/volumes', { q: 'kahneman', maxResults: '1' });
    result = { configured: true, ok: true, text: `Funktioniert (Testabfrage: ${data.totalItems ?? 0} Treffer).` };
  } catch (err) {
    result = { configured: true, ok: false, text: describeGoogleError(err) };
  }
  result.checkedAt = new Date().toISOString();
  result.lastOkAt = state.lastOkAt;
  result.lastError = state.lastError;
  lastTest = { time: Date.now(), result };
  return result;
}
