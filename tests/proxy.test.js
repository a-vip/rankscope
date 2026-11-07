'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handle, fillTemplate, SOURCES, parseKwList } = require('../server/proxy.js');

test('config endpoint lists sources and keyed availability', async () => {
  const r = await handle({ s: 'config' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.backend, 'node');
  assert.ok(r.json.sources.g);
  assert.ok('serp' in r.json.keyed);
});

test('rejects unknown sources and bad params (no upstream call)', async () => {
  assert.strictEqual((await handle({ s: 'evil' })).code, 400);
  assert.strictEqual((await handle({ s: '_comment' })).code, 400);
  assert.strictEqual((await handle({ s: 'g' })).code, 400); // missing q
  assert.strictEqual((await handle({ s: 'g', q: 'x', hl: 'english' })).code, 400);
  assert.strictEqual((await handle({ s: 'wviews', article: 'X', hl: 'en', gran: 'hourly', start: '2026010100', end: '2026020100' })).code, 400);
  assert.strictEqual((await handle({ s: 'g', q: 'a'.repeat(201) })).code, 400);
});

test('keyed sources return 501 when not configured', async () => {
  delete process.env.SERPER_API_KEY;
  const r = await handle({ s: 'serp', q: 'coffee' });
  assert.strictEqual(r.code, 501);
});

test('access token gate on keyed sources', async () => {
  process.env.SERPER_API_KEY = 'dummy';
  process.env.ACCESS_TOKEN = 'secret';
  const r = await handle({ s: 'serp', q: 'coffee' }, { token: 'wrong' });
  assert.strictEqual(r.code, 401);
  delete process.env.SERPER_API_KEY;
  delete process.env.ACCESS_TOKEN;
});

test('templates are URL-encoded (no injection into upstream URL)', () => {
  const u = fillTemplate(SOURCES.g.url, { q: 'a&b=c #x', hl: 'en', gl: 'us' });
  assert.ok(u.includes('q=a%26b%3Dc%20%23x'));
  assert.ok(u.startsWith('https://suggestqueries.google.com/'));
  const w = fillTemplate(SOURCES.wviews.url, { article: 'Cold brew/../x', hl: 'en', gran: 'daily', start: '1', end: '2' });
  assert.ok(w.includes('Cold_brew%2F..%2Fx'));
});

test('every source definition is https and declares params', () => {
  for (const [k, d] of Object.entries(SOURCES)) {
    if (k.startsWith('_')) continue;
    assert.ok(Array.isArray(d.params), k);
    if (!d.keyed) assert.ok(d.url.startsWith('https://'), k);
  }
});

test('keyword list parsing caps and dedupes', () => {
  const list = parseKwList(Array.from({ length: 150 }, (_, i) => `kw ${i % 120}`).join('\n') + '\nKW 1');
  assert.strictEqual(list.length, 100);
  assert.strictEqual(new Set(list).size, 100);
});

