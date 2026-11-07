/*!
 * RankScope app controller.
 * Pipeline: expand seed -> autocomplete (5 engines) -> aggregate & classify -> instant scores
 *   -> seed context (Trends, News, GDELT, Wikipedia, HN, Reddit) -> deep enrichment of top N
 *   (news velocity, Wikipedia, SERP, authority, Google Ads volume) -> final scores & evidence.
 */
(function () {
  'use strict';
  const E = window.RSEngine, C = window.RSCharts, API = window.RSApi;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const MARKETS = [
    ['us', 'en', 'United States'], ['gb', 'en', 'United Kingdom'], ['ca', 'en', 'Canada'], ['au', 'en', 'Australia'],
    ['in', 'en', 'India'], ['ie', 'en', 'Ireland'], ['nz', 'en', 'New Zealand'], ['sg', 'en', 'Singapore'],
    ['ph', 'en', 'Philippines'], ['my', 'en', 'Malaysia'], ['za', 'en', 'South Africa'], ['ng', 'en', 'Nigeria'],
    ['pk', 'en', 'Pakistan'], ['lk', 'en', 'Sri Lanka'], ['ae', 'en', 'UAE'], ['vn', 'vi', 'Vietnam (Vietnamese)'],
    ['vn', 'en', 'Vietnam (English)'], ['th', 'th', 'Thailand'], ['id', 'id', 'Indonesia'], ['jp', 'ja', 'Japan'],
    ['de', 'de', 'Germany'], ['fr', 'fr', 'France'], ['es', 'es', 'Spain'], ['it', 'it', 'Italy'], ['nl', 'nl', 'Netherlands'],
    ['se', 'sv', 'Sweden'], ['br', 'pt', 'Brazil'], ['mx', 'es', 'Mexico'],
  ].map(([gl, hl, label]) => ({ gl, hl, label, id: `${gl}-${hl}` }));
  const ENGINES = [['g', 'Google'], ['bing', 'Bing'], ['ddg', 'DuckDuckGo'], ['yt', 'YouTube'], ['amz', 'Amazon']];
  const ENG_SHORT = { g: 'G', bing: 'B', ddg: 'D', yt: 'Y', amz: 'A' };
  const EXAMPLES = ['cold brew coffee', 'ai regulation', 'budget travel vietnam', 'home workout', 'personal finance for students', 'sourdough bread'];
  const FILTERS = [
    ['all', 'All'], ['question', 'Questions'], ['long-tail', 'Long-tail'], ['mid-tail', 'Mid-tail'], ['head', 'Head'],
    ['informational', 'Informational'], ['commercial', 'Commercial'], ['transactional', 'Transactional'],
    ['comparison', 'Comparisons'], ['how-to', 'How-to'], ['fresh', 'Fresh'], ['rising', 'Rising'],
  ];

  /* ============================== storage ============================== */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('rs_' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('rs_' + k, JSON.stringify(v)); } catch (_) { /* quota */ } },
  };
  const settings = Object.assign({ domain: '', auth: '', engines: ['g', 'bing', 'ddg', 'yt', 'amz'], topN: 15, market: 'us-en', api: 'api/', token: '' }, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  /* =============================== state =============================== */
  const S = {
    market: MARKETS.find((m) => m.id === settings.market) || MARKETS[0],
    seed: '', recs: [], byKw: new Map(), enginesQueried: [], authMap: {}, trending: [], seedCtx: {},
    sort: { key: 'opportunity', dir: 'desc' }, filter: 'all', running: 0, open: null, live: false, liveTimer: null,
    lastLive: { trends: new Set(), wiki: new Set(), hn: new Set() },
  };
  const siteAuth = () => (settings.auth === '' || settings.auth === null ? null : Number(settings.auth));

  /* =============================== utils =============================== */
  function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }
  function download(name, text, type = 'text/plain') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch (_) { download('rankscope.txt', text); } }
  function slug(s) { return E.normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'keyword'; }
  function ago(d) { if (!d) return ''; const s = (Date.now() - new Date(d).getTime()) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; }
  function progress(done, total, text) {
    const p = $('#progress'); p.hidden = total === 0 || done >= total;
    $('#progressFill').style.width = total ? Math.round((done / total) * 100) + '%' : '0';
    $('#progressText').textContent = text || '';
  }
  const meterColor = (v, invert) => (invert ? (v <= 30 ? 'var(--good)' : v <= 55 ? 'var(--warn)' : v <= 75 ? 'var(--orange)' : 'var(--bad)') : (v >= 65 ? 'var(--good)' : v >= 40 ? 'var(--warn)' : 'var(--orange)'));
  const meter = (v, invert, label) => `<div class="meter"><div class="track"><div class="fill" style="width:${Math.max(3, v)}%;background:${meterColor(v, invert)}"></div></div><b>${label !== undefined ? label : v}</b></div>`;
  const intentBadge = (i) => `<span class="b ${{ informational: 'info', commercial: 'com', transactional: 'tra', navigational: 'nav' }[i]}">${i}</span>`;

  /* ============================ API helpers ============================ */
  const mk = () => ({ hl: S.market.hl, gl: S.market.gl });
  async function body(src, params) { const r = await API.get(src, params); return r && r.ok ? r.body : null; }

  async function fetchWiki(keyword, withMonthly) {
    const sr = E.parseWikiSearch(await body('wsearch', { q: keyword, hl: S.market.hl }));
    const title = E.pickWikiArticle(keyword, sr.results);
    if (!title) return null;
    const end = E.ymd(E.daysAgo(1)) + '00';
    const daily = E.parseWikiViews(await body('wviews', { article: title, hl: S.market.hl, gran: 'daily', start: E.ymd(E.daysAgo(91)) + '00', end }));
    const out = { title, daily, trend: E.trendFromDaily(daily) };
    if (withMonthly) {
      const s = E.daysAgo(365 * 3 + 40); s.setUTCDate(1);
      const monthly = E.parseWikiViews(await body('wviews', { article: title, hl: S.market.hl, gran: 'monthly', start: E.ymd(s) + '00', end }));
      out.monthly = monthly;
      out.seasonal = E.seasonality(monthly);
    }
    return out;
  }
  async function fetchNews(keyword) {
    const xml = await body('news', { q: keyword, ...mk() });
    if (xml === null) return null;
    const items = E.parseNewsRss(xml);
    return { items, velocity: E.newsVelocity(items) };
  }

  /* =============================== scoring =============================== */
  function score(rec) {
    rec.cls = E.classify(rec.keyword);
    rec.demand = E.demandIndex(rec, S.enginesQueried);
    rec.trendingMatch = E.matchesTrending(rec.keyword, S.trending);
    rec.trend = E.trendScore({
      trending: !!rec.trendingMatch,
      wiki: rec.wikiTrend || null,
      news: rec.news || null,
      gdelt: rec.gdeltTrend || null,
      volumeTrend: rec.monthly ? E.volumeTrend(rec.monthly) : null,
    });
    if (rec.serp) {
      rec.kd = E.kdFromSerp(rec.serp, S.authMap, rec.keyword);
      if (rec.kd && typeof rec.dfsKd === 'number') rec.kd.parts.push({ label: `DataForSEO Labs KD for comparison: ${rec.dfsKd}`, delta: 0 });
    } else if (typeof rec.dfsKd === 'number') {
      rec.kd = { value: Math.max(1, Math.round(rec.dfsKd)), basis: 'dataforseo', confidence: 'Medium-high', parts: [{ label: 'DataForSEO Labs keyword difficulty (backlink profiles of the current top 10)', delta: Math.round(rec.dfsKd) }] };
    } else {
      rec.kd = E.kdHeuristic(rec, { wikiExact: !!rec.wikiTitle });
    }
    rec.rank = E.rankability(rec.kd.value, siteAuth(), { serp: rec.kd.basis === 'serp' ? rec.kd : null, cls: rec.cls, trendLabel: rec.trend.label });
    rec.opportunity = E.opportunity(rec);
    rec.evidence = E.justify(rec, S.market, { enginesQueried: S.enginesQueried.length });
    return rec;
  }
  function rescoreAll() { S.recs.forEach(score); }

  /* ============================ main analysis ============================ */
  async function analyze(seedRaw) {
    const seed = E.normalize(seedRaw);
    if (!seed) return;
    const run = ++S.running;
    API.clearMemo();
    S.seed = seed; S.recs = []; S.byKw = new Map(); S.authMap = {}; S.seedCtx = {};
    $('#seed').value = seed;
    $('#empty').hidden = true; $('#results').hidden = false;
    $('#seedTitle').innerHTML = `${esc(seed)} <span class="muted small">${esc(S.market.label)}</span>`;
    $('#goBtn').disabled = true;
    location.hash = `q=${encodeURIComponent(seed)}&m=${S.market.id}&d=${$('#depth').value}`;
    addHistory(seed);
    ['#seedCards', '#picks', '#seedBuzz'].forEach((s) => ($(s).innerHTML = ''));
    $('#chartWiki').innerHTML = $('#chartNews').innerHTML = '<div class="chart-empty"><span class="spin"></span>&nbsp; loading</div>';
    renderTrendsEmbed(seed);

    // 1. Live trending list (used to flag keywords that are trending right now)
    const trendingP = body('trends', { gl: S.market.gl }).then((x) => (S.trending = x ? E.parseTrendsRss(x) : []));

    // 2. Autocomplete fan-out
    const plan = E.buildExpansions(seed, $('#depth').value, { engines: settings.engines, gl: S.market.gl });
    let done = 0;
    progress(0, plan.length, `Querying ${plan.length} autocomplete variations across ${new Set(plan.map((p) => p.engine)).size} engines...`);
    const results = await Promise.all(plan.map(async (p) => {
      const r = await API.get(p.engine, { q: p.q, ...(p.engine === 'amz' ? {} : mk()) });
      done++;
      if (run === S.running) progress(done, plan.length + 4, `Autocomplete ${done}/${plan.length}...`);
      return { ...p, ok: !!(r && r.ok), suggestions: r && r.ok ? E.parseSuggest(r.body) : [] };
    }));
    if (run !== S.running) return;
    await trendingP;
    const agg = E.aggregate(results, seed);
    S.enginesQueried = agg.enginesQueried;
    S.recs = agg.records;
    S.recs.forEach((r) => S.byKw.set(r.keyword, r));
    rescoreAll();
    renderAll();
    if (!results.some((r) => r.ok)) banner('No autocomplete source answered. Check your connection or the data sources status in Settings.');

    // 3. Seed context
    progress(plan.length, plan.length + 4, 'Gathering live trend evidence (Wikipedia, news, GDELT, forums)...');
    const seedRec = S.byKw.get(seed);
    const [wiki, news, gdeltRaw, hnRaw, redditRaw] = await Promise.all([
      fetchWiki(seed, true),
      fetchNews(seed),
      body('gdelt', { q: E.gdeltQuery(seed) }),
      body('hn', { q: seed, since: String(Math.floor(Date.now() / 1000) - 30 * 86400) }),
      body('reddit', { q: seed }),
    ]);
    if (run !== S.running) return;
    const gdelt = E.parseGdelt(gdeltRaw);
    const hnAll = E.parseHN(hnRaw);
    const hnHits = E.relevant(hnAll.hits, seed);
    const hn = { total: hnHits.length, hits: hnHits };
    const reddit = E.relevant(E.parseReddit(redditRaw), seed, 0.5);
    S.seedCtx = { wiki, news, gdelt, hn, reddit };
    if (seedRec) {
      if (wiki) Object.assign(seedRec, { wikiTitle: wiki.title, wikiDaily: wiki.daily, wikiTrend: wiki.trend, seasonal: wiki.seasonal });
      if (news) seedRec.news = news.velocity;
      if (gdelt.length) seedRec.gdeltTrend = E.trendFromDaily(gdelt);
      if (hn.total) seedRec.hn = hn;
      if (reddit.length) seedRec.reddit = reddit;
      score(seedRec);
    }
    renderSeedContext();
    renderAll();

    // 4. Deep enrichment of the top N
    await enrichTop(run);
    if (run !== S.running) return;
    progress(1, 1);
    $('#goBtn').disabled = false;
    renderAll();
    toast(`Analysed ${S.recs.length} keywords`);
    if (S.pendingOpen) { const k = E.normalize(S.pendingOpen); S.pendingOpen = null; if (S.byKw.has(k)) openDrawer(k); }
  }

  async function enrichTop(run) {
    const topN = Math.max(5, Math.min(60, Number(settings.topN) || 15));
    const ranked = [...S.recs].sort((a, b) => b.opportunity - a.opportunity);
    const top = ranked.filter((r) => !r.isSeed).slice(0, topN);
    const seedRec = S.byKw.get(S.seed);
    if (seedRec) top.unshift(seedRec);
    const keyed = API.state.config && API.state.config.keyed || {};
    let done = 0;
    const total = top.length;
    const step = (t) => { done++; if (run === S.running) progress(done, total + 2, t); };

    // Google Ads volume + DataForSEO KD in two batched calls (up to 100 keywords)
    const batch = ranked.slice(0, 100).map((r) => r.keyword);
    const dfs = [];
    if (keyed.dfsvol) dfs.push(body('dfsvol', { kw: batch.join('\n'), ...mk() }).then((b) => {
      const map = E.parseDfsVolume(b);
      Object.entries(map).forEach(([k, v]) => { const r = S.byKw.get(k); if (r) Object.assign(r, { volume: v.volume || 0, cpc: v.cpc, monthly: v.monthly }); });
    }));
    if (keyed.dfskd) dfs.push(body('dfskd', { kw: batch.join('\n'), ...mk() }).then((b) => {
      const map = E.parseDfsKd(b);
      Object.entries(map).forEach(([k, v]) => { const r = S.byKw.get(k); if (r) r.dfsKd = v; });
    }));

    await Promise.all(top.map(async (rec) => {
      const jobs = [];
      if (!rec.news) jobs.push(fetchNews(rec.keyword).then((n) => { if (n) { rec.news = n.velocity; rec.newsItems = n.items.slice(0, 8); } }));
      if (!rec.wikiTitle && rec.cls.words <= 3) jobs.push(fetchWiki(rec.keyword, false).then((w) => { if (w) Object.assign(rec, { wikiTitle: w.title, wikiDaily: w.daily, wikiTrend: w.trend }); }));
      if (keyed.serp && !rec.serp) jobs.push(body('serp', { q: rec.keyword, ...mk() }).then((b) => { const s = E.parseSerp(b); if (s) rec.serp = s; }));
      await Promise.all(jobs);
      step(`Deep analysis: ${rec.keyword}`);
    }));
    await Promise.all(dfs);
    await fetchAuthority();
    if (run !== S.running) return;
    rescoreAll();
  }

  /** Look up authority for every SERP domain we have not scored yet (+ your own site). */
  async function fetchAuthority() {
    if (!(API.state.config.keyed || {}).opr) return;
    const domains = new Set();
    S.recs.forEach((r) => r.serp && r.serp.organic.forEach((o) => { if (o.domain && S.authMap[o.domain] === undefined) domains.add(o.domain); }));
    const list = [...domains];
    for (let i = 0; i < list.length; i += 100) {
      Object.assign(S.authMap, E.parseOpr(await body('opr', { domains: list.slice(i, i + 100).join(',') })));
    }
  }

  /** On-demand deep analysis when a keyword is opened. */
  async function enrichOne(rec) {
    const keyed = API.state.config.keyed || {};
    const jobs = [];
    if (!rec.news) jobs.push(fetchNews(rec.keyword).then((n) => { if (n) { rec.news = n.velocity; rec.newsItems = n.items.slice(0, 8); } }));
    if (!rec.newsItems && rec.isSeed && S.seedCtx.news) rec.newsItems = S.seedCtx.news.items.slice(0, 8);
    if (!rec.wikiTitle && rec.cls.words <= 4) jobs.push(fetchWiki(rec.keyword, false).then((w) => { if (w) Object.assign(rec, { wikiTitle: w.title, wikiDaily: w.daily, wikiTrend: w.trend }); }));
    if (keyed.serp && !rec.serp) jobs.push(body('serp', { q: rec.keyword, ...mk() }).then((b) => { const s = E.parseSerp(b); if (s) rec.serp = s; }));
    if (!jobs.length) return false;
    await Promise.all(jobs);
    await fetchAuthority();
    score(rec);
    return true;
  }

  /* ============================== rendering ============================== */
  function renderAll() {
    renderSeedCards();
    renderPicks();
    renderTable();
    renderPlan();
    if (S.open) renderDrawer(S.open);
  }

  function renderSeedCards() {
    const seedRec = S.byKw.get(S.seed);
    const recs = S.recs;
    const longTail = recs.filter((r) => r.cls.tail === 'long-tail').length;
    const questions = recs.filter((r) => r.cls.types.includes('question')).length;
    const likely = recs.filter((r) => r.rank && r.rank.level >= 4).length;
    const possible = recs.filter((r) => r.rank && r.rank.level === 3).length;
    const w = S.seedCtx.wiki;
    const wikiAvg = w && w.daily.length ? Math.round(E.avg(w.daily.slice(-30).map((p) => p.v))) : null;
    const cards = [
      ['Keywords found', recs.length, `${longTail} long-tail · ${questions} questions`],
      ['Likely to rank', likely, `+${possible} "possible" · at authority ${siteAuth() === null ? '15 (assumed)' : siteAuth()}`],
      ['Seed difficulty', seedRec ? seedRec.kd.value : '-', seedRec ? `${seedRec.kd.basis} · ${seedRec.kd.confidence} confidence` : ''],
      ['Seed demand', seedRec ? (seedRec.volume !== undefined ? E.fmtNum(seedRec.volume) + '/mo' : E.demandTier(seedRec.demand.value)) : '-', seedRec && seedRec.volume !== undefined ? 'Google Ads monthly volume' : 'relative autocomplete index'],
      ['Trend', seedRec ? `<span class="trend-${seedRec.trend.label}">${seedRec.trend.label}</span>` : '-', seedRec ? `${seedRec.trend.signals} live signals` : ''],
      ['Wikipedia views/day', wikiAvg === null ? '-' : E.fmtNum(wikiAvg), w ? `"${esc(w.title)}" (30-day avg)` : 'no matching article'],
    ];
    $('#seedCards').innerHTML = cards.map(([l, v, s]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');
  }

  function renderSeedContext() {
    const { wiki, news, gdelt, hn, reddit } = S.seedCtx;
    const m = S.market;
    // Wikipedia
    if (wiki && wiki.daily.length) {
      C.line($('#chartWiki'), [{ name: 'Daily Wikipedia views', color: '#6366f1', points: wiki.daily }], { id: 'wiki', label: 'Wikipedia daily pageviews' });
      $('#wikiLabel').innerHTML = `<a href="${E.links.pageviews(wiki.title, m)}" target="_blank" rel="noopener">${esc(wiki.title)} pageviews &#8599;</a>`;
      const t = wiki.trend;
      let note = t ? `Last 14 days avg ${E.fmtNum(t.recentAvg)}/day vs ${E.fmtNum(t.baseAvg)}/day before (${E.pct(t.change)})${t.spike ? ' · <b>spike detected</b>' : ''}.` : '';
      if (wiki.seasonal) note += wiki.seasonal.seasonal ? ` Seasonal: peaks in <b>${wiki.seasonal.peakMonth}</b>, lowest in ${wiki.seasonal.troughMonth} (${wiki.seasonal.ratio}x swing).` : ' No strong seasonality over 3 years.';
      $('#wikiNote').innerHTML = note;
    } else {
      $('#chartWiki').innerHTML = `<div class="chart-empty">No Wikipedia article closely matches "${esc(S.seed)}". That usually means a niche or long-tail topic - often good news for ranking. Use the Google Trends chart for interest.</div>`;
      $('#wikiLabel').textContent = ''; $('#wikiNote').textContent = '';
    }
    // News
    if (gdelt && gdelt.length > 5) {
      C.line($('#chartNews'), [{ name: 'Global news articles/day (GDELT)', color: '#22d3ee', points: gdelt }], { id: 'gdelt', label: 'GDELT news volume', legend: true });
    } else if (news && news.items.length) {
      const counts = {};
      news.items.forEach((i) => { const d = i.date.toISOString().slice(0, 10); counts[d] = (counts[d] || 0) + 1; });
      const pts = []; for (let i = 30; i >= 0; i--) { const d = E.daysAgo(i).toISOString().slice(0, 10); pts.push({ date: d, v: counts[d] || 0 }); }
      C.line($('#chartNews'), [{ name: 'Google News articles/day', color: '#22d3ee', points: pts }], { id: 'gn', legend: true });
    } else {
      $('#chartNews').innerHTML = `<div class="chart-empty">${API.state.mode === 'direct' ? 'News charts need the backend (or GDELT returned no data).' : 'Little or no news coverage in the last 30-90 days - an evergreen topic rather than a news topic.'}</div>`;
    }
    const v = news && news.velocity;
    $('#newsNote').innerHTML = v ? `${v.last24} articles in 24h · ${v.last7} in 7 days · ${v.total}${v.saturated ? '+' : ''} in 30 days · velocity ${E.pct(v.velocity)} vs baseline. <a href="${E.links.news(S.seed, m)}" target="_blank" rel="noopener">Google News &#8599;</a> · <a href="${E.links.gdelt(S.seed)}" target="_blank" rel="noopener">GDELT &#8599;</a>` : `<a href="${E.links.gdelt(S.seed)}" target="_blank" rel="noopener">GDELT &#8599;</a>`;
    // Buzz
    const buzz = [];
    (news ? news.items.slice(0, 6) : []).forEach((n) => buzz.push(`<div class="buzz-item"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a><div class="s">News · ${esc(n.source)} · ${ago(n.date)}</div></div>`));
    (reddit || []).slice(0, 6).forEach((p) => buzz.push(`<div class="buzz-item"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><div class="s">${esc(p.subreddit)} · ${p.score} upvotes · ${p.comments} comments · ${ago(p.date)}</div></div>`));
    (hn && hn.hits || []).slice(0, 5).forEach((h) => buzz.push(`<div class="buzz-item"><a href="${esc(h.discuss)}" target="_blank" rel="noopener">${esc(h.title)}</a><div class="s">Hacker News · ${h.points} points · ${h.comments} comments · ${ago(h.date)}</div></div>`));
    $('#seedBuzz').innerHTML = buzz.length ? buzz.join('') : `<div class="muted small">No recent discussion found. Check <a href="${E.links.reddit(S.seed)}" target="_blank" rel="noopener">Reddit</a> or <a href="${E.links.youtube(S.seed)}" target="_blank" rel="noopener">YouTube</a> manually.</div>`;
  }

  function renderTrendsEmbed(seed) {
    $('#trendsLink').href = E.links.trends(seed, S.market);
    // Click-to-load: Google rate-limits Trends embeds (HTTP 429) aggressively, so we never burn quota automatically.
    $('#trendsEmbed').innerHTML = `<div class="chart-empty" style="flex-direction:column;gap:10px">
        <div>Google's own 12-month search-interest chart for "<b>${esc(seed)}</b>" in ${esc(S.market.label)}.</div>
        <button class="primary" id="loadTrends" type="button">Load Google Trends chart</button>
        <div class="small"><a href="${E.links.trends(seed, S.market)}" target="_blank" rel="noopener">Open 12 months &#8599;</a> · <a href="${E.links.trends5y(seed, S.market)}" target="_blank" rel="noopener">5 years &#8599;</a></div></div>`;
    $('#loadTrends').addEventListener('click', () => {
      $('#trendsEmbed').innerHTML = `<iframe loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Google Trends" src="${esc(E.links.trendsEmbed(seed, S.market))}"></iframe>
        <div class="muted small">Blank or blocked? Google is rate-limiting your network (HTTP 429). Try again in a few minutes, or <a href="${E.links.trends(seed, S.market)}" target="_blank" rel="noopener">open it on Google Trends</a>.</div>`;
    });
  }

  function whyLine(r) {
    const bits = [];
    if (r.rank.level >= 4) bits.push(`${r.rank.label.toLowerCase()} to rank`);
    if (r.kd.value <= 30) bits.push(`low KD ${r.kd.value}`);
    if (r.engines && r.engines.size >= 3) bits.push(`suggested by ${r.engines.size} engines`);
    if (/Breakout|Rising/.test(r.trend.label)) bits.push(`${r.trend.label.toLowerCase()} interest`);
    if (r.kd.weak && r.kd.weak.some((w) => w.type === 'ugc')) bits.push('forums on page 1');
    if (r.cls.types.includes('question')) bits.push('snippet-eligible question');
    if (r.volume) bits.push(`${E.fmtNum(r.volume)}/mo`);
    return bits.slice(0, 4).join(' · ') || `${r.cls.tail} ${r.cls.intent} keyword`;
  }

  function renderPicks() {
    const picks = [...S.recs].filter((r) => r.cls.intent !== 'navigational' && !r.cls.types.includes('dated')).sort((a, b) => b.opportunity - a.opportunity).slice(0, 8);
    $('#picks').innerHTML = picks.map((r) => `
      <div class="pick" data-kw="${esc(r.keyword)}">
        <div class="kw">${esc(r.keyword)}</div>
        <div class="badges">${intentBadge(r.cls.intent)}<span class="b">${r.cls.tail}</span><span class="rank-tag" style="color:${r.rank.color}">${r.rank.label}</span><span class="b trend-${r.trend.label}">${r.trend.label}</span></div>
        <div style="margin-top:8px">${meter(r.opportunity, false, r.opportunity)}</div>
        <div class="why">${esc(whyLine(r))}</div>
      </div>`).join('');
  }

  function passes(r) {
    const f = S.filter;
    const text = $('#filterText').value.trim().toLowerCase();
    if (text && !r.keyword.includes(text)) return false;
    if (r.kd.value > Number($('#filterKd').value)) return false;
    if (r.demand.value < Number($('#filterDemand').value)) return false;
    if (r.rank.level < Number($('#filterRank').value)) return false;
    if (f === 'all') return true;
    if (['head', 'mid-tail', 'long-tail'].includes(f)) return r.cls.tail === f;
    if (['informational', 'commercial', 'transactional'].includes(f)) return r.cls.intent === f;
    if (f === 'rising') return /Breakout|Rising/.test(r.trend.label);
    return r.cls.types.includes(f);
  }
  const SORTERS = {
    keyword: (r) => r.keyword, tail: (r) => r.cls.words, intent: (r) => r.cls.intent,
    demand: (r) => (r.volume !== undefined ? 1000 + r.volume : r.demand.value), kd: (r) => r.kd.value,
    rank: (r) => r.rank.chance, trend: (r) => r.trend.value, opportunity: (r) => r.opportunity,
  };

  function renderTable() {
    const key = SORTERS[S.sort.key] || SORTERS.opportunity;
    const dir = S.sort.dir === 'asc' ? 1 : -1;
    const rows = S.recs.filter(passes).sort((a, b) => { const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
    $('#kwCount').textContent = rows.length === S.recs.length ? rows.length : `${rows.length}/${S.recs.length}`;
    $('#kwTable tbody').innerHTML = rows.map((r) => {
      const eng = ENGINES.filter(([e]) => S.enginesQueried.includes(e)).map(([e, n]) => `<span class="eng ${r.engines.has(e) ? 'on' : ''}" title="${n}${r.bestPos[e] ? ' #' + r.bestPos[e] : ''}">${ENG_SHORT[e]}</span>`).join('');
      const demandLabel = r.volume !== undefined ? E.fmtNum(r.volume) : r.demand.value;
      return `<tr data-kw="${esc(r.keyword)}" class="${r.isSeed ? 'seed-row' : ''}">
        <td class="kwc">${esc(r.keyword)}${r.trendingMatch ? ' <span class="b" style="color:#a855f7" title="On Google Trending Now">&#128293; trending</span>' : ''}</td>
        <td><span class="b">${r.cls.tail}</span>${r.cls.types.includes('question') ? ' <span class="b">?</span>' : ''}</td>
        <td>${intentBadge(r.cls.intent)}</td>
        <td title="${r.demand.basis === 'volume' ? 'Google Ads monthly searches' : 'Relative demand index 0-100'}">${meter(r.demand.value, false, demandLabel)}</td>
        <td title="${r.kd.basis} · ${r.kd.confidence} confidence">${meter(r.kd.value, true, r.kd.value + (r.kd.basis === 'heuristic' ? '~' : ''))}</td>
        <td><span class="rank-tag" style="color:${r.rank.color}">${r.rank.label}</span></td>
        <td>${r.trend.label === 'Unknown' ? '<span class="trend-tag trend-Unknown" title="Not measured yet - deep analysis covers the top keywords; open this one to measure it">&ndash;</span>' : `<span class="trend-tag trend-${r.trend.label}">${r.trend.label === 'Breakout' ? '&#9650;&#9650; ' : r.trend.label === 'Rising' ? '&#9650; ' : r.trend.label === 'Declining' ? '&#9660; ' : ''}${r.trend.label}</span>`}</td>
        <td><span class="opp" style="color:${meterColor(r.opportunity)}">${r.opportunity}</span></td>
        <td><div class="engines">${eng}</div></td>
      </tr>`;
    }).join('') || '<tr><td colspan="9" class="muted">No keywords match these filters.</td></tr>';
  }

  /* ============================== content plan ============================== */
  function renderPlan() {
    $('#planSeed').textContent = S.seed ? `for "${S.seed}"` : '';
    if (!S.recs.length) { $('#plan').innerHTML = '<div class="empty-state"><p>Run an analysis in Discover first.</p></div>'; return; }
    const clusters = E.clusterKeywords(S.recs.filter((r) => r.cls.intent !== 'navigational'), S.seed);
    S.clusters = clusters;
    $('#plan').innerHTML = clusters.map((c, i) => `
      <div class="card cluster">
        <div class="cluster-head">
          <h3>${i + 1}. ${esc(c.name)} <span class="pill">${c.items.length}</span></h3>
          <span class="muted small">avg KD ${c.avgKd} · ${c.questions.length} question${c.questions.length === 1 ? '' : 's'} · cluster score ${c.score}</span>
        </div>
        <div class="muted small">Pillar / main article: <a href="#" data-kw="${esc(c.pillar.keyword)}"><b>${esc(c.pillar.keyword)}</b></a> - ${esc(E.titleIdeas(c.pillar.keyword, c.pillar.cls)[0])}</div>
        <ol>${c.items.slice(0, 15).map((r) => `<li data-kw="${esc(r.keyword)}">${r === c.pillar ? '<span class="pillar-tag">pillar</span>' : ''}${esc(r.keyword)} <span class="muted small">· KD ${r.kd.value} · ${r.rank.label} · opp ${r.opportunity}</span></li>`).join('')}</ol>
        ${c.items.length > 15 ? `<div class="muted small">+${c.items.length - 15} more (see table)</div>` : ''}
      </div>`).join('');
  }

  function planMarkdown() {
    const L = [`# Content plan: ${S.seed}`, '', `Market: ${S.market.label} · generated ${new Date().toISOString().slice(0, 10)} by RankScope`, ''];
    (S.clusters || []).forEach((c, i) => {
      L.push(`## ${i + 1}. ${c.name}`, '', `**Pillar:** ${c.pillar.keyword} - _${E.titleIdeas(c.pillar.keyword, c.pillar.cls)[0]}_`, '', '| Keyword | Intent | KD | Rankability | Trend | Opp |', '|---|---|---|---|---|---|');
      c.items.forEach((r) => L.push(`| ${r.keyword} | ${r.cls.intent} | ${r.kd.value} | ${r.rank.label} | ${r.trend.label} | ${r.opportunity} |`));
      L.push('');
    });
    return L.join('\n');
  }

  /* ================================ drawer ================================ */
  function related(rec) {
    const seedT = new Set(E.coreTokens(S.seed));
    const own = E.coreTokens(rec.keyword).filter((t) => !seedT.has(t));
    let rel = S.recs.filter((r) => r !== rec && (own.length ? E.coreTokens(r.keyword).some((t) => own.includes(t)) : true));
    if (rel.length < 6) rel = rel.concat(S.recs.filter((r) => r !== rec && !rel.includes(r)));
    return rel.sort((a, b) => b.opportunity - a.opportunity).slice(0, 20);
  }

  function partsTable(parts) {
    return `<table class="parts">${parts.map((p) => `<tr><td>${esc(p.label)}</td><td>${p.delta > 0 ? '+' : ''}${typeof p.delta === 'number' ? Math.round(p.delta * 10) / 10 : esc(p.delta)}</td></tr>`).join('')}</table>`;
  }

  function renderDrawer(rec) {
    const m = S.market;
    const c = rec.cls;
    const dp = rec.demand.parts;
    const demandParts = rec.demand.basis === 'volume'
      ? [{ label: `Google Ads monthly volume ${E.fmtNum(rec.volume)}`, delta: rec.demand.value }]
      : [
        { label: `Engines suggesting it: ${rec.engines.size}/${S.enginesQueried.length}`, delta: Math.round(dp.cross * 25) },
        { label: 'Rank when typing the bare seed', delta: Math.round(dp.direct * 20) },
        { label: 'Best suggestion position anywhere', delta: Math.round(dp.best * 15) },
        { label: `Triggered by ${rec.hits} different prefixes`, delta: Math.round(Math.min(1, Math.max(0, (rec.hits - 1) / 4)) * 12) },
        { label: rec.rel !== undefined ? `Google suggestion relevance ${rec.rel}` : 'Google relevance n/a (neutral)', delta: Math.round((rec.rel !== undefined ? Math.min(1, Math.max(0, (rec.rel - 550) / 750)) : 0.35) * 18) },
        { label: `Phrase length (${c.words} words)`, delta: Math.round(dp.brevity * 10) },
      ];
    $('#dMeta').innerHTML = `${intentBadge(c.intent)} <span class="b">${c.tail} · ${c.words} words</span> ${c.types.map((t) => `<span class="b">${t}</span>`).join(' ')}`;
    $('#dTitle').textContent = rec.keyword;
    $('#dGoogle').href = E.links.google(rec.keyword, m);
    $('#dWatch').textContent = isWatched(rec.keyword) ? '✓ Watching' : '+ Watch';
    const rk = rec.rank;
    const kd = rec.kd;
    const serpRows = kd.rows ? `
      <div class="card"><div class="card-head"><h3>Live Google top 10</h3><span class="muted small">authority ${Object.keys(S.authMap).length ? 'from Open PageRank' : 'approximate (add OPR key)'}; green = beatable</span></div>
      <div class="table-wrap"><table class="kw-table serp-table"><thead><tr><th>#</th><th>Result</th><th>Domain</th><th>Authority</th><th>Title match</th></tr></thead><tbody>
      ${kd.rows.map((r) => `<tr><td>${r.position}</td><td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title.slice(0, 80))}</a>${r.outdated ? ' <span class="b">outdated</span>' : ''}${r.ugc ? ' <span class="b">forum/UGC</span>' : ''}</td><td>${esc(r.domain)}</td><td class="${r.authority <= (siteAuth() === null ? 15 : siteAuth()) + 5 || r.ugc ? 'weak' : ''}">${r.authority}${r.authorityKnown ? '' : '?'}</td><td>${Math.round(r.titleMatch * 100)}%</td></tr>`).join('')}
      </tbody></table></div>
      ${rec.serp.paa.length ? `<h3 style="margin-top:12px">People also ask</h3><ul>${rec.serp.paa.map((p) => `<li>${esc(p.question)}</li>`).join('')}</ul>` : ''}
      ${rec.serp.related.length ? `<div class="muted small">Related searches: ${rec.serp.related.map((r) => `<a href="#" data-kw-seed="${esc(r)}">${esc(r)}</a>`).join(' · ')}</div>` : ''}
      </div>` : `<div class="card"><h3>SERP analysis</h3><p class="muted small">Difficulty here is <b>estimated</b>. Add a free Serper.dev key on your server to measure the live top 10, weak spots and People Also Ask. Meanwhile, <a href="${E.links.google(rec.keyword, m)}" target="_blank" rel="noopener">inspect the SERP yourself</a>: look for forums, thin pages and outdated titles on page 1.</p></div>`;

    const rel = related(rec);
    $('#dBody').innerHTML = `
      <div class="gauges">
        <div class="g"><div class="t">Demand</div>${C.gauge(rec.demand.value, { label: rec.volume !== undefined ? E.fmtNum(rec.volume) + '/mo' : E.demandTier(rec.demand.value) })}</div>
        <div class="g"><div class="t">Difficulty</div>${C.gauge(kd.value, { invert: true, label: kd.basis })}<div class="x">${kd.confidence} confidence</div></div>
        <div class="g"><div class="t">Your chance</div>${C.gauge(rk.chance, { color: rk.color, label: 'rank index' })}<div class="x" style="color:${rk.color}">${rk.label}</div></div>
        <div class="g"><div class="t">Opportunity</div>${C.gauge(rec.opportunity, { label: rec.trend.label })}</div>
      </div>
      <div class="verdict" style="border-color:${rk.color};background:color-mix(in srgb, ${rk.color} 10%, var(--card))">
        <h3 style="color:${rk.color}">${rk.label} to reach page 1${rk.assumed ? ' (for a new/small site)' : ''}</h3>
        <ul>${rk.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>
      <div class="grid-2">
        <div class="card"><h3>Why this demand score</h3>${partsTable(demandParts)}${rec.cpc ? `<div class="muted small">CPC ~$${E.round(rec.cpc, 2)} (advertiser value)</div>` : ''}</div>
        <div class="card"><h3>Why this difficulty</h3>${partsTable(kd.parts)}<div class="muted small">= ${kd.value}/100</div></div>
      </div>
      <div class="card"><h3>Trend signals</h3>${rec.trend.parts.length ? partsTable(rec.trend.parts) : '<div class="muted small">No live trend signals measured yet for this keyword.</div>'}
        <div id="dTrendChart" class="chart" style="min-height:0"></div>
        <div class="small"><a href="${E.links.trends(rec.keyword, m)}" target="_blank" rel="noopener">Google Trends 12m &#8599;</a> · <a href="${E.links.trends5y(rec.keyword, m)}" target="_blank" rel="noopener">5y &#8599;</a> · <a href="${E.links.news(rec.keyword, m)}" target="_blank" rel="noopener">News &#8599;</a> · <a href="${E.links.reddit(rec.keyword)}" target="_blank" rel="noopener">Reddit &#8599;</a> · <a href="${E.links.youtube(rec.keyword)}" target="_blank" rel="noopener">YouTube &#8599;</a></div>
      </div>
      ${serpRows}
      <div class="card"><h3>Evidence (${rec.evidence.length})</h3><ul class="evidence">${rec.evidence.map((e) => `<li><span class="str ${e.strength}">${e.strength}</span><span>${esc(e.text)}</span>${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.linkLabel || 'source')} &#8599;</a>` : ''}</li>`).join('')}</ul></div>
      ${rec.newsItems && rec.newsItems.length ? `<div class="card"><h3>Latest coverage</h3>${rec.newsItems.map((n) => `<div class="buzz-item"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a><div class="s">${esc(n.source)} · ${ago(n.date)}</div></div>`).join('')}</div>` : ''}
      <div class="card"><h3>How to write the article that ranks</h3><ul class="tips">${E.tips(rec, m).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <h3 style="margin-top:12px">Title ideas</h3><ul class="tips">${E.titleIdeas(rec.keyword, c).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <div class="muted small">Target length: ${E.wordCountGuide(c)} words · Schema: ${E.schemaFor(c).join(', ')}</div></div>
      <div class="card"><h3>Related keywords to cover in the same article</h3><div class="chips">${rel.slice(0, 16).map((r) => `<span class="chip" data-kw="${esc(r.keyword)}">${esc(r.keyword)} <span class="muted">${r.kd.value}</span></span>`).join('')}</div></div>
      <div class="card"><h3>Article brief (Markdown)</h3><pre class="brief" id="dBrief">${esc(E.brief(rec, rel, m))}</pre></div>`;
    const series = [];
    if (rec.monthly && rec.monthly.length) series.push({ name: 'Google monthly searches', color: '#22c55e', points: rec.monthly });
    else if (rec.wikiDaily && rec.wikiDaily.length) series.push({ name: `Wikipedia: ${rec.wikiTitle}`, color: '#6366f1', points: rec.wikiDaily });
    if (series.length) { $('#dTrendChart').style.minHeight = '200px'; C.line($('#dTrendChart'), series, { id: 'd', monthly: !!rec.monthly, legend: true, height: 200 }); }
  }

  async function openDrawer(kw) {
    const rec = S.byKw.get(kw);
    if (!rec) return;
    S.open = rec;
    renderDrawer(rec);
    $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#scrim').hidden = false;
    $('#drawer').scrollTop = 0;
    const changed = await enrichOne(rec);
    if (changed && S.open === rec) { renderDrawer(rec); renderTable(); }
  }
  function closeDrawer() { S.open = null; $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#scrim').hidden = true; }

  /* ============================== live trends ============================== */
  async function refreshLive() {
    API.clearMemo();
    $('#trendGeo').textContent = S.market.label;
    const y = E.daysAgo(1), y2 = E.daysAgo(2);
    const z = (n) => String(n).padStart(2, '0');
    const wtopParams = (d) => ({ hl: S.market.hl, y: String(d.getUTCFullYear()), m: z(d.getUTCMonth() + 1), d: z(d.getUTCDate()) });
    const [tr, hnf] = await Promise.all([body('trends', { gl: S.market.gl }), body('hnfront', {})]);
    let wt = await body('wtop', wtopParams(y)); let wDate = y;
    if (!wt) { wt = await body('wtop', wtopParams(y2)); wDate = y2; }

    const analyzeBtn = (q) => `<a href="#" class="go" data-kw-seed="${esc(q)}">Analyze &rarr;</a>`;
    const mark = (set, key) => { const isNew = S.lastLive.init && !set.has(key); return isNew ? ' new' : ''; };

    S.trending = tr ? E.parseTrendsRss(tr) : S.trending;
    const newT = new Set(S.trending.map((t) => t.title));
    $('#liveTrends').innerHTML = tr ? S.trending.map((t, i) => `<div class="live-item${mark(S.lastLive.trends, t.title)}"><div class="rk">${i + 1}</div><div class="body"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.traffic || '')} searches${t.news[0] ? ` · <a href="${esc(t.news[0].url)}" target="_blank" rel="noopener">${esc(t.news[0].source)}: ${esc(t.news[0].title.slice(0, 70))}</a>` : ''}</div></div>${analyzeBtn(t.title)}</div>`).join('')
      : `<div class="muted small">${API.state.mode === 'direct' ? 'Google Trends needs the backend (PHP or Node). See README.' : 'Google Trends did not respond. It will retry on the next refresh.'} <a href="https://trends.google.com/trending?geo=${S.market.gl.toUpperCase()}" target="_blank" rel="noopener">Open Trending Now &#8599;</a></div>`;

    const wl = E.parseWikiTop(wt, 40);
    const newW = new Set(wl.map((w) => w.title));
    $('#wikiTopDate').textContent = wt ? `${S.market.hl}.wikipedia · ${wDate.toISOString().slice(0, 10)}` : '';
    $('#liveWiki').innerHTML = wl.length ? wl.map((w, i) => `<div class="live-item${mark(S.lastLive.wiki, w.title)}"><div class="rk">${i + 1}</div><div class="body"><div class="t"><a href="${E.links.wiki(w.title, S.market)}" target="_blank" rel="noopener">${esc(w.title)}</a></div><div class="s">${E.fmtNum(w.views)} views · <a href="${E.links.pageviews(w.title, S.market)}" target="_blank" rel="noopener">graph</a></div></div>${analyzeBtn(w.title)}</div>`).join('') : '<div class="muted small">Wikipedia top list unavailable right now.</div>';

    const hl = E.parseHN(hnf).hits;
    const newH = new Set(hl.map((h) => h.title));
    $('#liveHN').innerHTML = hl.length ? hl.map((h, i) => `<div class="live-item${mark(S.lastLive.hn, h.title)}"><div class="rk">${i + 1}</div><div class="body"><div class="t"><a href="${esc(h.discuss)}" target="_blank" rel="noopener">${esc(h.title)}</a></div><div class="s">${h.points} points · ${h.comments} comments · ${ago(h.date)}</div></div></div>`).join('') : '<div class="muted small">Hacker News unavailable right now.</div>';

    S.lastLive = { trends: newT, wiki: newW, hn: newH, init: true };
    $('#liveUpdated').textContent = `updated ${new Date().toLocaleTimeString()}`;
    if (S.recs.length) { rescoreAll(); renderTable(); }
  }

  function setLive(on) {
    S.live = on;
    $('#liveToggle').classList.toggle('on', on);
    $('#liveText').textContent = on ? 'LIVE' : 'LIVE OFF';
    clearInterval(S.liveTimer);
    if (on) {
      const tick = () => { refreshLive(); refreshWatch(); };
      tick();
      S.liveTimer = setInterval(tick, Number($('#liveInterval').value) * 60000);
    }
    store.set('live', on);
  }

  /* ================================ watchlist ================================ */
  const getWatch = () => store.get('watch', []);
  const isWatched = (kw) => getWatch().some((w) => w.keyword === kw && w.market === S.market.id);
  function toggleWatch(kw) {
    let list = getWatch();
    if (list.some((w) => w.keyword === kw && w.market === S.market.id)) list = list.filter((w) => !(w.keyword === kw && w.market === S.market.id));
    else { list.push({ keyword: kw, market: S.market.id, added: new Date().toISOString(), snaps: [] }); toast(`Watching "${kw}"`); }
    store.set('watch', list);
    renderWatch();
    if (list.some((w) => w.keyword === kw && !w.snaps.length)) refreshWatch();
  }

  async function checkWatch(w) {
    const m = MARKETS.find((x) => x.id === w.market) || S.market;
    const p = { hl: m.hl, gl: m.gl };
    const [sg, newsXml, sr] = await Promise.all([API.get('g', { q: w.keyword, ...p }), body('news', { q: w.keyword, ...p }), body('wsearch', { q: w.keyword, hl: m.hl })]);
    const sugg = sg && sg.ok ? E.parseSuggest(sg.body) : [];
    const items = newsXml ? E.parseNewsRss(newsXml) : [];
    const vel = newsXml ? E.newsVelocity(items) : null;
    const title = E.pickWikiArticle(w.keyword, E.parseWikiSearch(sr).results);
    let wiki = null, wTrend = null;
    if (title) {
      const daily = E.parseWikiViews(await body('wviews', { article: title, hl: m.hl, gran: 'daily', start: E.ymd(E.daysAgo(91)) + '00', end: E.ymd(E.daysAgo(1)) + '00' }));
      wiki = daily.length ? Math.round(E.avg(daily.slice(-7).map((d) => d.v))) : null;
      wTrend = E.trendFromDaily(daily);
    }
    const t = E.trendScore({ wiki: wTrend, news: vel, trending: !!E.matchesTrending(w.keyword, S.trending) });
    return { t: new Date().toISOString(), ac: sugg.length, news7: vel ? vel.last7 : null, wiki, trend: t.value, label: t.label };
  }

  async function refreshWatch() {
    const list = getWatch();
    if (!list.length) return;
    for (const w of list) {
      try {
        const snap = await checkWatch(w);
        const cur = getWatch();
        const it = cur.find((x) => x.keyword === w.keyword && x.market === w.market);
        if (!it) continue;
        const last = it.snaps[it.snaps.length - 1];
        // Keep at most one snapshot per 10 minutes, 200 total
        if (last && Date.now() - new Date(last.t).getTime() < 600000) it.snaps[it.snaps.length - 1] = snap; else it.snaps.push(snap);
        it.snaps = it.snaps.slice(-200);
        store.set('watch', cur);
      } catch (_) { /* skip */ }
      renderWatch();
    }
    $('#watchUpdated').textContent = `checked ${new Date().toLocaleTimeString()}`;
  }

  function renderWatch() {
    const list = getWatch();
    $('#watchCount').textContent = list.length;
    $('#watchTable tbody').innerHTML = list.length ? list.map((w, i) => {
      const s = w.snaps[w.snaps.length - 1] || {};
      const prev = w.snaps[w.snaps.length - 2];
      const delta = prev && s.trend !== undefined ? s.trend - prev.trend : 0;
      return `<tr data-i="${i}"><td class="kwc"><a href="#" data-kw-seed="${esc(w.keyword)}">${esc(w.keyword)}</a></td><td>${esc(w.market)}</td>
        <td>${s.ac !== undefined ? s.ac + ' suggestions' : '<span class="spin"></span>'}</td><td>${s.news7 === null || s.news7 === undefined ? '-' : s.news7}</td><td>${s.wiki ? E.fmtNum(s.wiki) : '-'}</td>
        <td>${s.label ? `<span class="trend-tag trend-${s.label}">${s.label}</span> <span class="muted small">${s.trend}${delta ? (delta > 0 ? ' ▲' : ' ▼') + Math.abs(delta) : ''}</span>` : '-'}</td>
        <td>${C.spark(w.snaps.map((x) => x.trend))}</td><td class="muted small">${s.t ? ago(s.t) : '-'}</td>
        <td><button class="ghost" data-unwatch="${i}" title="Remove">&times;</button></td></tr>`;
    }).join('') : '<tr><td colspan="9" class="muted">No keywords yet. Open any keyword and click "+ Watch".</td></tr>';
  }

  /* =============================== settings =============================== */
  function renderSources() {
    const cfg = API.state.config || {};
    const labels = Object.assign({
      g: 'Google Autocomplete', yt: 'YouTube Autocomplete', bing: 'Bing Autosuggest', ddg: 'DuckDuckGo Autocomplete', amz: 'Amazon Autocomplete',
      trends: 'Google Trends', news: 'Google News', gdelt: 'GDELT', wsearch: 'Wikipedia Search', wviews: 'Wikipedia Pageviews', wtop: 'Wikipedia Top',
      hn: 'Hacker News', hnfront: 'HN Front Page', reddit: 'Reddit', serp: 'Google SERP (Serper)', opr: 'Open PageRank', dfsvol: 'DataForSEO Volume', dfskd: 'DataForSEO KD',
    }, cfg.sources || {});
    $('#sourceStatus').innerHTML = Object.entries(labels).map(([k, label]) => {
      const h = API.state.health[k];
      const avail = API.available(k);
      let st = '<span class="st idle">ready</span>';
      if (!avail) st = `<span class="st off">${API.state.mode === 'direct' ? 'needs backend' : 'no API key'}</span>`;
      else if (h) st = h.fail && !h.ok ? `<span class="st bad" title="${esc(h.error)}">failing</span>` : `<span class="st ok">ok ${h.ok}${h.fail ? ` / ${h.fail} failed` : ''}</span>`;
      return `<div class="src-row"><span>${esc(label)}</span>${st}</div>`;
    }).join('');
  }

  function banner(html) { const b = $('#banner'); b.innerHTML = html; b.hidden = !html; }

  async function connect() {
    const info = await API.init(settings.api || 'api/', settings.token);
    const badge = $('#modeBadge');
    badge.className = 'mode-badge ' + info.mode;
    badge.textContent = info.mode === 'proxy' ? `${info.config.backend.toUpperCase()} backend` : 'Browser-only';
    const k = info.config.keyed || {};
    const keyedOn = Object.values(k).filter(Boolean).length;
    $('#connInfo').innerHTML = info.mode === 'proxy'
      ? `Connected to the ${esc(info.config.backend)} backend. Paid sources: ${['serp', 'opr', 'dfsvol'].map((s) => `${s} ${k[s] ? '✓' : '✗'}`).join(' · ')}${info.config.tokenRequired ? ' · access token required' : ''}`
      : 'No backend found - running in browser-only mode.';
    if (info.mode === 'direct') banner('<b>Browser-only mode.</b> Google, YouTube and DuckDuckGo autocomplete, Wikipedia, GDELT and Hacker News work. Bing, Amazon, Google Trends, Google News and Reddit need the free PHP or Node backend (see README). Difficulty is estimated until a SERP key is added.');
    else if (!keyedOn) banner('Running on free sources. Difficulty is <b>estimated</b>. Add a free <a href="https://serper.dev" target="_blank" rel="noopener">Serper.dev</a> key (and optionally Open PageRank / DataForSEO) in <code>api/config.php</code> for measured KD, live top-10 analysis and real search volumes.');
    else banner('');
    renderSources();
  }

  /* ================================ history ================================ */
  function addHistory(seed) { const h = [seed, ...store.get('history', []).filter((x) => x !== seed)].slice(0, 12); store.set('history', h); renderHistory(); }
  function renderHistory() { $('#history').innerHTML = store.get('history', []).map((h) => `<span class="chip" data-kw-seed="${esc(h)}">${esc(h)}</span>`).join(''); }

  /* ================================= wiring ================================= */
  function fillMarkets(sel, val) { sel.innerHTML = MARKETS.map((m) => `<option value="${m.id}">${m.label}</option>`).join(''); sel.value = val; }

  function bind() {
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
      if (t.dataset.tab === 'live' && !S.lastLive.init) refreshLive();
      if (t.dataset.tab === 'settings') renderSources();
      if (t.dataset.tab === 'watch') renderWatch();
    }));
    $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); goTab('discover'); analyze($('#seed').value); });
    $('#market').addEventListener('change', (e) => { S.market = MARKETS.find((m) => m.id === e.target.value) || MARKETS[0]; if (S.seed) analyze(S.seed); if (S.lastLive.init) { S.lastLive.init = false; refreshLive(); } });
    $('#liveToggle').addEventListener('click', () => setLive(!S.live));
    $('#liveInterval').addEventListener('change', () => { if (S.live) setLive(true); });
    $('#liveRefresh').addEventListener('click', refreshLive);
    $('#watchRefresh').addEventListener('click', refreshWatch);

    // delegated clicks
    document.addEventListener('click', (e) => {
      const seedEl = e.target.closest('[data-kw-seed]');
      if (seedEl) { e.preventDefault(); closeDrawer(); goTab('discover'); analyze(seedEl.dataset.kwSeed); return; }
      const un = e.target.closest('[data-unwatch]');
      if (un) { const l = getWatch(); l.splice(Number(un.dataset.unwatch), 1); store.set('watch', l); renderWatch(); return; }
      const kwEl = e.target.closest('[data-kw]');
      if (kwEl && !e.target.closest('a[href^="http"]')) { e.preventDefault(); openDrawer(kwEl.dataset.kw); }
    });
    $$('#kwTable th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.sort;
      S.sort = { key: k, dir: S.sort.key === k && S.sort.dir === 'desc' ? 'asc' : 'desc' };
      $$('#kwTable th').forEach((x) => x.classList.remove('sorted', 'asc', 'desc'));
      th.classList.add('sorted', S.sort.dir);
      renderTable();
    }));
    $('#filterChips').innerHTML = FILTERS.map(([k, l]) => `<span class="chip ${k === 'all' ? 'on' : ''}" data-filter="${k}">${l}</span>`).join('');
    $('#filterChips').addEventListener('click', (e) => { const c = e.target.closest('[data-filter]'); if (!c) return; e.stopPropagation(); S.filter = c.dataset.filter; $$('#filterChips .chip').forEach((x) => x.classList.toggle('on', x === c)); renderTable(); });
    ['#filterText', '#filterKd', '#filterDemand', '#filterRank'].forEach((s) => $(s).addEventListener('input', () => { $('#filterKdV').textContent = $('#filterKd').value; $('#filterDemandV').textContent = $('#filterDemand').value; renderTable(); }));

    $('#exportCsv').addEventListener('click', () => download(`rankscope-${slug(S.seed)}.csv`, E.toCsv(S.recs), 'text/csv'));
    $('#exportJson').addEventListener('click', () => download(`rankscope-${slug(S.seed)}.json`, JSON.stringify({
      seed: S.seed, market: S.market, generated: new Date().toISOString(),
      keywords: S.recs.map((r) => ({ keyword: r.keyword, class: r.cls, demand: r.demand, volume: r.volume, cpc: r.cpc, kd: { value: r.kd.value, basis: r.kd.basis, confidence: r.kd.confidence, parts: r.kd.parts }, rankability: r.rank, trend: r.trend, opportunity: r.opportunity, engines: [...r.engines], evidence: r.evidence })),
    }, null, 2), 'application/json'));
    $('#shareLink').addEventListener('click', () => copy(location.href));
    $('#watchSeed').addEventListener('click', () => S.seed && toggleWatch(S.seed));
    $('#exportPlan').addEventListener('click', () => S.recs.length && download(`content-plan-${slug(S.seed)}.md`, planMarkdown(), 'text/markdown'));

    $('#dClose').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    $('#dWatch').addEventListener('click', () => { if (S.open) { toggleWatch(S.open.keyword); $('#dWatch').textContent = isWatched(S.open.keyword) ? '✓ Watching' : '+ Watch'; } });
    $('#dSeed').addEventListener('click', () => { if (S.open) { const k = S.open.keyword; closeDrawer(); analyze(k); } });
    $('#dCopyBrief').addEventListener('click', () => S.open && copy(E.brief(S.open, related(S.open), S.market)));
    $('#dDownloadBrief').addEventListener('click', () => S.open && download(`brief-${slug(S.open.keyword)}.md`, E.brief(S.open, related(S.open), S.market), 'text/markdown'));

    // settings
    $('#setDomain').value = settings.domain; $('#setAuth').value = settings.auth; $('#setTopN').value = settings.topN;
    $('#setApi').value = settings.api; $('#setToken').value = settings.token;
    fillMarkets($('#setMarket'), settings.market);
    const persist = () => {
      settings.domain = $('#setDomain').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      settings.auth = $('#setAuth').value === '' ? '' : String(Math.max(0, Math.min(100, Number($('#setAuth').value))));
      settings.topN = Number($('#setTopN').value) || 15;
      settings.market = $('#setMarket').value;
      saveSettings();
      if (S.recs.length) { rescoreAll(); renderAll(); }
    };
    ['#setDomain', '#setAuth', '#setTopN', '#setMarket'].forEach((s) => $(s).addEventListener('change', persist));
    $('#setEngines').innerHTML = ENGINES.map(([k, l]) => `<span class="chip ${settings.engines.includes(k) ? 'on' : ''}" data-eng="${k}">${l}</span>`).join('');
    $('#setEngines').addEventListener('click', (e) => {
      const c = e.target.closest('[data-eng]'); if (!c) return; e.stopPropagation();
      const k = c.dataset.eng;
      settings.engines = settings.engines.includes(k) ? settings.engines.filter((x) => x !== k) : [...settings.engines, k];
      if (!settings.engines.length) settings.engines = ['g'];
      saveSettings();
      $$('#setEngines .chip').forEach((x) => x.classList.toggle('on', settings.engines.includes(x.dataset.eng)));
    });
    $('#saveConn').addEventListener('click', async () => { settings.api = $('#setApi').value.trim() || 'api/'; settings.token = $('#setToken').value; saveSettings(); await connect(); toast('Reconnected'); });
    $('#detectAuth').addEventListener('click', async () => {
      persist();
      if (!settings.domain) return ($('#detectAuthMsg').textContent = 'Enter your domain first.');
      if (!API.available('opr')) return ($('#detectAuthMsg').textContent = 'Needs OPR_API_KEY on the server. Or enter your Ahrefs DR / Moz DA manually.');
      $('#detectAuthMsg').textContent = 'Checking...';
      const map = E.parseOpr(await body('opr', { domains: settings.domain }));
      const v = map[settings.domain];
      if (v === undefined) return ($('#detectAuthMsg').textContent = 'Not found in Open PageRank (new sites often are not). Try 5-10.');
      $('#setAuth').value = Math.round(v); persist();
      $('#detectAuthMsg').textContent = `Open PageRank: ${v}/100 saved.`;
    });
    $('#clearData').addEventListener('click', () => { if (!confirm('Clear search history and watchlist from this browser?')) return; store.set('history', []); store.set('watch', []); API.clearMemo(); renderHistory(); renderWatch(); toast('Cleared'); });
    API.onHealth(() => { if ($('#tab-settings').classList.contains('active')) renderSources(); });
  }
  function goTab(name) { const t = $(`.tab[data-tab="${name}"]`); if (t && !t.classList.contains('active')) t.click(); }

  async function boot() {
    fillMarkets($('#market'), S.market.id);
    $('#examples').innerHTML = EXAMPLES.map((x) => `<span class="chip" data-kw-seed="${esc(x)}">${esc(x)}</span>`).join('');
    bind();
    renderHistory();
    renderWatch();
    renderPlan();
    await connect();
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('m')) { const m = MARKETS.find((x) => x.id === h.get('m')); if (m) { S.market = m; $('#market').value = m.id; } }
    if (h.get('d')) $('#depth').value = h.get('d');
    if (h.get('k')) S.pendingOpen = h.get('k');
    if (h.get('tab')) goTab(h.get('tab'));
    if (h.get('q')) analyze(h.get('q'));
    if (store.get('live', false)) setLive(true);
  }
  boot();
})();
