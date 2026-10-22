// Prüft, wie das Ergebnis des KI-Abgleichs in die Datenbank übernommen wird (ohne echten KI-Aufruf).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-test-'));
const { db } = await import('../src/db.js');
const { applyResult } = await import('../src/ai.js');

function seed() {
  db.exec('DELETE FROM votes; DELETE FROM editions; DELETE FROM works;');
  const work = (t, a) => Number(db.prepare('INSERT INTO works (title, authors) VALUES (?, ?)').run(t, a).lastInsertRowid);
  const edition = (src, id, t, a, w, extra = {}) => Number(db.prepare(
    'INSERT INTO editions (source, source_id, title, authors, work_id, separated) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(src, id, t, a, w, extra.separated ? 1 : 0).lastInsertRowid);
  const vote = (voter, e, why = '') => Number(db.prepare('INSERT INTO votes (voter, edition_id, why) VALUES (?, ?, ?)').run(voter, e, why).lastInsertRowid);

  const w1 = work('Die 1%-Methode', 'James Clear');
  const w2 = work('Atomic Habits', 'James Clear');
  const w3 = work('Deep Work', 'Cal Newport');
  const e1 = edition('google', 'a', 'Die 1%-Methode', 'James Clear', w1);
  const e2 = edition('google', 'b', 'Atomic Habits', 'James Clear', w2);
  const e3 = edition('google', 'c', 'Deep Work', 'Cal Newport', w3);
  const v1 = vote('x', e1, 'Systeme statt Disziplin');
  const v2 = vote('y', e2, 'Ruf mich an: 0171 1234567');
  vote('z', e3);
  return { w1, w2, w3, e1, e2, e3, v1, v2 };
}

test('führt Übersetzung und Original zusammen und setzt Kategorien', () => {
  const s = seed();
  const summary = applyResult({
    groups: [
      { edition_ids: [s.e1, s.e2], title: 'Die 1%-Methode', authors: 'James Clear', category: 'Methoden & Produktivität', reason: 'Deutsche Übersetzung von Atomic Habits' },
      { edition_ids: [s.e3], title: 'Deep Work', authors: 'Cal Newport', category: 'Methoden & Produktivität', reason: '' },
    ],
    flagged_whys: [{ id: s.v2, reason: 'Telefonnummer' }],
  }, [s.v1, s.v2]);

  assert.equal(summary.merged, 1);
  const e2 = db.prepare('SELECT work_id, merge_reason FROM editions WHERE id = ?').get(s.e2);
  assert.equal(e2.work_id, s.w1);
  assert.match(e2.merge_reason, /Übersetzung/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 2, 'leeres Werk wurde entfernt');
  assert.equal(db.prepare('SELECT category FROM works WHERE id = ?').get(s.w1).category, 'Methoden & Produktivität');
  assert.equal(db.prepare('SELECT why_status FROM votes WHERE id = ?').get(s.v2).why_status, 'flagged');
  assert.equal(db.prepare('SELECT why_status FROM votes WHERE id = ?').get(s.v1).why_status, 'ok');
});

test('vom Admin getrennte Ausgaben und feste Kategorien bleiben unangetastet', () => {
  const s = seed();
  db.prepare('UPDATE editions SET separated = 1 WHERE id = ?').run(s.e2);
  db.prepare("UPDATE works SET category = 'Mein Favorit', category_locked = 1 WHERE id = ?").run(s.w3);
  applyResult({
    groups: [
      { edition_ids: [s.e1, s.e2], title: 'Die 1%-Methode', authors: 'James Clear', category: 'Methoden', reason: 'gleich' },
      { edition_ids: [s.e3], title: 'Deep Work', authors: 'Cal Newport', category: 'Methoden', reason: '' },
    ],
    flagged_whys: [],
  }, []);
  assert.equal(db.prepare('SELECT work_id FROM editions WHERE id = ?').get(s.e2).work_id, s.w2);
  assert.equal(db.prepare('SELECT category FROM works WHERE id = ?').get(s.w3).category, 'Mein Favorit');
});

test('unbekannte oder doppelte IDs der KI werden ignoriert', () => {
  const s = seed();
  applyResult({
    groups: [
      { edition_ids: [s.e1, 9999], title: 'Die 1%-Methode', authors: 'James Clear', category: 'A', reason: '' },
      { edition_ids: [s.e1, s.e3], title: 'Falsch', authors: 'X', category: 'B', reason: 'falsch' },
    ],
    flagged_whys: [],
  }, []);
  assert.equal(db.prepare('SELECT work_id FROM editions WHERE id = ?').get(s.e3).work_id, s.w3);
  assert.equal(db.prepare('SELECT title FROM works WHERE id = ?').get(s.w1).title, 'Die 1%-Methode');
});

test('trennt eine Gruppe, wenn die KI zwei Ausgaben eines Werks als verschieden erkennt', () => {
  const s = seed();
  db.prepare('UPDATE editions SET work_id = ? WHERE id = ?').run(s.w1, s.e3);
  applyResult({
    groups: [
      { edition_ids: [s.e1], title: 'Die 1%-Methode', authors: 'James Clear', category: 'A', reason: '' },
      { edition_ids: [s.e3], title: 'Deep Work', authors: 'Cal Newport', category: 'A', reason: '' },
      { edition_ids: [s.e2], title: 'Atomic Habits', authors: 'James Clear', category: 'A', reason: '' },
    ],
    flagged_whys: [],
  }, []);
  const w1 = db.prepare('SELECT work_id FROM editions WHERE id = ?').get(s.e1).work_id;
  const w3 = db.prepare('SELECT work_id FROM editions WHERE id = ?').get(s.e3).work_id;
  assert.notEqual(w1, w3);
});
