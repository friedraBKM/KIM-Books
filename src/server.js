import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, transaction, cleanupOrphans, normalize, firstAuthorKey, backupTo } from './db.js';
import { searchShelf, searchExternal, rateLimited, backfillIsbns } from './search.js';
import { amazonLinks, cleanIsbn, validIsbn, linkForIsbn } from './amazon.js';
import { aiEnabled, aiStatus, reconcile, scheduleReconcile } from './ai.js';
import { notifyManualEntry, notifyChannels } from './notify.js';
import { lookupIsbn, lookupPending } from './isbn-lookup.js';
import { googleStatus } from './google-books.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const app = express();

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

// ---------- Zugangscode (Cookie) ----------

const ACCESS_COOKIE = 'kim_access';
const accessToken = () => crypto.createHmac('sha256', config.secret).update(`access:${config.accessCode}`).digest('hex');

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function hasAccess(req) {
  if (!config.accessCode) return true;
  const value = readCookie(req, ACCESS_COOKIE);
  return Boolean(value) && safeEqual(value, accessToken());
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireAccess(req, res, next) {
  if (hasAccess(req)) return next();
  res.status(401).json({ error: 'Zugangscode erforderlich.' });
}

app.get('/api/config', (req, res) => {
  res.json({
    codeRequired: Boolean(config.accessCode),
    hasAccess: hasAccess(req),
    maxWhyLength: config.maxWhyLength,
    privacyContact: config.privacyContact,
    amazonTag: /^[A-Za-z0-9-]{1,40}$/.test(config.amazonPartnerTag) ? config.amazonPartnerTag : '',
  });
});

app.post('/api/login', (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (rateLimited(`login:${req.ip}`, 20)) return res.status(429).json({ error: 'Zu viele Versuche. Bitte kurz warten.' });
  if (!config.accessCode || !safeEqual(code.toLowerCase(), config.accessCode.toLowerCase())) {
    return res.status(403).json({ error: 'Der Code stimmt nicht.' });
  }
  res.cookie(ACCESS_COOKIE, accessToken(), {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 180 * 24 * 3600 * 1000,
  });
  res.json({ ok: true });
});

// ---------- Suche ----------

app.get('/api/search', requireAccess, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json({ shelf: [], external: [] });
  const shelf = searchShelf(q);
  // Externe Suche nur, wenn ausdrücklich gewünscht oder im Regal kaum etwas passt.
  const wantExternal = req.query.external === '1' || shelf.length < 2;
  let external = [];
  if (wantExternal) {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'Zu viele Suchanfragen. Bitte kurz warten.' });
    external = await searchExternal(q);
  }
  res.json({ shelf, external, externalSearched: wantExternal });
});

// Beliebte Bücher zum direkten Übernehmen
app.get('/api/shelf', requireAccess, (req, res) => {
  res.json({ books: rankedWorks().slice(0, 12).map(({ whys, ...b }) => b) });
});

// ---------- Cover-Proxy ----------
// Cover werden über den eigenen Server geladen, damit die Browser der
// Teilnehmenden keine Verbindung zu Google oder Open Library aufbauen.

const COVER_HOSTS = new Set(['books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org']);
const coverDir = path.join(config.dataDir, 'covers');
fs.mkdirSync(coverDir, { recursive: true });

function allowedCover(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && COVER_HOSTS.has(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

app.get('/api/cover', requireAccess, async (req, res) => {
  const url = allowedCover(String(req.query.u || ''));
  if (!url) return res.status(400).end();
  const file = path.join(coverDir, `${crypto.createHash('sha1').update(url).digest('hex')}.img`);
  res.set('Cache-Control', 'public, max-age=604800');
  if (fs.existsSync(file)) return res.type('image/jpeg').sendFile(path.resolve(file));
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/') || !allowedCover(r.url)) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) return res.status(413).end();
    fs.writeFileSync(file, buf);
    res.type(type).send(buf);
  } catch {
    res.status(404).end();
  }
});

// ---------- Abgabe ----------

const voterHash = (token) => crypto.createHmac('sha256', config.secret).update(`voter:${token}`).digest('hex');

function validVoterToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9-]{20,80}$/.test(token);
}

app.get('/api/submission', requireAccess, (req, res) => {
  const token = String(req.query.voter || '');
  if (!validVoterToken(token)) return res.json({ books: [] });
  const rows = db.prepare(`
    SELECT v.why, e.title, e.subtitle, e.authors, e.year, e.publisher, e.source, w.id AS workId, w.title AS workTitle,
           w.authors AS workAuthors, w.cover
    FROM votes v JOIN editions e ON e.id = v.edition_id JOIN works w ON w.id = e.work_id
    WHERE v.voter = ? ORDER BY v.id
  `).all(voterHash(token));
  res.json({
    books: rows.map((r) => ({
      kind: 'shelf', workId: r.workId, title: r.workTitle, authors: r.workAuthors, cover: r.cover, why: r.why,
    })),
  });
});

function str(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Einfache Dubletten-Erkennung vor dem KI-Abgleich: gleicher Titel und gleicher Erstautor.
function findWorkByKey(title, authors) {
  const t = normalize(title);
  const a = firstAuthorKey(authors);
  if (!t) return null;
  const rows = db.prepare('SELECT e.title, e.authors, e.work_id FROM editions e').all();
  const hit = rows.find((r) => normalize(r.title) === t && (!a || firstAuthorKey(r.authors) === a));
  return hit ? hit.work_id : null;
}

app.post('/api/submission', requireAccess, (req, res) => {
  const { voter, books } = req.body || {};
  if (!validVoterToken(voter)) return res.status(400).json({ error: 'Ungültige Sitzung. Bitte Seite neu laden.' });
  if (!Array.isArray(books) || books.length < 1 || books.length > 3) {
    return res.status(400).json({ error: 'Bitte ein bis drei Bücher auswählen.' });
  }
  if (rateLimited(`submit:${req.ip}`, 30)) return res.status(429).json({ error: 'Zu viele Abgaben. Bitte kurz warten.' });

  const hash = voterHash(voter);
  const manualEntries = [];

  try {
    transaction(() => {
      db.prepare('DELETE FROM votes WHERE voter = ?').run(hash);
      const seenWorks = new Set();
      const insertWork = db.prepare('INSERT INTO works (title, authors, cover) VALUES (?, ?, ?)');
      const insertEdition = db.prepare(`
        INSERT INTO editions (source, source_id, title, subtitle, authors, year, publisher, language, cover, work_id, needs_review, merge_reason, isbn)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const findEdition = db.prepare('SELECT id, work_id FROM editions WHERE source = ? AND source_id = ?');
      const insertVote = db.prepare('INSERT INTO votes (voter, edition_id, why) VALUES (?, ?, ?)');

      for (const b of books) {
        const why = str(b?.why, config.maxWhyLength);
        let editionId;
        let workId;

        if (b?.kind === 'shelf') {
          const e = db.prepare('SELECT id, work_id FROM editions WHERE work_id = ? ORDER BY id LIMIT 1').get(Number(b.workId));
          if (!e) throw new UserError('Ein ausgewähltes Buch ist nicht mehr im Regal. Bitte neu suchen.');
          editionId = e.id;
          workId = e.work_id;
        } else {
          const manual = b?.kind === 'manual';
          const source = manual ? 'manual' : b?.source;
          if (!['google', 'openlibrary', 'manual'].includes(source)) throw new UserError('Unbekannte Buchquelle.');
          const title = str(b.title, 200);
          const authors = str(b.authors, 200);
          if (!title) throw new UserError('Bitte einen Titel angeben.');
          if (manual && !authors) throw new UserError('Bitte bei manuellen Einträgen auch den Autor angeben.');
          const sourceId = manual
            ? crypto.createHash('sha1').update(`${normalize(title)}|${normalize(authors)}`).digest('hex')
            : str(b.sourceId, 120);
          if (!sourceId) throw new UserError('Ungültiges Buch.');

          const existing = findEdition.get(source, sourceId);
          if (existing) {
            editionId = existing.id;
            workId = existing.work_id;
            if (!manual && validIsbn(b.isbn)) {
              db.prepare('UPDATE editions SET isbn = COALESCE(isbn, ?) WHERE id = ?').run(cleanIsbn(b.isbn), existing.id);
            }
          } else {
            const cover = manual ? null : allowedCover(b.cover);
            const match = findWorkByKey(title, authors);
            workId = match ?? Number(insertWork.run(title, authors, cover).lastInsertRowid);
            editionId = Number(insertEdition.run(
              source, sourceId, title, manual ? null : str(b.subtitle, 200), authors,
              manual ? null : str(b.year, 4), manual ? null : str(b.publisher, 120),
              manual ? null : str(b.language, 8), cover, workId, manual ? 1 : 0,
              match ? 'Gleicher Titel und Autor (automatisch)' : null,
              !manual && validIsbn(b.isbn) ? cleanIsbn(b.isbn) : null,
            ).lastInsertRowid);
            if (manual) manualEntries.push({ id: editionId, title, authors });
          }
        }

        if (seenWorks.has(workId)) throw new UserError('Du hast dasselbe Buch mehrfach ausgewählt.');
        seenWorks.add(workId);
        insertVote.run(hash, editionId, why);
      }
      db.exec(`UPDATE works SET cover = COALESCE(cover, (SELECT e.cover FROM editions e WHERE e.work_id = works.id AND e.cover IS NOT NULL LIMIT 1))`);
      cleanupOrphans();
    });
  } catch (err) {
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Speichern fehlgeschlagen.' });
  }

  // ISBN suchen, danach den Admin informieren (mit Ergebnis der Suche)
  for (const entry of manualEntries) {
    lookupIsbn(entry.id)
      .then((result) => notifyManualEntry({ ...entry, lookup: result }))
      .catch((err) => {
        console.warn('ISBN-Suche fehlgeschlagen:', err.message);
        notifyManualEntry(entry);
      });
  }
  scheduleReconcile();
  res.json({ ok: true });
});

class UserError extends Error {}

// ---------- Ergebnisse ----------

function rankedWorks() {
  const works = db.prepare(`
    SELECT w.id, w.title, w.authors, w.cover, w.category, COUNT(DISTINCT v.voter) AS count
    FROM works w JOIN editions e ON e.work_id = w.id JOIN votes v ON v.edition_id = e.id
    GROUP BY w.id
    ORDER BY count DESC, w.title COLLATE NOCASE ASC
  `).all();
  const whys = db.prepare(`
    SELECT e.work_id, v.why FROM votes v JOIN editions e ON e.id = v.edition_id
    WHERE v.why <> '' AND v.why_status IN ('new', 'ok') ORDER BY v.id DESC
  `).all();
  const byWork = new Map();
  for (const w of whys) {
    if (!byWork.has(w.work_id)) byWork.set(w.work_id, []);
    byWork.get(w.work_id).push(w.why);
  }
  const links = amazonLinks();
  let rank = 0;
  let lastCount = null;
  return works.map((w, i) => {
    if (w.count !== lastCount) {
      rank = i + 1;
      lastCount = w.count;
    }
    return { ...w, rank, whys: byWork.get(w.id) || [], amazon: links.get(w.id) };
  });
}

app.get('/api/results', requireAccess, (req, res) => {
  const books = rankedWorks();
  const stats = db.prepare('SELECT COUNT(DISTINCT voter) AS participants, COUNT(*) AS nominations FROM votes').get();
  const categories = [...new Set(books.map((b) => b.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  res.json({
    stats: { participants: stats.participants, nominations: stats.nominations, books: books.length },
    categories,
    books,
  });
});

// ---------- Admin ----------

function requireAdmin(req, res, next) {
  if (!config.adminPassword) return res.status(503).send('Admin-Bereich ist nicht eingerichtet (ADMIN_PASSWORD fehlt).');
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === 'admin' && safeEqual(rest.join(':'), config.adminPassword)) return next();
  }
  if (rateLimited(`admin:${req.ip}`, 30)) return res.status(429).send('Zu viele Versuche.');
  res.set('WWW-Authenticate', 'Basic realm="Must-Read-Regal Admin", charset="UTF-8"').status(401).send('Anmeldung erforderlich.');
}

app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(root, 'views', 'admin.html')));
app.use('/api/admin', requireAdmin);

app.get('/api/admin/overview', (req, res) => {
  const counts = new Map(rankedWorks().map((w) => [w.id, w.count]));
  const links = amazonLinks();
  const works = db.prepare('SELECT id, title, authors, category, category_locked, isbn_override FROM works ORDER BY title COLLATE NOCASE').all()
    .map((w) => ({ ...w, count: counts.get(w.id) || 0, amazon: links.get(w.id) }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'de'));
  const editions = db.prepare(`
    SELECT e.id, e.title, e.subtitle, e.authors, e.year, e.language, e.source, e.merge_reason, e.needs_review, e.separated,
           e.isbn, e.isbn_status, e.isbn_suggestion,
           e.work_id, w.title AS work_title, w.authors AS work_authors,
           (SELECT COUNT(*) FROM votes v WHERE v.edition_id = e.id) AS votes,
           (SELECT COUNT(*) FROM editions x WHERE x.work_id = e.work_id) AS siblings
    FROM editions e JOIN works w ON w.id = e.work_id
    ORDER BY w.title COLLATE NOCASE, e.id
  `).all();
  const flagged = db.prepare(`
    SELECT v.id, v.why, v.why_note, w.title AS work_title FROM votes v
    JOIN editions e ON e.id = v.edition_id JOIN works w ON w.id = e.work_id
    WHERE v.why_status = 'flagged' ORDER BY v.id
  `).all();
  res.json({
    ai: aiStatus(),
    notify: notifyChannels(),
    warnings: config.secretIsRandom ? ['APP_SECRET ist nicht gesetzt. Nach einem Neustart müssen alle den Zugangscode neu eingeben und können ihre Auswahl nicht mehr ändern.'] : [],
    review: editions
      .filter((e) => e.needs_review || e.isbn_status === 'suggested' || e.isbn_status === 'auto')
      .map((e) => {
        const suggestion = e.isbn_suggestion ? JSON.parse(e.isbn_suggestion) : null;
        return {
          ...e,
          isbn_suggestion: suggestion,
          suggestionLink: suggestion?.isbn ? linkForIsbn(suggestion.isbn)?.url : null,
          isbnLink: e.isbn ? linkForIsbn(e.isbn)?.url : null,
        };
      }),
    merges: editions.filter((e) => e.siblings > 1),
    works,
    categories: [...new Set(works.map((w) => w.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')),
    flagged,
  });
});

app.get('/api/admin/google-status', async (req, res) => {
  res.json(await googleStatus(req.query.force === '1'));
});

app.post('/api/admin/reconcile', async (req, res) => {
  if (!aiEnabled()) return res.status(400).json({ error: 'Kein ANTHROPIC_API_KEY gesetzt.' });
  try {
    res.json(await reconcile());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/editions/:id/separate', (req, res) => {
  const id = Number(req.params.id);
  transaction(() => {
    const e = db.prepare('SELECT * FROM editions WHERE id = ?').get(id);
    if (!e) return;
    const work = db.prepare('SELECT category FROM works WHERE id = ?').get(e.work_id);
    const newWork = Number(db.prepare('INSERT INTO works (title, authors, cover, category) VALUES (?, ?, ?, ?)')
      .run(e.title, e.authors, e.cover, work?.category ?? null).lastInsertRowid);
    db.prepare('UPDATE editions SET work_id = ?, separated = 1, merge_reason = NULL WHERE id = ?').run(newWork, id);
    cleanupOrphans();
  });
  res.json({ ok: true });
});

app.post('/api/admin/editions/:id/review', (req, res) => {
  const id = Number(req.params.id);
  const title = str(req.body?.title, 200);
  const authors = str(req.body?.authors, 200);
  transaction(() => {
    const e = db.prepare('SELECT * FROM editions WHERE id = ?').get(id);
    if (!e) return;
    if (title && (title !== e.title || (authors && authors !== e.authors))) {
      // Geänderter Titel: ISBN neu suchen, außer sie wurde bereits bestätigt
      if (e.source === 'manual' && e.isbn_status !== 'confirmed') {
        db.prepare('UPDATE editions SET isbn = NULL, isbn_status = NULL, isbn_suggestion = NULL WHERE id = ?').run(id);
        setImmediate(() => lookupIsbn(id).catch((err) => console.warn('ISBN-Suche fehlgeschlagen:', err.message)));
      }
    }
    if (title) {
      db.prepare('UPDATE editions SET title = ?, authors = ? WHERE id = ?').run(title, authors || e.authors, id);
      const siblings = db.prepare('SELECT COUNT(*) AS n FROM editions WHERE work_id = ?').get(e.work_id).n;
      if (siblings === 1) db.prepare('UPDATE works SET title = ?, authors = ? WHERE id = ?').run(title, authors || e.authors, e.work_id);
    }
    db.prepare('UPDATE editions SET needs_review = 0 WHERE id = ?').run(id);
  });
  scheduleReconcile();
  res.json({ ok: true });
});

// Vorschlag der ISBN-Suche übernehmen oder verwerfen, oder neu suchen
app.post('/api/admin/editions/:id/isbn', async (req, res) => {
  const id = Number(req.params.id);
  const action = req.body?.action;
  if (action === 'accept') {
    const row = db.prepare('SELECT isbn_suggestion FROM editions WHERE id = ?').get(id);
    const s = row?.isbn_suggestion ? JSON.parse(row.isbn_suggestion) : null;
    if (!s?.isbn) return res.status(400).json({ error: 'Kein Vorschlag vorhanden.' });
    db.prepare("UPDATE editions SET isbn = ?, isbn_status = 'confirmed', language = COALESCE(language, ?), cover = COALESCE(cover, ?) WHERE id = ?")
      .run(s.isbn, s.language || null, s.cover || null, id);
    db.prepare('UPDATE works SET cover = COALESCE(cover, ?) WHERE id = (SELECT work_id FROM editions WHERE id = ?)').run(s.cover || null, id);
  } else if (action === 'reject') {
    db.prepare("UPDATE editions SET isbn = NULL, isbn_status = 'rejected' WHERE id = ?").run(id);
  } else if (action === 'retry') {
    try {
      await lookupIsbn(id);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  } else {
    return res.status(400).json({ error: 'Unbekannte Aktion.' });
  }
  res.json({ ok: true });
});

app.delete('/api/admin/editions/:id', (req, res) => {
  transaction(() => {
    db.prepare('DELETE FROM votes WHERE edition_id = ?').run(Number(req.params.id));
    cleanupOrphans();
  });
  res.json({ ok: true });
});

app.post('/api/admin/works/:id/category', (req, res) => {
  const category = str(req.body?.category, 60);
  if (!category) return res.status(400).json({ error: 'Kategorie fehlt.' });
  db.prepare('UPDATE works SET category = ?, category_locked = 1 WHERE id = ?').run(category, Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/works/:id/isbn', (req, res) => {
  const raw = cleanIsbn(req.body?.isbn);
  if (raw && !linkForIsbn(raw)) return res.status(400).json({ error: 'Das ist keine gültige ISBN (10 oder 13 Stellen, Prüfziffer prüfen).' });
  db.prepare('UPDATE works SET isbn_override = ? WHERE id = ?').run(raw || null, Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/admin/works/:id', (req, res) => {
  transaction(() => {
    db.prepare('DELETE FROM votes WHERE edition_id IN (SELECT id FROM editions WHERE work_id = ?)').run(Number(req.params.id));
    cleanupOrphans();
  });
  res.json({ ok: true });
});

app.post('/api/admin/votes/:id/why', (req, res) => {
  const status = req.body?.status === 'ok' ? 'ok' : 'hidden';
  db.prepare('UPDATE votes SET why_status = ? WHERE id = ?').run(status, Number(req.params.id));
  res.json({ ok: true });
});

// Vollständige Kopie der Datenbank zum Herunterladen (Sicherung außerhalb des Servers)
app.get('/api/admin/backup.sqlite', (req, res) => {
  const file = path.join(config.dataDir, `download-${Date.now()}.sqlite`);
  try {
    backupTo(file);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    res.download(file, `must-read-regal-${stamp}.sqlite`, () => fs.rm(file, { force: true }, () => {}));
  } catch (err) {
    fs.rm(file, { force: true }, () => {});
    res.status(500).send(`Sicherung fehlgeschlagen: ${err.message}`);
  }
});

app.get('/api/admin/export.csv', (req, res) => {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Rang', 'Titel', 'Autoren', 'Kategorie', 'Nennungen', 'Amazon', 'Warum-Sätze'].map(esc).join(';')];
  for (const w of rankedWorks()) {
    lines.push([w.rank, w.title, w.authors, w.category, w.count, w.amazon?.url, w.whys.join(' | ')].map(esc).join(';'));
  }
  res.set('Content-Disposition', 'attachment; filename="must-read-regal.csv"');
  res.type('text/csv; charset=utf-8').send(`﻿${lines.join('\r\n')}\r\n`);
});

// ---------- Seiten ----------

app.get('/healthz', (req, res) => res.json({ ok: true }));

const fontDir = (pkg) => path.join(root, 'node_modules', '@fontsource', pkg, 'files');
app.use('/fonts', express.static(fontDir('inter'), { maxAge: '30d', immutable: true }));
app.use('/fonts', express.static(fontDir('bebas-neue'), { maxAge: '30d', immutable: true }));

const page = (file) => (req, res) => res.sendFile(path.join(root, 'views', file));
app.get('/', page('index.html'));
app.get('/ergebnisse', page('ergebnisse.html'));
app.get('/datenschutz', page('datenschutz.html'));
app.use(express.static(path.join(root, 'public'), { index: false, maxAge: '1h' }));

app.listen(config.port, () => {
  console.log(`Must-Read-Regal läuft auf Port ${config.port}`);
  const n = db.prepare('SELECT COUNT(DISTINCT voter) AS p, COUNT(*) AS v FROM votes').get();
  console.log(`Datenbestand: ${n.p} Teilnehmende, ${n.v} Nennungen (Datei: ${path.resolve(config.dataDir)})`);
  if (config.secretIsRandom) console.warn('Hinweis: APP_SECRET ist nicht gesetzt.');
  if (!config.adminPassword) console.warn('Hinweis: ADMIN_PASSWORD ist nicht gesetzt, Admin-Bereich gesperrt.');
  if (!aiEnabled()) console.warn('Hinweis: ANTHROPIC_API_KEY fehlt, KI-Abgleich ist aus.');
  backfillIsbns().catch((err) => console.warn('ISBN-Nachpflege fehlgeschlagen:', err.message));
  lookupPending().catch((err) => console.warn('ISBN-Suche beim Start fehlgeschlagen:', err.message));
});
