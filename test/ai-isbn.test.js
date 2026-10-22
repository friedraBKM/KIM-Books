// Prüft, dass die KI-Websuche nur belegte ISBNs übernimmt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { verify } = await import('../src/ai-isbn.js');

const answer = (isbn) => ({ found: true, isbn, title: 'Das Experiment Hingabe', authors: 'Michael A. Singer', publisher: 'Arkana', year: '2016' });

test('ISBN aus einer Amazon-Adresse wird übernommen', () => {
  const evidence = 'https://www.amazon.de/Das-Experiment-Hingabe/dp/3442178584\nDas Experiment Hingabe';
  const r = verify(answer('978-3-442-17858-2'), evidence);
  assert.equal(r.isbn, '9783442178582');
  assert.equal(r.source, 'KI-Websuche');
});

test('ISBN mit Bindestrichen im Treffertext wird erkannt', () => {
  const r = verify(answer('3442178584'), 'ISBN: 978-3-442-17858-2, 320 Seiten');
  assert.equal(r.isbn, '3442178584');
});

test('erfundene ISBN ohne Beleg in den Treffern wird verworfen', () => {
  assert.equal(verify(answer('9783442178582'), 'https://www.amazon.de/dp/B07XYZ1234 Kindle-Ausgabe'), null);
});

test('ungültige Prüfziffer oder found=false wird verworfen', () => {
  assert.equal(verify(answer('9783442178580'), '9783442178580'), null);
  assert.equal(verify({ found: false }, '9783442178582'), null);
});
