'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../public/assets/engine.js');

test('normalize & tokens', () => {
  assert.strictEqual(E.normalize('  How   to Brew  <b>Coffee</b>? '), 'how to brew coffee?');
  assert.deepStrictEqual(E.coreTokens('the best coffee makers'), ['coffee', 'maker']);
});

test('classify intent, tail and types', () => {
  const a = E.classify('how to make cold brew coffee at home');
  assert.strictEqual(a.intent, 'informational');
  assert.strictEqual(a.tail, 'long-tail');
  assert.ok(a.types.includes('question') && a.types.includes('how-to'));
  assert.strictEqual(E.classify('best cold brew maker').intent, 'commercial');
  assert.strictEqual(E.classify('buy cold brew concentrate').intent, 'transactional');
  assert.strictEqual(E.classify('netflix login').intent, 'navigational');
  assert.ok(E.classify('aeropress vs french press').types.includes('comparison'));
  assert.strictEqual(E.classify('coffee').tail, 'head');
});

test('buildExpansions depth sizes', () => {
  const q = E.buildExpansions('coffee', 'quick', { gl: 'us' });
  const s = E.buildExpansions('coffee', 'standard', { gl: 'us' });
  const d = E.buildExpansions('coffee', 'deep', { gl: 'us' });
  assert.ok(q.length < s.length && s.length < d.length);
  assert.ok(s.some((x) => x.q === 'coffee a' && x.kind === 'alphabet'));
  assert.ok(!E.buildExpansions('coffee', 'quick', { gl: 'gb' }).some((x) => x.engine === 'amz'));
});

test('parseSuggest handles google, bing/ddg-array, ddg-object, amazon and jsonp', () => {
  const g = JSON.stringify(['coffee', ['coffee near me', 'coffee maker', 'http://x.com'], [], [], { 'google:suggestrelevance': [1250, 900, 500], 'google:suggesttype': ['QUERY', 'QUERY', 'NAVIGATION'] }]);
  const gr = E.parseSuggest(g);
  assert.deepStrictEqual(gr.map((x) => x.text), ['coffee near me', 'coffee maker']);
  assert.strictEqual(gr[0].rel, 1250);
  assert.strictEqual(E.parseSuggest('cb(["c",["coffee shop"]])')[0].text, 'coffee shop');
  assert.strictEqual(E.parseSuggest(JSON.stringify([{ phrase: 'coffee beans' }]))[0].text, 'coffee beans');
  assert.strictEqual(E.parseSuggest(JSON.stringify({ suggestions: [{ value: 'coffee pods' }] }))[0].text, 'coffee pods');
  assert.deepStrictEqual(E.parseSuggest('garbage'), []);
});

test('aggregate merges engines and filters noise', () => {
  const res = [
    { engine: 'g', q: 'coffee', kind: 'seed', suggestions: [{ text: 'coffee maker', rel: 1200 }, { text: 'random thing' }] },
    { engine: 'bing', q: 'coffee', kind: 'seed', suggestions: [{ text: 'coffee maker' }] },
    { engine: 'g', q: 'coffee m', kind: 'alphabet', suggestions: [{ text: 'coffee maker' }, { text: 'coffee mug' }] },
  ];
  const { records, enginesQueried } = E.aggregate(res, 'coffee');
  const cm = records.find((r) => r.keyword === 'coffee maker');
  assert.strictEqual(cm.engines.size, 2);
  assert.strictEqual(cm.hits, 3);
  assert.strictEqual(cm.seedPos.g, 1);
  assert.ok(!records.some((r) => r.keyword === 'random thing'));
  assert.ok(records.some((r) => r.keyword === 'coffee' && r.isSeed));
  assert.deepStrictEqual(enginesQueried.sort(), ['bing', 'g']);
  const di = E.demandIndex(cm, enginesQueried);
  const mug = E.demandIndex(records.find((r) => r.keyword === 'coffee mug'), enginesQueried);
  assert.ok(di.value > mug.value, 'cross-engine, top-ranked suggestion should score higher');
});

test('demand from real volume is log-scaled', () => {
  assert.strictEqual(E.demandFromVolume(0), 0);
  assert.strictEqual(E.demandFromVolume(99), 40);
  assert.strictEqual(E.demandFromVolume(9999), 80);
  assert.strictEqual(E.demandFromVolume(10000000), 100);
});

test('heuristic KD: head harder than long-tail, explained', () => {
  const head = { keyword: 'coffee', demand: { value: 80 } };
  const tail = { keyword: 'how to make cold brew coffee without a filter', demand: { value: 30 } };
  head.cls = E.classify(head.keyword); tail.cls = E.classify(tail.keyword);
  const h = E.kdHeuristic(head, { wikiExact: true });
  const t = E.kdHeuristic(tail);
  assert.ok(h.value > t.value + 30, `${h.value} vs ${t.value}`);
  assert.strictEqual(t.confidence, 'Low');
  assert.ok(h.parts.length >= 2);
});

function fakeSerp(domains, titles) {
  return E.parseSerp(JSON.stringify({ organic: domains.map((d, i) => ({ position: i + 1, title: titles ? titles[i] : 'cold brew coffee guide', link: `https://www.${d}/page` })), peopleAlsoAsk: [{ question: 'Is cold brew stronger?' }], relatedSearches: [{ query: 'cold brew ratio' }] }));
}

test('SERP KD: big brands hard, forums/low-authority easy, weak spots found', () => {
  const hard = E.kdFromSerp(fakeSerp(['wikipedia.org', 'nytimes.com', 'healthline.com', 'forbes.com', 'webmd.com', 'bbc.com', 'cnn.com', 'theguardian.com', 'mayoclinic.org', 'amazon.com']), {}, 'cold brew coffee');
  const easy = E.kdFromSerp(fakeSerp(['reddit.com', 'quora.com', 'tinyblog.net', 'mysite.org', 'another.io', 'reddit.com', 'x1.com', 'x2.com', 'x3.com', 'x4.com'], ['Best brew 2019', 'cold brew?', 'stuff', 'things', 'misc', 'thread', 'a', 'b', 'c', 'd']), { 'tinyblog.net': 8, 'mysite.org': 12 }, 'cold brew coffee');
  assert.ok(hard.value >= 70, 'hard ' + hard.value);
  assert.ok(easy.value <= 30, 'easy ' + easy.value);
  assert.ok(easy.weak.some((w) => w.type === 'ugc'));
  assert.ok(easy.weak.some((w) => w.type === 'outdated'));
  assert.strictEqual(hard.confidence, 'High');
  assert.strictEqual(easy.ugcCount, 3);
});

test('rankability scale responds to authority and weak spots', () => {
  assert.strictEqual(E.rankability(90, 10).label, 'Near-impossible (today)');
  assert.strictEqual(E.rankability(10, 40).label, 'Very likely');
  const base = E.rankability(45, 20);
  const withWeak = E.rankability(45, 20, { serp: { minAuthority: 15, ugcCount: 3, outdatedCount: 2 } });
  assert.ok(withWeak.level > base.level);
  assert.ok(E.rankability(30, null).assumed);
  for (let kd = 0; kd <= 100; kd += 5) {
    const r = E.rankability(kd, 30);
    assert.ok(r.chance >= 1 && r.chance <= 99 && r.level >= 0 && r.level <= 5);
  }
});

test('trend detection from daily series', () => {
  const flat = Array.from({ length: 90 }, (_, i) => ({ date: `d${i}`, v: 100 }));
  const rising = Array.from({ length: 90 }, (_, i) => ({ date: `d${i}`, v: i < 76 ? 100 : 260 }));
  assert.strictEqual(E.trendFromDaily(flat).change, 0);
  const r = E.trendFromDaily(rising);
  assert.ok(r.change > 1);
  assert.strictEqual(E.trendScore({ wiki: r }).label, 'Rising');
  assert.strictEqual(E.trendScore({ trending: true, wiki: r }).label, 'Breakout');
  assert.strictEqual(E.trendScore({}).label, 'Unknown');
  assert.strictEqual(E.trendScore({ wiki: { change: -0.6 } }).label, 'Declining');
});

test('seasonality finds consistent peaks', () => {
  const monthly = [];
  for (const y of [2023, 2024, 2025]) for (let m = 1; m <= 12; m++) monthly.push({ date: `${y}-${String(m).padStart(2, '0')}-01`, v: m === 12 ? 500 : m === 11 ? 300 : 100 });
  const s = E.seasonality(monthly);
  assert.ok(s.seasonal);
  assert.strictEqual(s.peakMonth, 'Dec');
});

test('news velocity', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const items = [];
  for (let i = 0; i < 10; i++) items.push({ date: new Date(now.getTime() - i * 0.5 * 864e5) }); // 10 in last 5 days
  for (let i = 0; i < 6; i++) items.push({ date: new Date(now.getTime() - (10 + i * 3) * 864e5) });
  const v = E.newsVelocity(items, now);
  assert.strictEqual(v.last7, 10);
  assert.ok(v.velocity > 1);
  assert.strictEqual(v.weeks.reduce((a, b) => a + b, 0), 16);
});

test('RSS parsers', () => {
  const trends = `<rss><channel><item><title>World Series</title><ht:approx_traffic>500K+</ht:approx_traffic><ht:news_item><ht:news_item_title>Game 7 &amp; more</ht:news_item_title><ht:news_item_url>https://x.com/a</ht:news_item_url><ht:news_item_source>ESPN</ht:news_item_source></ht:news_item></item></channel></rss>`;
  const t = E.parseTrendsRss(trends);
  assert.strictEqual(t[0].title, 'World Series');
  assert.strictEqual(t[0].trafficN, 500000);
  assert.strictEqual(t[0].news[0].title, 'Game 7 & more');
  const news = `<rss><item><title>Cold brew sales soar - Reuters</title><link>https://n.com/1</link><pubDate>Wed, 29 Oct 2026 10:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item></rss>`;
  const n = E.parseNewsRss(news);
  assert.strictEqual(n[0].title, 'Cold brew sales soar');
  assert.strictEqual(n[0].source, 'Reuters');
  assert.ok(E.matchesTrending('world series tickets', t));
  assert.ok(!E.matchesTrending('coffee', t));
});

test('wiki article picking is strict', () => {
  assert.strictEqual(E.pickWikiArticle('cold brew coffee', [{ title: 'Cold brew coffee' }]), 'Cold brew coffee');
  assert.strictEqual(E.pickWikiArticle('cold brew coffee recipe for beginners', [{ title: 'Coffee' }]), null);
  assert.strictEqual(E.pickWikiArticle('python', [{ title: 'Python (programming language)' }]), 'Python (programming language)');
});

test('DataForSEO & OPR parsers', () => {
  const vol = JSON.stringify({ tasks: [{ result: [{ keyword: 'Cold Brew', search_volume: 49500, cpc: 1.2, monthly_searches: [{ year: 2026, month: 2, search_volume: 40000 }, { year: 2026, month: 1, search_volume: 45000 }] }] }] });
  const v = E.parseDfsVolume(vol)['cold brew'];
  assert.strictEqual(v.volume, 49500);
  assert.strictEqual(v.monthly[0].date, '2026-01-01');
  const kd = E.parseDfsKd(JSON.stringify({ tasks: [{ result: [{ items: [{ keyword: 'cold brew', keyword_difficulty: 42 }] }] }] }));
  assert.strictEqual(kd['cold brew'], 42);
  const opr = E.parseOpr(JSON.stringify({ response: [{ status_code: 200, domain: 'Example.com', page_rank_decimal: '4.35' }, { status_code: 404, domain: 'nope.io' }] }));
  assert.deepStrictEqual(opr, { 'example.com': 43.5 });
});

test('relevance filter drops loosely matched forum results', () => {
  const items = [{ title: 'Show HN: Cosplay as a tech lead' }, { title: 'My 20-minute home workout routine' }, { title: 'Workouts at home without equipment' }];
  assert.deepStrictEqual(E.relevant(items, 'home workout').map((x) => x.title), ['My 20-minute home workout routine', 'Workouts at home without equipment']);
});

test('domainOf handles subdomains and ccTLDs', () => {
  assert.strictEqual(E.domainOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  assert.strictEqual(E.domainOf('https://en.wikipedia.org/wiki/X'), 'wikipedia.org');
  assert.strictEqual(E.domainOf('https://blog.example.com/a'), 'example.com');
  assert.strictEqual(E.domainOf('not a url'), '');
});

test('end-to-end: clustering, justification, brief, csv', () => {
  const m = { hl: 'en', gl: 'us' };
  const kws = ['cold brew', 'cold brew coffee', 'how to make cold brew', 'how to make cold brew at home', 'cold brew ratio', 'cold brew ratio per cup', 'best cold brew maker', 'cold brew maker', 'cold brew vs iced coffee', 'is cold brew stronger'];
  const res = [{ engine: 'g', q: 'cold brew', kind: 'seed', suggestions: kws.map((t) => ({ text: t, rel: 900 })) }];
  const { records, enginesQueried } = E.aggregate(res, 'cold brew');
  records.forEach((r) => {
    r.cls = E.classify(r.keyword);
    r.demand = E.demandIndex(r, enginesQueried);
    r.trend = E.trendScore({});
    r.kd = E.kdHeuristic(r);
    r.rank = E.rankability(r.kd.value, 20, { cls: r.cls });
    r.opportunity = E.opportunity(r);
    r.evidence = E.justify(r, m, { enginesQueried: 1 });
    assert.ok(r.opportunity >= 0 && r.opportunity <= 100);
    assert.ok(r.evidence.length >= 1);
  });
  const clusters = E.clusterKeywords(records, 'cold brew');
  assert.strictEqual(clusters[0].key, 'core');
  assert.ok(clusters.some((c) => c.key === 'maker' || c.key === 'ratio' || c.key === 'make'));
  const total = clusters.reduce((s, c) => s + c.items.length, 0);
  assert.strictEqual(total, records.length);
  const rec = records.find((r) => r.keyword === 'how to make cold brew at home');
  const b = E.brief(rec, records, m);
  assert.ok(b.includes('# Brief: how to make cold brew at home'));
  assert.ok(b.includes('## Title options'));
  const csv = E.toCsv(records);
  assert.strictEqual(csv.split('\n').length, records.length + 1);
  assert.ok(E.titleIdeas('cold brew vs iced coffee', E.classify('cold brew vs iced coffee')).some((t) => t.includes('Cold Brew vs Iced Coffee')));
});

test('dated keywords are flagged, penalised and never chosen as pillar', () => {
  const y = new Date().getFullYear();
  const old = E.classify(`sourdough ${y - 2}`);
  assert.ok(old.types.includes('dated') && !old.types.includes('fresh'));
  assert.ok(E.classify(`sourdough ${y}`).types.includes('fresh'));
  const mk = (k, d) => { const r = { keyword: k, cls: E.classify(k), demand: { value: d }, kd: { value: 30 }, trend: { value: 50 } }; r.opportunity = E.opportunity(r); return r; };
  const a = mk(`sourdough ${y - 2}`, 50), b = mk('sourdough starter', 50);
  assert.ok(a.opportunity < b.opportunity);
  const recs = [a, mk('sourdough bread', 70), mk('sourdough', 60)];
  const core = E.clusterKeywords(recs, 'sourdough bread').find((c) => c.key === 'core');
  assert.strictEqual(core.pillar.keyword, 'sourdough bread');
});

