// Prüft ISBN-Umrechnung und die Wahl der Ausgabe für den Amazon-Link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-amazon-'));
const { db } = await import('../src/db.js');
const { validIsbn, isbn13to10, linkForIsbn, amazonLinks } = await import('../src/amazon.js');

test('ISBN prüfen und umrechnen', () => {
  assert.equal(validIsbn('978-3-442-17858-2'), true);
  assert.equal(validIsbn('9783442178580'), false);
  assert.equal(validIsbn('3-442-17858-0'), false);
  assert.equal(isbn13to10('9783442178582'), '3442178584');
  assert.equal(validIsbn('3442178584'), true);
  assert.equal(isbn13to10('9780306406157'), '0306406152');
  assert.equal(isbn13to10('9791234567896'), null);
});

test('Link: exakt über ISBN-10, 979er als Suche', () => {
  assert.deepEqual(linkForIsbn('9783442178582'), { url: 'https://www.amazon.de/dp/3442178584', exact: true });
  assert.equal(linkForIsbn('9791234567896').exact, false);
  assert.equal(linkForIsbn('123'), null);
});

test('Werk: deutsche Ausgabe vor meistgenannter, Admin-ISBN vor allem, sonst Suche', () => {
  const w1 = Number(db.prepare("INSERT INTO works (title, authors) VALUES ('Die 1%-Methode', 'James Clear')").run().lastInsertRowid);
  const w2 = Number(db.prepare("INSERT INTO works (title, authors) VALUES ('Mein Tipp', 'Anna Autorin')").run().lastInsertRowid);
  const ed = (w, isbn, lang, id) => Number(db.prepare(
    "INSERT INTO editions (source, source_id, title, authors, work_id, isbn, language) VALUES ('google', ?, 't', 'a', ?, ?, ?)",
  ).run(id, w, isbn, lang).lastInsertRowid);
  const en = ed(w1, '9780735211292', 'en', 'en');
  ed(w1, '9783442178582', 'de', 'de');
  for (const v of ['a', 'b', 'c']) db.prepare('INSERT INTO votes (voter, edition_id) VALUES (?, ?)').run(v, en);

  let links = amazonLinks();
  assert.equal(links.get(w1).url, 'https://www.amazon.de/dp/3442178584');
  assert.equal(links.get(w2).exact, false);
  assert.match(links.get(w2).url, /s\?k=Mein%20Tipp%20Anna%20Autorin/);

  db.prepare("UPDATE works SET isbn_override = '9780735211292' WHERE id = ?").run(w1);
  links = amazonLinks();
  assert.equal(links.get(w1).url, 'https://www.amazon.de/dp/0735211299');
});
