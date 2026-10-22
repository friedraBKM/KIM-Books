// Prüft die Cover-Suche zur ISBN mit nachgestellten Antworten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-covers-'));
process.env.GOOGLE_BOOKS_API_KEY = '';
const { db } = await import('../src/db.js');
const { findCoverForIsbn, refreshCover, allowedCover } = await import('../src/covers.js');

const image = (size, url) => ({ ok: true, url, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(size), json: async () => ({}) });
const notFound = (url) => ({ ok: false, status: 404, url, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) });

test('Open Library liefert ein Cover (Weiterleitung zu archive.org ist erlaubt)', async () => {
  globalThis.fetch = async (url) => (String(url).includes('openlibrary')
    ? image(15000, 'https://ia800100.us.archive.org/view/cover.jpg')
    : notFound(String(url)));
  assert.match(await findCoverForIsbn('9783442178582'), /covers\.openlibrary\.org/);
});

test('Platzhalter-Grafik wird ignoriert, DNB-Cover übernommen', async () => {
  globalThis.fetch = async (url) => (String(url).includes('openlibrary') ? image(43, String(url)) : image(9000, String(url)));
  assert.match(await findCoverForIsbn('9783442178582'), /portal\.dnb\.de/);
});

test('fremde Weiterleitungsziele werden abgelehnt', () => {
  assert.equal(allowedCover('https://evil.example/x.jpg', { redirect: true }), null);
  assert.equal(allowedCover('https://ia1.us.archive.org/x.jpg'), null);
  assert.ok(allowedCover('https://ia1.us.archive.org/x.jpg', { redirect: true }));
});

test('refreshCover setzt das Cover eines Werks über seine ISBN', async () => {
  const w = Number(db.prepare("INSERT INTO works (title, authors) VALUES ('Test', 'A')").run().lastInsertRowid);
  db.prepare("INSERT INTO editions (source, source_id, title, authors, work_id, isbn) VALUES ('manual', 'x', 'Test', 'A', ?, '9783442178582')").run(w);
  globalThis.fetch = async (url) => image(15000, String(url));
  assert.equal(await refreshCover(w), true);
  assert.match(db.prepare('SELECT cover FROM works WHERE id = ?').get(w).cover, /openlibrary/);
});
