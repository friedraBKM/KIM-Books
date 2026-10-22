// Prüft die ISBN-Suche für manuelle Einträge mit nachgestellten Antworten der Buchquellen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-isbn-'));
process.env.GOOGLE_BOOKS_API_KEY = '';
const { db } = await import('../src/db.js');
const { decide, lookupIsbn } = await import('../src/isbn-lookup.js');

const dnbXml = (records) => `<?xml version="1.0"?><searchRetrieveResponse><records>${records.map((r) => `
<record><recordData><dc xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${r.title}</dc:title><dc:creator>${r.creator}</dc:creator>
<dc:publisher>München : Goldmann</dc:publisher><dc:date>${r.year}</dc:date>
<dc:identifier xsi:type="tel:ISBN">${r.isbn} kart. : EUR 20.00 (DE)</dc:identifier>
</dc></recordData></record>`).join('')}</records></searchRetrieveResponse>`;

function stubFetch({ dnb = [], google = [], ol = [] }) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (body) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes('dnb.de')) return { ok: true, text: async () => dnbXml(dnb) };
    if (u.includes('googleapis')) return json({ items: google });
    if (u.includes('openlibrary')) return json({ docs: ol });
    throw new Error('unerwartet');
  };
}

function manual(title, authors) {
  const w = Number(db.prepare('INSERT INTO works (title, authors) VALUES (?, ?)').run(title, authors).lastInsertRowid);
  return Number(db.prepare("INSERT INTO editions (source, source_id, title, authors, work_id, needs_review) VALUES ('manual', ?, ?, ?, ?, 1)")
    .run(`${title}|${Math.random()}`, title, authors, w).lastInsertRowid);
}

test('eindeutiger Treffer der Nationalbibliothek wird automatisch übernommen', async () => {
  stubFetch({ dnb: [{ title: 'Die 1%-Methode - Minimale Veränderung, maximale Wirkung : mit kleinen Gewohnheiten / James Clear', creator: 'Clear, James [Verfasser]', year: '2020', isbn: '978-3-442-17858-2' }] });
  const id = manual('Die 1%-Methode', 'James Clear');
  const r = await lookupIsbn(id);
  assert.equal(r.status, 'auto');
  const e = db.prepare('SELECT isbn, isbn_status FROM editions WHERE id = ?').get(id);
  assert.deepEqual({ ...e }, { isbn: '9783442178582', isbn_status: 'auto' });
});

test('mehrere Ausgaben ergeben nur einen Vorschlag, keine automatische Verknüpfung', async () => {
  stubFetch({ dnb: [
    { title: 'Deep Work / Cal Newport', creator: 'Newport, Cal', year: '2017', isbn: '978-3-86881-662-4' },
    { title: 'Deep Work / Cal Newport', creator: 'Newport, Cal', year: '2019', isbn: '978-3-86881-773-7' },
  ] });
  const id = manual('Deep Work', 'Cal Newport');
  const r = await lookupIsbn(id);
  assert.equal(r.status, 'suggested');
  const e = db.prepare('SELECT isbn, isbn_status FROM editions WHERE id = ?').get(id);
  assert.equal(e.isbn, null);
  assert.equal(e.isbn_status, 'suggested');
});

test('anderer Autor oder abweichender Titel wird nie automatisch übernommen', () => {
  const c = [{ source: 'Google Books', title: 'Deep Work', authors: 'Max Muster', isbn: '9783868816624', year: '2017' }];
  assert.notEqual(decide('Deep Work', 'Cal Newport', c).status, 'auto');
  const d = [{ source: 'Google Books', title: 'Deep Work für Einsteiger', authors: 'Cal Newport', isbn: '9783868816624', year: '2017' }];
  assert.equal(decide('Deep Work', 'Cal Newport', d).status, 'suggested');
});

test('Open Library allein reicht nie für die automatische Übernahme', () => {
  const c = [{ source: 'Open Library', title: 'Deep Work', authors: 'Cal Newport', isbn: '9783868816624', weak: true }];
  assert.equal(decide('Deep Work', 'Cal Newport', c).status, 'suggested');
});

test('nichts gefunden: Status none, Link bleibt Amazon-Suche', async () => {
  stubFetch({});
  const id = manual('Ein sehr seltenes Buch', 'Niemand Bekannt');
  const r = await lookupIsbn(id);
  assert.equal(r.status, 'none');
});

test('alle Quellen nicht erreichbar: kein Status, damit später erneut gesucht wird', async () => {
  globalThis.fetch = async () => { throw new Error('offline'); };
  const id = manual('Offline Buch', 'Anna Autorin');
  await assert.rejects(lookupIsbn(id));
  assert.equal(db.prepare('SELECT isbn_status FROM editions WHERE id = ?').get(id).isbn_status, null);
});
