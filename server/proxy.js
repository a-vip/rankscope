'use strict';
/**
 * RankScope data proxy (Node implementation).
 * Mirrors public/api/index.php exactly: same sources.json, same params, same
 * JSON envelope. Zero dependencies (Node 18+ global fetch).
 *
 * Envelope: { ok, source, cached, fetchedAt, status, body }  |  { ok:false, error, status }
 */
const fs = require('fs');
const path = require('path');

const SOURCES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'api', 'sources.json'), 'utf8')
);
const UA = 'Mozilla/5.0 (compatible; RankScope/1.0; +https://github.com/a-vip/rankscope)';

const DFS_LOCATIONS = {
  us: 2840, gb: 2826, ca: 2124, au: 2036, in: 2356, de: 2276, fr: 2250, es: 2724, it: 2380,
  br: 2076, nl: 2528, sg: 2702, vn: 2704, ph: 2608, nz: 2554, za: 2710, ie: 2372, lk: 2144,
  mx: 2484, jp: 2392, ae: 2784, my: 2458, id: 2360, th: 2764, pk: 2586, ng: 2566, se: 2752,
};

const VALIDATORS = {
  q: (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200,
  hl: (v) => /^[a-z]{2}$/.test(v),
  gl: (v) => /^[a-z]{2}$/.test(v),
  article: (v) => typeof v === 'string' && v.length > 0 && v.length <= 255 && !/[\x00-\x1f]/.test(v),
  gran: (v) => v === 'daily' || v === 'monthly',
  start: (v) => /^\d{8}(\d{2})?$/.test(v),
  end: (v) => /^\d{8}(\d{2})?$/.test(v),
  y: (v) => /^\d{4}$/.test(v),
  m: (v) => /^\d{2}$/.test(v),
  d: (v) => /^\d{2}$/.test(v),
  since: (v) => /^\d{1,11}$/.test(v),
  domains: (v) => typeof v === 'string' && v.length <= 4000 && /^[a-z0-9.,-]+$/i.test(v),
  kw: (v) => typeof v === 'string' && v.length > 0 && v.length <= 12000,
};

function loadEnv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (_) { /* no .env file is fine */ }
}

function env(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : '';
}

function keyedAvailable(src) {
  if (src === 'serp') return !!env('SERPER_API_KEY');
  if (src === 'opr') return !!env('OPR_API_KEY');
  if (src === 'dfsvol' || src === 'dfskd') return !!(env('DATAFORSEO_LOGIN') && env('DATAFORSEO_PASSWORD'));
  return false;
}

/* ------------------------------ cache ------------------------------ */
const memCache = new Map();
const MAX_CACHE = 5000;
function cacheGet(key) {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { memCache.delete(key); return null; }
  return hit;
}
function cacheSet(key, value, ttlSec) {
  if (memCache.size >= MAX_CACHE) memCache.delete(memCache.keys().next().value);
  memCache.set(key, { ...value, exp: Date.now() + ttlSec * 1000 });
}

/* --------------------------- rate limiting --------------------------- */
const buckets = new Map();
function rateLimited(ip, keyed) {
  const now = Date.now();
  const limit = keyed ? Number(env('RATE_LIMIT_KEYED_PER_HOUR') || 120) : Number(env('RATE_LIMIT_PER_MIN') || 300);
  const windowMs = keyed ? 3600e3 : 60e3;
  const k = (keyed ? 'k:' : 'f:') + ip;
  let b = buckets.get(k);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(k, b); }
  b.n += 1;
  if (buckets.size > 20000) buckets.clear();
  return b.n > limit;
}

/* ------------------------------ helpers ------------------------------ */
function fillTemplate(tpl, p) {
  return tpl.replace(/\{(\w+)\}/g, (_, name) => {
    if (name === 'GL') return encodeURIComponent((p.gl || 'us').toUpperCase());
    if (name === 'article') return encodeURIComponent(String(p.article).replace(/ /g, '_'));
    const v = p[name] === undefined ? '' : String(p[name]);
    return encodeURIComponent(v);
  });
}

async function timedFetch(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    let body = buf.toString('utf8');
    // Google suggest can answer in ISO-8859-1 despite oe=UTF-8 on some edges.
    const ct = res.headers.get('content-type') || '';
    if (/iso-8859-1|latin1/i.test(ct)) body = buf.toString('latin1');
    return { status: res.status, body: body.slice(0, 2_000_000) };
  } finally {
    clearTimeout(t);
  }
}

function parseKwList(kw) {
  return [...new Set(String(kw).split('\n').map((s) => s.trim().toLowerCase()).filter((s) => s && s.length <= 80))].slice(0, 100);
}

async function fetchUpstream(src, p) {
  const def = SOURCES[src];
  if (!def.keyed) {
    const url = fillTemplate(def.url, p);
    return timedFetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': `${p.hl || 'en'};q=0.9` } });
  }
  if (src === 'serp') {
    return timedFetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': env('SERPER_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: p.q, gl: p.gl || 'us', hl: p.hl || 'en', num: 10 }),
    });
  }
  if (src === 'opr') {
    const doms = p.domains.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean).slice(0, 100);
    const qs = doms.map((d) => 'domains%5B%5D=' + encodeURIComponent(d)).join('&');
    return timedFetch('https://openpagerank.com/api/v1.0/getPageRank?' + qs, { headers: { 'API-OPR': env('OPR_API_KEY') } });
  }
  if (src === 'dfsvol' || src === 'dfskd') {
    const keywords = parseKwList(p.kw);
    const task = { keywords, language_code: p.hl || 'en', location_code: DFS_LOCATIONS[p.gl || 'us'] || 2840 };
    const endpoint = src === 'dfsvol'
      ? 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live'
      : 'https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_keyword_difficulty/live';
    const auth = Buffer.from(env('DATAFORSEO_LOGIN') + ':' + env('DATAFORSEO_PASSWORD')).toString('base64');
    return timedFetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
      body: JSON.stringify([task]),
    }, 30000);
  }
  throw new Error('unknown keyed source');
}

/**
 * Core request handler. Pure-ish: takes a query object + meta, returns {code, json}.
 */
async function handle(query, meta = {}) {
  const src = String(query.s || '');
  const ip = meta.ip || 'local';

  if (src === 'config') {
    const keyed = {};
    for (const [k, d] of Object.entries(SOURCES)) if (d.keyed) keyed[k] = keyedAvailable(k);
    const sources = {};
    for (const [k, d] of Object.entries(SOURCES)) if (!k.startsWith('_')) sources[k] = d.label;
    return { code: 200, json: { ok: true, backend: 'node', version: '1.0.0', keyed, sources, tokenRequired: !!env('ACCESS_TOKEN') } };
  }

  const def = SOURCES[src];
  if (!def || src.startsWith('_')) return { code: 400, json: { ok: false, error: 'Unknown source', status: 400 } };

  const p = {};
  for (const name of def.params) {
    let v = query[name];
    if (Array.isArray(v)) v = v[0];
    if (v === undefined || v === '') {
      if (name === 'hl') v = 'en';
      else if (name === 'gl') v = 'us';
      else if (name === 'gran') v = 'daily';
      else return { code: 400, json: { ok: false, error: `Missing parameter: ${name}`, status: 400 } };
    }
    v = String(v);
    if (name === 'hl' || name === 'gl') v = v.toLowerCase();
    if (!VALIDATORS[name] || !VALIDATORS[name](v)) return { code: 400, json: { ok: false, error: `Invalid parameter: ${name}`, status: 400 } };
    p[name] = v;
  }

  if (def.keyed) {
    if (!keyedAvailable(src)) return { code: 501, json: { ok: false, error: `${def.label} is not configured on this server`, status: 501 } };
    const token = env('ACCESS_TOKEN');
    if (token && meta.token !== token) return { code: 401, json: { ok: false, error: 'Access token required for paid data sources', status: 401 } };
  }

  if (rateLimited(ip, !!def.keyed)) return { code: 429, json: { ok: false, error: 'Rate limit reached. Slow down a little.', status: 429 } };

  const cacheKey = src + '|' + JSON.stringify(p);
  const hit = cacheGet(cacheKey);
  if (hit) return { code: 200, json: { ok: true, source: src, cached: true, fetchedAt: hit.fetchedAt, status: hit.status, body: hit.body } };

  try {
    const r = await fetchUpstream(src, p);
    const fetchedAt = new Date().toISOString();
    const good = r.status >= 200 && r.status < 300;
    if (good) cacheSet(cacheKey, { status: r.status, body: r.body, fetchedAt }, def.ttl || 3600);
    return {
      code: 200,
      json: good
        ? { ok: true, source: src, cached: false, fetchedAt, status: r.status, body: r.body }
        : { ok: false, source: src, error: `Upstream responded ${r.status}`, status: r.status },
    };
  } catch (e) {
    return { code: 200, json: { ok: false, source: src, error: e.name === 'AbortError' ? 'Upstream timeout' : 'Upstream unreachable', status: 0 } };
  }
}

module.exports = { handle, loadEnv, fillTemplate, SOURCES, VALIDATORS, parseKwList, DFS_LOCATIONS };

