// Prüft den Ideenspeicher: Logik direkt und die Schnittstelle über einen echten Serverstart.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-ideas-'));
const { addIdea, toggleVote, listIdeas, IdeaError } = await import('../src/ideas.js');

test('Idee anlegen, doppelte Idee wird abgewiesen', () => {
  const i = addIdea('  Buch des Monats   vorstellen ', 'In der Masterclass');
  assert.equal(i.text, 'Buch des Monats vorstellen');
  assert.throws(() => addIdea('Buch des Monats vorstellen!'), IdeaError);
  assert.throws(() => addIdea('x'), IdeaError);
  assert.throws(() => addIdea('a'.repeat(201)), IdeaError);
});

test('+1 zählt einmal pro Browser und lässt sich zurücknehmen', () => {
  const { id } = addIdea('Agent Frag das Regal');
  assert.equal(toggleVote(id, 'v1'), true);
  assert.equal(toggleVote(id, 'v2'), true);
  assert.equal(listIdeas('v1').find((i) => i.id === id).votes, 2);
  assert.equal(listIdeas('v1').find((i) => i.id === id).mine, true);
  assert.equal(toggleVote(id, 'v1'), false);
  assert.equal(listIdeas('v1').find((i) => i.id === id).votes, 1);
});

// Schnittstelle: Server in eigenem Prozess mit eigener Datenbank
const port = 3900 + Math.floor(Math.random() * 90);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-ideas-http-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
  env: { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: 'pw', APP_SECRET: 's', ACCESS_CODE: '', ANTHROPIC_API_KEY: '' },
  stdio: 'ignore',
});
after(() => server.kill());
const base = `http://127.0.0.1:${port}`;
async function ready() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* startet noch */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server startet nicht');
}
const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const admin = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` };

test('Schnittstelle: einreichen ist offen, Status und Löschen nur für den Admin, Rate-Limit greift', async () => {
  await ready();
  const r = await post('/api/ideas', { text: 'Lesepfade nach Thema' });
  assert.equal(r.status, 200);
  const { id } = await r.json();

  assert.equal((await post(`/api/admin/ideas/${id}/status`, { status: 'geplant' })).status, 401);
  assert.equal((await fetch(`${base}/api/admin/ideas/${id}`, { method: 'DELETE' })).status, 401);
  assert.equal((await post(`/api/admin/ideas/${id}/status`, { status: 'geplant' }, admin)).status, 200);
  const list = await (await fetch(`${base}/api/ideas`)).json();
  assert.equal(list.ideas.find((i) => i.id === id).status, 'geplant');
  assert.equal((await fetch(`${base}/api/admin/ideas/${id}`, { method: 'DELETE', headers: admin })).status, 200);

  let last = 200;
  for (let i = 0; i < 6; i++) last = (await post('/api/ideas', { text: `Idee Nummer ${i} für den Test` })).status;
  assert.equal(last, 429);
});
