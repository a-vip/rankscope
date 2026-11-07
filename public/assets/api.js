/*!
 * RankScope API client.
 * Talks to the backend proxy (PHP or Node). If no backend is reachable (e.g. GitHub Pages),
 * falls back to calling CORS/JSONP-capable sources directly from the browser.
 */
(function (root) {
  'use strict';

  const state = {
    base: 'api/',
    token: '',
    mode: 'unknown', // 'proxy' | 'direct'
    config: null,
    sources: null,
    health: {}, // source -> {ok, fail, last, error}
    listeners: [],
  };
  const memo = new Map();
  let active = 0;
  const queue = [];
  const MAX_CONCURRENCY = 6;

  function onHealth(fn) { state.listeners.push(fn); }
  function mark(src, ok, error) {
    const h = state.health[src] || (state.health[src] = { ok: 0, fail: 0, last: null, error: '' });
    if (ok) h.ok += 1; else { h.fail += 1; h.error = error || 'failed'; }
    h.last = new Date();
    state.listeners.forEach((fn) => { try { fn(state.health); } catch (_) { /* ignore */ } });
  }

  function schedule(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (active < MAX_CONCURRENCY && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      task().then(resolve, reject).finally(() => { active -= 1; pump(); });
    }
  }

  function fill(tpl, p) {
    return tpl.replace(/\{(\w+)\}/g, (_, n) => {
      if (n === 'GL') return encodeURIComponent((p.gl || 'us').toUpperCase());
      if (n === 'article') return encodeURIComponent(String(p.article).replace(/ /g, '_'));
      if (n === 'cb') return p.cb;
      return encodeURIComponent(p[n] === undefined ? '' : String(p[n]));
    });
  }

  let jsonpSeq = 0;
  function jsonp(urlTpl, params, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const cb = `__rs_cb_${Date.now().toString(36)}_${jsonpSeq++}`;
      const s = document.createElement('script');
      const done = (err, data) => {
        clearTimeout(t);
        delete root[cb];
        s.remove();
        err ? reject(err) : resolve(data);
      };
      const t = setTimeout(() => done(new Error('timeout')), timeout);
      root[cb] = (data) => done(null, data);
      s.onerror = () => done(new Error('blocked'));
      s.src = fill(urlTpl, { ...params, cb });
      s.referrerPolicy = 'no-referrer';
      document.head.appendChild(s);
    });
  }

  async function timedFetch(url, opts = {}, ms = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
  }

  async function init(base, token) {
    state.base = base || 'api/';
    state.token = token || '';
    try {
      const res = await timedFetch(state.base + (state.base.includes('?') ? '&' : '?') + 's=config', { headers: tokenHeaders() }, 6000);
      const json = await res.json();
      if (!json.ok) throw new Error('bad config');
      state.config = json;
      state.mode = 'proxy';
    } catch (_) {
      state.mode = 'direct';
      state.config = { ok: true, backend: 'browser', keyed: {}, sources: {} };
    }
    if (state.mode === 'direct') {
      // Browser-only mode needs the source templates (static file, works on GitHub Pages).
      try {
        const r = await timedFetch('api/sources.json', {}, 6000);
        state.sources = await r.json();
      } catch (_) { state.sources = {}; }
    }
    return { mode: state.mode, config: state.config };
  }

  function tokenHeaders() { return state.token ? { 'X-Access-Token': state.token } : {}; }

  function available(src) {
    if (state.mode === 'proxy') {
      const keyed = state.config.keyed || {};
      if (src in keyed) return !!keyed[src];
      return !!(state.config.sources && state.config.sources[src]);
    }
    const def = state.sources && state.sources[src];
    return !!(def && def.direct);
  }

  /**
   * Fetch one source. Resolves {ok, body|data, cached, fetchedAt, error}. Never throws.
   */
  function get(src, params = {}) {
    const key = src + '|' + JSON.stringify(params);
    if (memo.has(key)) return memo.get(key);
    const p = schedule(async () => {
      if (!available(src)) return { ok: false, error: state.mode === 'direct' ? 'Needs backend' : 'Not configured' };
      try {
        if (state.mode === 'proxy') {
          const qs = new URLSearchParams({ s: src, ...params }).toString();
          const res = await timedFetch(state.base + (state.base.includes('?') ? '&' : '?') + qs, { headers: tokenHeaders() }, src.startsWith('dfs') ? 45000 : 20000);
          const json = await res.json();
          mark(src, json.ok, json.error);
          return json;
        }
        const def = state.sources[src];
        if (def.direct === 'jsonp') {
          const data = await jsonp(def.directUrl, { hl: 'en', gl: 'us', ...params });
          mark(src, true);
          return { ok: true, body: data, cached: false, fetchedAt: new Date().toISOString() };
        }
        const res = await timedFetch(fill(def.url, { hl: 'en', gl: 'us', ...params }));
        if (!res.ok) { mark(src, false, 'HTTP ' + res.status); return { ok: false, error: 'HTTP ' + res.status }; }
        const body = await res.text();
        mark(src, true);
        return { ok: true, body, cached: false, fetchedAt: new Date().toISOString() };
      } catch (e) {
        mark(src, false, e.message);
        return { ok: false, error: e.message || 'network error' };
      }
    });
    memo.set(key, p);
    p.then((r) => { if (!r.ok) setTimeout(() => memo.delete(key), 30000); });
    return p;
  }

  function clearMemo() { memo.clear(); }

  root.RSApi = { init, get, available, onHealth, clearMemo, state };
})(typeof self !== 'undefined' ? self : this);
