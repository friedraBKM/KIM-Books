// Prüft Fehlertexte und Wiederholung bei Störungen der Google Books API.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
const { googleFetch, googleStatus, describeGoogleError, GoogleError } = await import('../src/google-books.js');

const reply = (status, body) => ({ ok: status < 400, status, statusText: '', json: async () => body });

test('503 von Google wird wiederholt und gelingt beim zweiten Versuch', async () => {
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1
    ? reply(503, { error: { message: 'Service temporarily unavailable.', errors: [{ reason: 'backendFailed' }] } })
    : reply(200, { totalItems: 5, items: [] }));
  const data = await googleFetch('/volumes', { q: 'x' });
  assert.equal(data.totalItems, 5);
  assert.equal(calls, 2);
});

test('ungültiger Key wird nicht wiederholt und verständlich erklärt', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return reply(400, { error: { message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }] } }); };
  const status = await googleStatus(true);
  assert.equal(status.ok, false);
  assert.match(status.text, /Key ist ungültig/);
  assert.equal(calls, 1);
});

test('Fehlertexte für typische Ursachen', () => {
  assert.match(describeGoogleError(new GoogleError(503, 'backendFailed', 'Service temporarily unavailable.')), /Störung bei Google/);
  assert.match(describeGoogleError(new GoogleError(403, 'accessNotConfigured', 'Books API has not been used in project 1')), /nicht aktiviert/);
  assert.match(describeGoogleError(new GoogleError(403, 'API_KEY_HTTP_REFERRER_BLOCKED', 'Requests from referer <empty> are blocked.')), /beschränkt/);
  assert.match(describeGoogleError(new GoogleError(429, 'rateLimitExceeded', 'Quota exceeded')), /Kontingent/);
});
