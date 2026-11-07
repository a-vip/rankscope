'use strict';
/**
 * Live smoke test: calls every free upstream source through the proxy and checks the
 * engine can parse the response. Run: npm run smoke  (needs internet)
 */
const E = require('../public/assets/engine.js');
const { handle, loadEnv } = require('../server/proxy.js');
const path = require('path');
loadEnv(path.join(__dirname, '..', '.env'));

const z = (n) => String(n).padStart(2, '0');
const y = E.daysAgo(2);
const CHECKS = [
  ['g', { q: 'cold brew', hl: 'en', gl: 'us' }, (b) => E.parseSuggest(b).length],
  ['yt', { q: 'cold brew', hl: 'en', gl: 'us' }, (b) => E.parseSuggest(b).length],
  ['bing', { q: 'cold brew', hl: 'en', gl: 'us' }, (b) => E.parseSuggest(b).length],
  ['ddg', { q: 'cold brew', hl: 'en', gl: 'us' }, (b) => E.parseSuggest(b).length],
  ['amz', { q: 'cold brew' }, (b) => E.parseSuggest(b).length],
  ['trends', { gl: 'us' }, (b) => E.parseTrendsRss(b).length],
  ['news', { q: 'coffee', hl: 'en', gl: 'us' }, (b) => E.parseNewsRss(b).length],
  ['gdelt', { q: 'coffee' }, (b) => E.parseGdelt(b).length],
  ['wsearch', { q: 'cold brew coffee', hl: 'en' }, (b) => E.parseWikiSearch(b).results.length],
  ['wviews', { article: 'Cold brew coffee', hl: 'en', gran: 'daily', start: E.ymd(E.daysAgo(60)) + '00', end: E.ymd(E.daysAgo(1)) + '00' }, (b) => E.parseWikiViews(b).length],
  ['wtop', { hl: 'en', y: String(y.getUTCFullYear()), m: z(y.getUTCMonth() + 1), d: z(y.getUTCDate()) }, (b) => E.parseWikiTop(b).length],
  ['hn', { q: 'ai', since: String(Math.floor(Date.now() / 1000) - 30 * 86400) }, (b) => E.parseHN(b).hits.length],
  ['hnfront', {}, (b) => E.parseHN(b).hits.length],
  ['reddit', { q: 'cold brew' }, (b) => E.parseReddit(b).length],
];
if (process.env.SERPER_API_KEY) CHECKS.push(['serp', { q: 'cold brew ratio', hl: 'en', gl: 'us' }, (b) => (E.parseSerp(b) || { organic: [] }).organic.length]);
if (process.env.OPR_API_KEY) CHECKS.push(['opr', { domains: 'wikipedia.org,reddit.com' }, (b) => Object.keys(E.parseOpr(b)).length]);

(async () => {
  let fails = 0;
  const required = new Set(['g', 'wsearch', 'wviews', 'hnfront']);
  for (const [src, params, parse] of CHECKS) {
    const t = Date.now();
    const r = await handle({ s: src, ...params }, { ip: 'smoke' });
    let n = 0;
    try { n = r.json.ok ? parse(r.json.body) : 0; } catch (_) { n = 0; }
    const ok = r.json.ok && n > 0;
    if (!ok && required.has(src)) fails++;
    console.log(`${ok ? 'PASS' : required.has(src) ? 'FAIL' : 'WARN'}  ${src.padEnd(8)} ${String(Date.now() - t).padStart(5)}ms  items=${n}${r.json.ok ? '' : '  ' + r.json.error}`);
  }
  console.log(fails ? `\n${fails} required source(s) failed` : '\nCore sources OK (WARN = optional source unavailable from this network)');
  process.exit(fails ? 1 : 0);
})();

