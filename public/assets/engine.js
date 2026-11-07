/*!
 * RankScope Engine - pure keyword-intelligence functions.
 * No network, no DOM. Runs in the browser (window.RSEngine) and in Node (require).
 * Every score here is explainable: each function returns the inputs it used so the
 * UI can show "why" next to every number.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RSEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* =========================== constants =========================== */

  const STOPWORDS = new Set((
    'a an the and or of to in on at for from by with without is are was were be been being do does did can could ' +
    'should would will shall may might must it its this that these those i me my you your we our they their he she ' +
    'his her them what why how when where who whom which whose there here as into about than then so if not no yes ' +
    'vs versus near me best top'
  ).split(' '));
  // Tokens that carry meaning for clustering even though they are short / common.
  const CLUSTER_KEEP = new Set(['vs', 'best', 'top', 'near', 'free', 'cheap']);
  // Filler words that carry no topical meaning for grouping.
  const CLUSTER_STOP = new Set(('good bad has have had just up put use used get got become cause started different much many really ever ' +
    'still also need want way thing things one ones more less like go going take make made making long much does doe').split(' '));

  const QUESTION_WORDS = ['how', 'what', 'why', 'when', 'where', 'who', 'which', 'can', 'is', 'are', 'does', 'do', 'should', 'will', 'could', 'would', 'did', 'was'];
  const QUESTION_PREFIXES = ['how to', 'how', 'what is', 'what', 'why', 'when', 'where', 'who', 'which', 'can', 'is', 'are', 'does', 'should', 'will'];
  const SUFFIX_MODIFIERS = ['for', 'vs', 'without', 'with', 'near me', 'best', 'ideas', 'examples', 'tips', 'guide', 'cost', 'reddit', 'for beginners', 'alternatives'];
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

  const UGC_DOMAINS = [
    'reddit.com', 'quora.com', 'medium.com', 'pinterest.com', 'stackexchange.com', 'stackoverflow.com', 'tumblr.com',
    'blogspot.com', 'wordpress.com', 'facebook.com', 'x.com', 'twitter.com', 'tiktok.com', 'instagram.com',
    'linkedin.com', 'substack.com', 'answers.com', 'wikihow.com', 'fandom.com', 'tripadvisor.com', 'yahoo.com',
    'steamcommunity.com', 'discord.com', 'github.com', 'dev.to', 'hashnode.dev', 'weebly.com', 'wixsite.com',
  ];
  // Fallback authority (0-100) when no Open PageRank key is configured. Widely known approximations.
  const KNOWN_AUTH = {
    'google.com': 100, 'youtube.com': 100, 'facebook.com': 100, 'wikipedia.org': 98, 'linkedin.com': 98, 'apple.com': 98,
    'microsoft.com': 98, 'x.com': 97, 'twitter.com': 97, 'instagram.com': 97, 'amazon.com': 96, 'github.com': 96,
    'reddit.com': 95, 'nytimes.com': 95, 'pinterest.com': 94, 'forbes.com': 94, 'bbc.co.uk': 95, 'bbc.com': 95,
    'cnn.com': 94, 'theguardian.com': 94, 'medium.com': 93, 'imdb.com': 93, 'stackoverflow.com': 93, 'tiktok.com': 95,
    'webmd.com': 91, 'healthline.com': 90, 'mayoclinic.org': 92, 'nih.gov': 95, 'quora.com': 90, 'tripadvisor.com': 91,
    'investopedia.com': 88, 'nerdwallet.com': 85, 'hubspot.com': 92, 'shopify.com': 92, 'etsy.com': 92, 'ebay.com': 93,
    'walmart.com': 92, 'yelp.com': 92, 'britannica.com': 91, 'cnet.com': 91, 'techradar.com': 89, 'pcmag.com': 89,
    'theverge.com': 91, 'wired.com': 92, 'businessinsider.com': 92, 'nbcnews.com': 92, 'usatoday.com': 92,
    'wikihow.com': 89, 'merriam-webster.com': 91, 'dictionary.com': 89, 'cambridge.org': 92, 'harvard.edu': 94,
    'verywellhealth.com': 86, 'verywellmind.com': 85, 'bankrate.com': 86, 'zillow.com': 89, 'indeed.com': 92,
    'glassdoor.com': 90, 'booking.com': 92, 'expedia.com': 90, 'allrecipes.com': 89, 'foodnetwork.com': 88,
    'stackexchange.com': 90, 'substack.com': 88, 'wordpress.com': 92, 'blogspot.com': 90, 'tumblr.com': 90,
    'fandom.com': 90, 'yahoo.com': 94, 'w3schools.com': 90, 'mozilla.org': 94, 'dev.to': 82, 'canva.com': 91,
  };
  const ADULT_FILTER = /xhamster|xvideos|pornhub|xnxx|xxx|onlyfans|porn/i;

  const RANK_LABELS = ['Near-impossible (today)', 'Very unlikely', 'Unlikely', 'Possible', 'Likely', 'Very likely'];
  const RANK_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ============================ helpers ============================ */

  const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
  const round = (v, d = 0) => { const f = Math.pow(10, d); return Math.round(v * f) / f; };
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function normalize(k) {
    return String(k || '')
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\s+/g, ' ')
      .replace(/^[\s"'.,;:!?-]+|[\s"'.,;:!-]+$/g, '')
      .trim();
  }
  function tokens(k) { return normalize(k).replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(' ').filter(Boolean); }
  function stem(t) { return t.length > 4 && t.endsWith('ies') ? t.slice(0, -3) + 'y' : t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t; }
  function coreTokens(k) { return tokens(k).filter((t) => !STOPWORDS.has(t)).map(stem); }
  function titleCase(s) {
    const small = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'vs']);
    return String(s).split(' ').map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  }
  function ymd(d) { const z = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}`; }
  function daysAgo(n, from = new Date()) { return new Date(from.getTime() - n * 864e5); }
  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    if (n >= 1e6) return round(n / 1e6, 1) + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'K';
    if (n >= 1e3) return round(n / 1e3, 1) + 'K';
    return String(Math.round(n));
  }
  function domainOf(url) {
    try {
      const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      const parts = h.split('.');
      if (parts.length > 2) {
        const sld = parts[parts.length - 2];
        if (parts[parts.length - 1].length === 2 && ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'].includes(sld)) return parts.slice(-3).join('.');
        return parts.slice(-2).join('.');
      }
      return h;
    } catch (_) { return ''; }
  }
  function decodeEntities(s) {
    return String(s || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }
  function toData(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return raw;
    let s = raw.trim();
    const jsonp = s.match(/^[\w.$]+\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonp) s = jsonp[1];
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  /* ============================ links ============================ */

  const links = {
    google: (k, m) => `https://www.google.com/search?q=${encodeURIComponent(k)}&hl=${m.hl}&gl=${m.gl}`,
    trends: (k, m) => `https://trends.google.com/trends/explore?q=${encodeURIComponent(k)}&geo=${m.gl.toUpperCase()}&date=today%2012-m`,
    trends5y: (k, m) => `https://trends.google.com/trends/explore?q=${encodeURIComponent(k)}&geo=${m.gl.toUpperCase()}&date=today%205-y`,
    trendsEmbed: (k, m) => {
      const GL = m.gl.toUpperCase();
      const req = { comparisonItem: [{ keyword: k, geo: GL, time: 'today 12-m' }], category: 0, property: '' };
      const tz = -new Date().getTimezoneOffset();
      return `https://trends.google.com/trends/embed/explore/TIMESERIES?req=${encodeURIComponent(JSON.stringify(req))}&tz=${-tz}&eq=${encodeURIComponent(`q=${k}&geo=${GL}&date=today 12-m`)}`;
    },
    news: (k, m) => `https://news.google.com/search?q=${encodeURIComponent(k)}&hl=${m.hl}-${m.gl.toUpperCase()}&gl=${m.gl.toUpperCase()}&ceid=${m.gl.toUpperCase()}:${m.hl}`,
    pageviews: (title, m) => `https://pageviews.wmcloud.org/?project=${m.hl}.wikipedia.org&platform=all-access&agent=user&redirects=0&range=latest-90&pages=${encodeURIComponent(String(title).replace(/ /g, '_'))}`,
    wiki: (title, m) => `https://${m.hl}.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`,
    hn: (k) => `https://hn.algolia.com/?q=${encodeURIComponent(k)}&dateRange=pastMonth&type=story&sort=byPopularity`,
    reddit: (k) => `https://www.reddit.com/search/?q=${encodeURIComponent(k)}&t=year`,
    youtube: (k) => `https://www.youtube.com/results?search_query=${encodeURIComponent(k)}`,
    gdelt: (k) => `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(gdeltQuery(k))}&mode=timelinevolraw&timespan=3months&format=html`,
    bing: (k) => `https://www.bing.com/search?q=${encodeURIComponent(k)}`,
  };
  function gdeltQuery(k) {
    const t = normalize(k).replace(/["()]/g, '');
    return t.includes(' ') ? `"${t}"` : t;
  }

  /* ========================= query expansion ========================= */

  /**
   * Build the autocomplete query plan for a seed topic.
   * @returns {Array<{engine:string,q:string,kind:string}>}
   */
  function buildExpansions(seed, depth = 'standard', opts = {}) {
    const s = normalize(seed);
    const year = opts.year || new Date().getFullYear();
    const out = [];
    const add = (engine, q, kind) => out.push({ engine, q, kind });
    const engines = opts.engines || ['g', 'bing', 'ddg', 'yt', 'amz'];
    const has = (e) => engines.includes(e);

    if (has('g')) {
      add('g', s, 'seed');
      const qp = depth === 'quick' ? ['how to', 'what is', 'why', 'can', 'best', 'is'] : QUESTION_PREFIXES;
      qp.forEach((p) => add('g', `${p} ${s}`, 'question'));
      const sm = depth === 'quick' ? ['for', 'vs', 'without', 'ideas', 'for beginners', String(year)] : SUFFIX_MODIFIERS.concat([String(year)]);
      sm.forEach((m) => add('g', `${s} ${m}`, 'modifier'));
      if (depth !== 'quick') ALPHABET.forEach((c) => add('g', `${s} ${c}`, 'alphabet'));
      if (depth === 'deep') ['best', 'top', 'free', 'cheap', 'easy', 'new'].forEach((p) => add('g', `${p} ${s}`, 'prefix'));
    }
    const lite = depth === 'quick' ? [s] : [s, `how to ${s}`, `best ${s}`, `${s} vs`, `what is ${s}`];
    ['bing', 'ddg', 'yt'].forEach((e) => { if (has(e)) lite.forEach((q, i) => add(e, q, i === 0 ? 'seed' : 'question')); });
    if (has('amz') && (opts.gl || 'us') === 'us') add('amz', s, 'seed');
    return out;
  }

  /* ============================== parsers ============================== */

  /** Normalise any autocomplete payload into [{text, rel}] */
  function parseSuggest(raw) {
    const d = toData(raw);
    if (!d) return [];
    let list = [];
    if (Array.isArray(d) && d.length && typeof d[0] === 'object' && !Array.isArray(d[0]) && d[0] && 'phrase' in d[0]) {
      list = d.map((x) => ({ text: x.phrase }));
    } else if (Array.isArray(d) && Array.isArray(d[1])) {
      const meta = d.find((x, i) => i >= 2 && x && typeof x === 'object' && !Array.isArray(x)) || {};
      const rels = meta['google:suggestrelevance'] || [];
      const types = meta['google:suggesttype'] || [];
      list = d[1].map((x, i) => ({ text: Array.isArray(x) ? x[0] : x, rel: rels[i], type: types[i] }));
      list = list.filter((x) => !x.type || x.type === 'QUERY' || x.type === 'ENTITY');
    } else if (d && Array.isArray(d.suggestions)) {
      list = d.suggestions.map((x) => ({ text: x.value }));
    }
    return list
      .map((x) => ({ text: normalize(decodeEntities(x.text)), rel: typeof x.rel === 'number' ? x.rel : undefined }))
      .filter((x) => x.text && x.text.length <= 100 && !/^https?:|^www\.|\.(com|net|org)\b\/?$/.test(x.text));
  }

  function rssItems(xml) { return String(xml || '').match(/<item\b[\s\S]*?<\/item>/g) || []; }
  function tag(xml, name) {
    const m = String(xml).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return m ? decodeEntities(m[1]).trim() : '';
  }
  function tagAll(xml, name) {
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi');
    const out = []; let m;
    while ((m = re.exec(String(xml)))) out.push(m[1]);
    return out;
  }

  /** Google Trends "Trending now" RSS */
  function parseTrendsRss(xml) {
    return rssItems(xml).map((it) => {
      const traffic = tag(it, 'ht:approx_traffic');
      const n = parseInt(traffic.replace(/[^\d]/g, ''), 10) || 0;
      const mult = /M\+?$/i.test(traffic) ? 1e6 : /K\+?$/i.test(traffic) ? 1e3 : 1;
      return {
        title: tag(it, 'title'),
        traffic,
        trafficN: n * mult,
        pubDate: tag(it, 'pubDate'),
        picture: tag(it, 'ht:picture'),
        news: tagAll(it, 'ht:news_item').map((ni) => ({
          title: decodeEntities(tag(ni, 'ht:news_item_title')),
          url: tag(ni, 'ht:news_item_url'),
          source: tag(ni, 'ht:news_item_source'),
        })),
      };
    }).filter((x) => x.title);
  }

  /** Google News search RSS */
  function parseNewsRss(xml) {
    return rssItems(xml).map((it) => {
      const title = tag(it, 'title');
      const source = tag(it, 'source');
      return {
        title: source && title.endsWith(' - ' + source) ? title.slice(0, -(source.length + 3)) : title,
        url: tag(it, 'link'),
        source,
        date: new Date(tag(it, 'pubDate')),
      };
    }).filter((x) => x.title && !isNaN(x.date));
  }

  function parseWikiSearch(raw) {
    const d = toData(raw);
    const q = d && d.query;
    if (!q) return { total: 0, results: [] };
    return { total: (q.searchinfo && q.searchinfo.totalhits) || 0, results: (q.search || []).map((r) => ({ title: r.title, words: r.wordcount, updated: r.timestamp })) };
  }

  /** Pick the Wikipedia article that genuinely represents the keyword (or null). */
  function pickWikiArticle(keyword, results) {
    const kt = coreTokens(keyword);
    if (!kt.length) return null;
    for (const r of results.slice(0, 3)) {
      const tt = coreTokens(r.title.replace(/\(.*?\)/g, ''));
      if (!tt.length) continue;
      const overlap = tt.filter((t) => kt.includes(t)).length;
      if (overlap / tt.length >= 0.75 && overlap / kt.length >= 0.5) return r.title;
    }
    return null;
  }

  function parseWikiViews(raw) {
    const d = toData(raw);
    return ((d && d.items) || []).map((x) => ({
      date: `${x.timestamp.slice(0, 4)}-${x.timestamp.slice(4, 6)}-${x.timestamp.slice(6, 8)}`,
      v: x.views || 0,
    }));
  }

  function parseWikiTop(raw, limit = 40) {
    const d = toData(raw);
    const arts = (d && d.items && d.items[0] && d.items[0].articles) || [];
    return arts
      .filter((a) => !/^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Talk:|Category:|Template:|User:|Search|-$)/.test(a.article) && !ADULT_FILTER.test(a.article))
      .slice(0, limit)
      .map((a) => ({ title: a.article.replace(/_/g, ' '), views: a.views, rank: a.rank }));
  }

  /** Keep only items whose title genuinely mentions the keyword (forum search APIs match loosely). */
  function relevant(items, keyword, minShare = 0.6) {
    const kt = coreTokens(keyword);
    if (!kt.length) return items;
    const need = Math.max(1, Math.ceil(kt.length * minShare));
    return items.filter((it) => { const tt = coreTokens(it.title || ''); return kt.filter((t) => tt.includes(t)).length >= need; });
  }

  function parseHN(raw) {
    const d = toData(raw);
    if (!d) return { total: 0, hits: [] };
    return {
      total: d.nbHits || 0,
      hits: (d.hits || []).map((h) => ({
        title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        discuss: `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points || 0, comments: h.num_comments || 0,
        date: new Date(h.created_at),
      })),
    };
  }

  function parseReddit(raw) {
    const d = toData(raw);
    const ch = (d && d.data && d.data.children) || [];
    return ch.map((c) => c.data).filter(Boolean).map((p) => ({
      title: p.title, subreddit: p.subreddit_name_prefixed || ('r/' + p.subreddit), score: p.score || 0,
      comments: p.num_comments || 0, url: 'https://www.reddit.com' + p.permalink, date: new Date((p.created_utc || 0) * 1000),
    }));
  }

  function parseGdelt(raw) {
    const d = toData(raw);
    const series = d && d.timeline && d.timeline[0];
    if (!series || !series.data) return [];
    return series.data.map((p) => ({ date: `${p.date.slice(0, 4)}-${p.date.slice(4, 6)}-${p.date.slice(6, 8)}`, v: p.value || 0 }));
  }

  function parseSerp(raw) {
    const d = toData(raw);
    if (!d || !Array.isArray(d.organic)) return null;
    return {
      organic: d.organic.slice(0, 10).map((o, i) => ({
        position: o.position || i + 1, title: o.title || '', url: o.link, domain: domainOf(o.link), snippet: o.snippet || '', date: o.date || '',
      })),
      paa: (d.peopleAlsoAsk || []).map((x) => ({ question: x.question, url: x.link, snippet: x.snippet })),
      related: (d.relatedSearches || []).map((x) => normalize(x.query)).filter(Boolean),
      features: {
        answerBox: !!d.answerBox, knowledgeGraph: !!d.knowledgeGraph, topStories: !!(d.topStories && d.topStories.length),
        videos: !!(d.videos && d.videos.length), images: !!(d.images && d.images.length), shopping: !!(d.shopping && d.shopping.length),
        peopleAlsoAsk: !!(d.peopleAlsoAsk && d.peopleAlsoAsk.length),
      },
    };
  }

  function parseOpr(raw) {
    const d = toData(raw);
    const map = {};
    ((d && d.response) || []).forEach((r) => {
      if (r && r.status_code === 200 && r.domain) map[r.domain.toLowerCase()] = round((parseFloat(r.page_rank_decimal) || 0) * 10, 1);
    });
    return map;
  }

  function parseDfsVolume(raw) {
    const d = toData(raw);
    const res = (d && d.tasks && d.tasks[0] && d.tasks[0].result) || [];
    const map = {};
    res.forEach((r) => {
      if (!r || !r.keyword) return;
      map[normalize(r.keyword)] = {
        volume: r.search_volume, cpc: r.cpc, competition: r.competition, competitionIndex: r.competition_index,
        monthly: (r.monthly_searches || []).map((m) => ({ date: `${m.year}-${String(m.month).padStart(2, '0')}-01`, v: m.search_volume || 0 })).sort((a, b) => (a.date < b.date ? -1 : 1)),
      };
    });
    return map;
  }

  function parseDfsKd(raw) {
    const d = toData(raw);
    const items = (d && d.tasks && d.tasks[0] && d.tasks[0].result && d.tasks[0].result[0] && d.tasks[0].result[0].items) || [];
    const map = {};
    items.forEach((it) => { if (it && it.keyword && typeof it.keyword_difficulty === 'number') map[normalize(it.keyword)] = it.keyword_difficulty; });
    return map;
  }

  /* ============================ classification ============================ */

  const RX = {
    transactional: /\b(buy|order|coupon|coupons|discount|deal|deals|promo|price|prices|pricing|cheap|cheapest|for sale|shop|purchase|subscription|download|hire|booking|book a|rent|free trial|cost|costs|quote)\b/,
    commercial: /\b(best|top|review|reviews|vs|versus|compare|comparison|alternative|alternatives|recommended|worth it|pros and cons|rated|brands?|which is better)\b/,
    navigational: /\b(login|log in|sign in|sign up|official site|website|customer service|phone number|portal|account|app download)\b|\.(com|net|org|io)\b/,
    question: new RegExp(`^(${QUESTION_WORDS.join('|')})\\b|\\?$`),
    howto: /\bhow to\b/,
    comparison: /\b(vs\.?|versus|compared to|alternatives?|difference between|or)\b/,
    local: /\b(near me|nearby|open now|closest|in my area)\b/,
    fresh: /\b(20[2-3]\d|latest|new|news|today|this year|update|updated|right now|current)\b/,
    beginner: /\b(beginners?|for dummies|basics|101|easy|simple|starter|getting started)\b/,
    list: /\b(ideas|examples|tips|ways|list|types of|kinds of|checklist|templates?)\b/,
    definition: /\b(meaning|definition|define|what is|what are|explained)\b/,
  };

  function classify(keyword) {
    const k = normalize(keyword);
    const words = tokens(k).length;
    let intent = 'informational';
    if (RX.navigational.test(k)) intent = 'navigational';
    if (RX.commercial.test(k)) intent = 'commercial';
    if (RX.transactional.test(k)) intent = 'transactional';
    if (RX.question.test(k) && intent !== 'transactional') intent = RX.commercial.test(k) ? 'commercial' : 'informational';
    const types = [];
    if (RX.question.test(k)) types.push('question');
    if (RX.howto.test(k)) types.push('how-to');
    if (RX.comparison.test(k)) types.push('comparison');
    if (RX.local.test(k)) types.push('local');
    if (RX.fresh.test(k)) types.push('fresh');
    if (RX.beginner.test(k)) types.push('beginner');
    if (RX.list.test(k)) types.push('list');
    if (RX.definition.test(k)) types.push('definition');
    if (/\b(best|top)\b/.test(k)) types.push('best-of');
    const years = (k.match(/\b(19[5-9]\d|20[0-3]\d)\b/g) || []).map(Number);
    if (years.length && Math.max(...years) < new Date().getFullYear()) { types.push('dated'); const fi = types.indexOf('fresh'); if (fi >= 0) types.splice(fi, 1); }
    const tail = words <= 2 ? 'head' : words === 3 ? 'mid-tail' : 'long-tail';
    return { intent, types, tail, words };
  }

  /* ============================ aggregation ============================ */

  /**
   * Merge autocomplete results into keyword records.
   * @param {Array<{engine,q,kind,suggestions:[{text,rel}]}>} results
   */
  function aggregate(results, seed) {
    const s = normalize(seed);
    const seedCore = coreTokens(s);
    const map = new Map();
    const enginesQueried = new Set(results.filter((r) => r.ok !== false).map((r) => r.engine));
    const get = (text) => {
      let r = map.get(text);
      if (!r) {
        r = { keyword: text, engines: new Set(), hits: 0, queries: [], bestPos: {}, seedPos: {}, rel: undefined };
        map.set(text, r);
      }
      return r;
    };
    for (const res of results) {
      (res.suggestions || []).forEach((sg, pos) => {
        const kc = coreTokens(sg.text);
        // Must share at least one meaningful token with the seed (drops autocomplete noise)
        if (seedCore.length && !seedCore.some((t) => kc.includes(t))) return;
        const r = get(sg.text);
        r.engines.add(res.engine);
        r.hits += 1;
        if (r.queries.length < 6) r.queries.push({ engine: res.engine, q: res.q, pos: pos + 1 });
        if (r.bestPos[res.engine] === undefined || pos + 1 < r.bestPos[res.engine]) r.bestPos[res.engine] = pos + 1;
        if (res.kind === 'seed' && (r.seedPos[res.engine] === undefined || pos + 1 < r.seedPos[res.engine])) r.seedPos[res.engine] = pos + 1;
        if (typeof sg.rel === 'number') r.rel = Math.max(r.rel || 0, sg.rel);
      });
    }
    if (!map.has(s)) { const r = get(s); r.isSeed = true; } else map.get(s).isSeed = true;
    return { records: [...map.values()], enginesQueried: [...enginesQueried] };
  }

  /* ============================== demand ============================== */

  function demandFromVolume(volume) {
    if (volume === null || volume === undefined) return null;
    return clamp(Math.round((100 * Math.log10(volume + 1)) / 5));
  }

  /**
   * Relative demand index (0-100) from autocomplete evidence, or from real volume when available.
   * Autocomplete only ever suggests queries real people search often, so cross-engine
   * agreement + suggestion rank is a strong popularity proxy.
   */
  function demandIndex(rec, enginesQueried) {
    if (rec.volume !== undefined && rec.volume !== null) {
      return { value: demandFromVolume(rec.volume), basis: 'volume', parts: { volume: rec.volume } };
    }
    const E = Math.max(1, enginesQueried.length);
    const cross = rec.engines.size / E;
    const seedPositions = Object.values(rec.seedPos);
    const direct = seedPositions.length ? Math.max(...seedPositions.map((p) => (11 - Math.min(p, 10)) / 10)) : 0;
    const allPositions = Object.values(rec.bestPos);
    const best = allPositions.length ? (11 - Math.min(10, Math.min(...allPositions))) / 10 : 0;
    const hitScore = clamp((rec.hits - 1) / 4, 0, 1);
    const relScore = typeof rec.rel === 'number' ? clamp((rec.rel - 550) / 750, 0, 1) : 0.35;
    // Shorter phrases that still get suggested are, almost by definition, searched more.
    const words = tokens(rec.keyword).length;
    const brevity = clamp((7 - words) / 5, 0, 1);
    let v = 100 * (0.25 * cross + 0.2 * direct + 0.15 * best + 0.12 * hitScore + 0.18 * relScore + 0.1 * brevity);
    if (rec.isSeed && rec.hits === 0) v = Math.max(v, 45); // seed typed by user but not echoed by autocomplete
    return { value: clamp(Math.round(v)), basis: 'autocomplete', parts: { cross: round(cross, 2), direct: round(direct, 2), best: round(best, 2), hits: rec.hits, rel: rec.rel, brevity: round(brevity, 2) } };
  }

  function demandTier(v) {
    return v >= 80 ? 'Very high' : v >= 60 ? 'High' : v >= 40 ? 'Medium' : v >= 20 ? 'Low' : 'Very low';
  }

  /* ========================= keyword difficulty ========================= */

  /** Heuristic KD when no SERP data is available. Transparent and deliberately conservative. */
  function kdHeuristic(rec, ctx = {}) {
    const c = rec.cls || classify(rec.keyword);
    const base = { 1: 72, 2: 58, 3: 44, 4: 33, 5: 26 }[Math.min(c.words, 5)] || 26;
    const parts = [{ label: `${c.words}-word ${c.tail} keyword`, delta: base }];
    let kd = base;
    const dem = rec.demand ? rec.demand.value : 40;
    const dAdj = round((dem - 50) * 0.3);
    if (dAdj) { kd += dAdj; parts.push({ label: `Demand index ${dem}`, delta: dAdj }); }
    if (c.intent === 'commercial') { kd += 10; parts.push({ label: 'Commercial intent (affiliate/brand competition)', delta: 10 }); }
    if (c.intent === 'transactional') { kd += 8; parts.push({ label: 'Transactional intent (e-commerce competition)', delta: 8 }); }
    if (c.types.includes('question')) { kd -= 6; parts.push({ label: 'Question format (many weak answers ranking)', delta: -6 }); }
    if (c.types.includes('fresh')) { kd -= 4; parts.push({ label: 'Freshness-driven (new pages can win)', delta: -4 }); }
    if (c.types.includes('local')) { kd -= 4; parts.push({ label: 'Local modifier (location-filtered results)', delta: -4 }); }
    if (ctx.wikiExact && c.words <= 2) { kd += 8; parts.push({ label: 'Dedicated Wikipedia article exists', delta: 8 }); }
    return { value: clamp(Math.round(kd), 1, 100), basis: 'heuristic', confidence: 'Low', parts };
  }

  function authorityOf(domain, authMap) {
    if (authMap && typeof authMap[domain] === 'number') return { v: authMap[domain], known: true };
    if (KNOWN_AUTH[domain] !== undefined) return { v: KNOWN_AUTH[domain], known: true };
    if (/\.(gov|edu)(\.[a-z]{2})?$/.test(domain)) return { v: 80, known: false };
    return { v: 35, known: false };
  }

  /** Measured KD from the live top-10 + domain authority. */
  function kdFromSerp(serp, authMap, keyword, year = new Date().getFullYear()) {
    if (!serp || !serp.organic.length) return null;
    const W = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3];
    const kt = coreTokens(keyword);
    let wSum = 0, aSum = 0, onPage = 0, known = 0;
    const weak = [];
    const rows = serp.organic.map((o, i) => {
      const a = authorityOf(o.domain, authMap);
      if (a.known) known += 1;
      const w = W[i] || 0.3;
      const ugc = UGC_DOMAINS.some((u) => o.domain === u || o.domain.endsWith('.' + u));
      // A single forum/UGC thread borrows domain strength but has little page-level authority: count it at half weight.
      wSum += w; aSum += w * (ugc ? a.v * 0.5 : a.v);
      const titleT = coreTokens(o.title);
      const match = kt.length ? kt.filter((t) => titleT.includes(t)).length / kt.length : 0;
      if (match >= 0.99) onPage += 1;
      const yrs = (o.title.match(/\b(20[0-3]\d)\b/g) || []).map(Number);
      const outdated = yrs.length && Math.max(...yrs) < year - 1;
      if (ugc) weak.push({ type: 'ugc', position: o.position, domain: o.domain, url: o.url, text: `#${o.position} is user-generated content (${o.domain}) - Google is filling a gap with forum/social answers.` });
      else if (a.v < 30) weak.push({ type: 'low-authority', position: o.position, domain: o.domain, url: o.url, text: `#${o.position} is a low-authority site (${o.domain}, authority ${Math.round(a.v)}).` });
      if (outdated) weak.push({ type: 'outdated', position: o.position, domain: o.domain, url: o.url, text: `#${o.position} looks outdated ("${Math.max(...yrs)}" in title).` });
      if (match < 0.5) weak.push({ type: 'mismatch', position: o.position, domain: o.domain, url: o.url, text: `#${o.position} does not target this keyword in its title - poor relevance match.` });
      return { ...o, authority: Math.round(a.v), authorityKnown: a.known, titleMatch: round(match, 2), ugc, outdated: !!outdated };
    });
    const authW = aSum / wSum;
    const onPageRatio = onPage / rows.length;
    const ugcRatio = rows.filter((r) => r.ugc).length / rows.length;
    const f = serp.features;
    const featureCount = ['answerBox', 'knowledgeGraph', 'topStories', 'videos', 'shopping'].filter((k) => f[k]).length;
    const kd = clamp(Math.round(0.62 * authW + 22 * onPageRatio + 2.5 * featureCount - 18 * ugcRatio + 4), 1, 100);
    return {
      value: kd,
      basis: 'serp',
      confidence: known >= 7 ? 'High' : known >= 4 ? 'Medium' : 'Medium-low',
      parts: [
        { label: `Position-weighted authority of top 10: ${Math.round(authW)}`, delta: round(0.62 * authW) },
        { label: `${onPage}/10 results target the exact keyword in the title`, delta: round(22 * onPageRatio) },
        { label: `${featureCount} SERP features push organic results down`, delta: round(2.5 * featureCount) },
        { label: `${Math.round(ugcRatio * 10)}/10 results are forums/UGC`, delta: -round(18 * ugcRatio) },
        { label: 'Baseline', delta: 4 },
      ],
      rows,
      weak,
      minAuthority: Math.min(...rows.map((r) => r.authority)),
      medianAuthority: median(rows.map((r) => r.authority)),
      ugcCount: rows.filter((r) => r.ugc).length,
      outdatedCount: rows.filter((r) => r.outdated).length,
    };
  }

  /* ============================ rankability ============================ */

  /**
   * How likely YOUR site is to reach page 1, on a 6-step scale.
   * @param {number} kd 0-100
   * @param {number|null} siteAuth 0-100 (null = assume a new/small site)
   */
  function rankability(kd, siteAuth, opts = {}) {
    const assumed = siteAuth === null || siteAuth === undefined || isNaN(siteAuth);
    const A = assumed ? 15 : clamp(siteAuth);
    let gap = kd - A;
    const reasons = [`Keyword difficulty ${kd} vs your site authority ${A}${assumed ? ' (assumed: new/small site - set yours in Settings)' : ''}.`];
    const serp = opts.serp;
    if (serp) {
      if (serp.minAuthority <= A + 5) { gap -= 10; reasons.push(`A page with authority ${serp.minAuthority} already ranks on page 1 - your site can compete with it.`); }
      if (serp.ugcCount >= 2) { gap -= 8; reasons.push(`${serp.ugcCount} forum/UGC results on page 1 signal unmet demand for a real, expert article.`); }
      else if (serp.ugcCount === 1) { gap -= 4; reasons.push('A forum/UGC result on page 1 is a beatable slot.'); }
      if (serp.outdatedCount >= 2) { gap -= 5; reasons.push(`${serp.outdatedCount} results are outdated - a fresh, current article has an edge.`); }
    } else if (opts.cls && opts.cls.words >= 4) {
      gap -= 4; reasons.push('Long-tail phrasing: big sites rarely target it precisely.');
    }
    if (opts.trendLabel === 'Breakout' || opts.trendLabel === 'Rising') { gap -= 5; reasons.push(`Interest is ${opts.trendLabel.toLowerCase()} - early, fresh content gets indexed and ranked before competitors react.`); }
    const level = gap <= -20 ? 5 : gap <= -5 ? 4 : gap <= 10 ? 3 : gap <= 25 ? 2 : gap <= 40 ? 1 : 0;
    const chance = clamp(Math.round(55 - gap * 1.4), 1, 99);
    return { level, label: RANK_LABELS[level], color: RANK_COLORS[level], chance, gap: Math.round(gap), assumed, reasons };
  }

  /* =============================== trends =============================== */

  function trendFromDaily(series) {
    if (!series || series.length < 21) return null;
    const vals = series.map((p) => p.v);
    const recent = avg(vals.slice(-14));
    const baseSlice = vals.slice(Math.max(0, vals.length - 74), vals.length - 14);
    const base = avg(baseSlice);
    const change = (recent - base) / Math.max(base, 1);
    const last7 = avg(vals.slice(-7));
    const prev7 = avg(vals.slice(-14, -7));
    const momentum = (last7 - prev7) / Math.max(prev7, 1);
    const spike = Math.max(...vals.slice(-7)) > 3 * Math.max(median(baseSlice), 1);
    return { recentAvg: Math.round(recent), baseAvg: Math.round(base), change: round(change, 3), momentum: round(momentum, 3), spike };
  }

  function seasonality(monthly) {
    if (!monthly || monthly.length < 24) return null;
    const byYear = {};
    monthly.forEach((p) => { const y = p.date.slice(0, 4); (byYear[y] = byYear[y] || []).push(p); });
    const peaks = [];
    const prof = new Array(12).fill(0).map(() => []);
    Object.values(byYear).forEach((pts) => {
      if (pts.length < 12) return;
      const mean = avg(pts.map((p) => p.v)) || 1;
      let best = pts[0];
      pts.forEach((p) => { prof[parseInt(p.date.slice(5, 7), 10) - 1].push(p.v / mean); if (p.v > best.v) best = p; });
      peaks.push(parseInt(best.date.slice(5, 7), 10) - 1);
    });
    const profile = prof.map((a) => (a.length ? avg(a) : 1));
    const peak = profile.indexOf(Math.max(...profile));
    const trough = profile.indexOf(Math.min(...profile));
    const ratio = profile[peak] / Math.max(profile[trough], 0.01);
    const consistent = peaks.length >= 2 && peaks.every((m) => Math.min(Math.abs(m - peak), 12 - Math.abs(m - peak)) <= 1);
    return { seasonal: ratio >= 1.6 && consistent, peakMonth: MONTHS[peak], troughMonth: MONTHS[trough], ratio: round(ratio, 2), profile: profile.map((v) => round(v, 2)) };
  }

  function newsVelocity(items, now = new Date()) {
    const t = now.getTime();
    const age = (d) => (t - d.getTime()) / 864e5;
    const last24 = items.filter((i) => age(i.date) <= 1).length;
    const last7 = items.filter((i) => age(i.date) <= 7).length;
    const prior = items.filter((i) => age(i.date) > 7 && age(i.date) <= 30).length;
    const weeklyBase = prior / (23 / 7);
    const velocity = (last7 - weeklyBase) / Math.max(weeklyBase, 1);
    const weeks = [0, 0, 0, 0];
    items.forEach((i) => { const w = Math.floor(age(i.date) / 7); if (w >= 0 && w < 4) weeks[3 - w] += 1; });
    return { total: items.length, last24, last7, prior, weeklyBase: round(weeklyBase, 1), velocity: round(velocity, 2), saturated: items.length >= 95, weeks };
  }

  function matchesTrending(keyword, trendingTitles) {
    const kt = coreTokens(keyword);
    if (!kt.length) return null;
    for (const t of trendingTitles) {
      const tt = coreTokens(t.title || t);
      if (!tt.length) continue;
      const overlap = tt.filter((x) => kt.includes(x)).length;
      if (overlap === tt.length && overlap >= 1 && (tt.length >= 2 || kt.length <= 3)) return t;
    }
    return null;
  }

  /** Combine every available trend signal into one 0-100 score + label. */
  function trendScore(sig = {}) {
    let score = 50; let n = 0;
    const parts = [];
    if (sig.trending) { score += 30; n++; parts.push({ label: 'Currently on Google Trends "Trending now"', delta: 30 }); }
    if (sig.wiki) { const d = clamp(Math.round(sig.wiki.change * 25), -30, 30); score += d; n++; parts.push({ label: `Wikipedia views ${pct(sig.wiki.change)} (14d vs prior 60d)`, delta: d }); }
    if (sig.news && !sig.news.saturated && sig.news.total >= 3) { const d = clamp(Math.round(sig.news.velocity * 15), -20, 20); score += d; n++; parts.push({ label: `News velocity ${pct(sig.news.velocity)} week-over-baseline`, delta: d }); }
    if (sig.gdelt) { const d = clamp(Math.round(sig.gdelt.change * 15), -20, 20); score += d; n++; parts.push({ label: `Global news volume ${pct(sig.gdelt.change)} (GDELT)`, delta: d }); }
    if (sig.volumeTrend !== undefined && sig.volumeTrend !== null) { const d = clamp(Math.round(sig.volumeTrend * 25), -25, 25); score += d; n++; parts.push({ label: `Google search volume ${pct(sig.volumeTrend)} (last 3 vs prior 9 months)`, delta: d }); }
    score = clamp(Math.round(score));
    const label = n === 0 ? 'Unknown' : score >= 85 ? 'Breakout' : score >= 62 ? 'Rising' : score <= 38 ? 'Declining' : 'Stable';
    return { value: score, label, signals: n, parts };
  }
  function pct(x) { const v = Math.round(x * 100); return (v > 0 ? '+' : '') + v + '%'; }

  function volumeTrend(monthly) {
    if (!monthly || monthly.length < 12) return null;
    const v = monthly.map((m) => m.v);
    const last3 = avg(v.slice(-3)); const prev9 = avg(v.slice(-12, -3));
    return round((last3 - prev9) / Math.max(prev9, 1), 3);
  }

  /* ============================ opportunity ============================ */

  function opportunity(rec) {
    const d = Math.max(1, rec.demand ? rec.demand.value : 30);
    const ease = Math.max(1, 100 - (rec.kd ? rec.kd.value : 50));
    const t = rec.trend ? rec.trend.value : 50;
    // Weighted geometric mean: a keyword needs BOTH demand and winnability. Easy-but-unsearched scores low.
    const chance = rec.rank ? Math.max(1, rec.rank.chance) : null;
    const core = chance === null
      ? Math.pow(d, 0.5) * Math.pow(ease, 0.5)
      : Math.pow(d, 0.45) * Math.pow(ease, 0.3) * Math.pow(chance, 0.25);
    let v = 0.85 * core + 0.15 * t;
    const c = rec.cls || classify(rec.keyword);
    if (c.types.includes('question') && c.words >= 4) v += 3;
    if (c.intent === 'navigational') v -= 15; // you cannot rank for someone else's brand login
    if (c.types.includes('dated')) v -= 20; // last year's query: demand is draining away
    return clamp(Math.round(v));
  }

  /* ======================== evidence & justification ======================== */

  const ENGINE_NAMES = { g: 'Google', bing: 'Bing', ddg: 'DuckDuckGo', yt: 'YouTube', amz: 'Amazon' };

  function justify(rec, m, ctx = {}) {
    const ev = [];
    const k = rec.keyword;
    const c = rec.cls;
    if (rec.engines && rec.engines.size) {
      const names = [...rec.engines].map((e) => ENGINE_NAMES[e] || e);
      ev.push({ strength: rec.engines.size >= 3 ? 'strong' : 'medium', text: `Suggested by ${names.join(', ')} autocomplete (${rec.engines.size}/${ctx.enginesQueried || rec.engines.size} engines). Search engines only autocomplete queries that real people type frequently.`, link: links.google(k, m), linkLabel: 'Verify on Google' });
      const first = rec.queries && rec.queries[0];
      if (first) ev.push({ strength: first.pos <= 3 ? 'strong' : 'info', text: `Appeared at position #${first.pos} on ${ENGINE_NAMES[first.engine]} when typing "${first.q}".`, link: first.engine === 'yt' ? links.youtube(first.q) : links.google(first.q, m), linkLabel: 'See it' });
    }
    if (rec.volume !== undefined && rec.volume !== null) ev.push({ strength: 'strong', text: `Google Ads data: ${fmtNum(rec.volume)} searches/month${rec.cpc ? `, advertisers pay ~$${round(rec.cpc, 2)} per click` : ''}.`, link: links.trends(k, m), linkLabel: 'Google Trends' });
    if (rec.trend && rec.trend.parts) rec.trend.parts.forEach((p) => ev.push({ strength: Math.abs(p.delta) >= 10 ? 'strong' : 'medium', text: p.label + '.', link: /Wikipedia/.test(p.label) && rec.wikiTitle ? links.pageviews(rec.wikiTitle, m) : /News velocity/.test(p.label) ? links.news(k, m) : /GDELT/.test(p.label) ? links.gdelt(k) : links.trends(k, m), linkLabel: /Wikipedia/.test(p.label) ? 'Pageview graph' : /News/.test(p.label) ? 'News' : /GDELT/.test(p.label) ? 'GDELT graph' : 'Trend graph' }));
    if (rec.news && rec.news.total) ev.push({ strength: rec.news.last7 >= 5 ? 'strong' : 'info', text: `${rec.news.last7} news articles in the last 7 days (${rec.news.total} in 30 days)${rec.news.saturated ? ' - heavy coverage' : ''}.`, link: links.news(k, m), linkLabel: 'Google News' });
    if (rec.hn && rec.hn.total) ev.push({ strength: rec.hn.total >= 5 ? 'medium' : 'info', text: `Discussed in ${rec.hn.total} Hacker News stories in the last 30 days.`, link: links.hn(k), linkLabel: 'HN threads' });
    if (rec.reddit && rec.reddit.length) ev.push({ strength: 'medium', text: `${rec.reddit.length} Reddit threads this year (top: "${rec.reddit[0].title.slice(0, 80)}" in ${rec.reddit[0].subreddit}). Real people are asking - mine these threads for angles.`, link: links.reddit(k), linkLabel: 'Reddit threads' });
    if (c) {
      if (c.tail === 'long-tail') ev.push({ strength: 'medium', text: `Long-tail (${c.words} words): lower competition, clearer intent and higher conversion than head terms.`, link: null });
      if (c.types.includes('question')) ev.push({ strength: 'medium', text: 'Question query: eligible for Featured Snippets and "People also ask" boxes, which can put a new page above #1.', link: links.google(k, m), linkLabel: 'Check SERP' });
      if (c.types.includes('comparison')) ev.push({ strength: 'info', text: 'Comparison query: searchers are close to a decision - high engagement and affiliate value.', link: null });
      if (c.intent === 'transactional' || c.intent === 'commercial') ev.push({ strength: 'info', text: `${titleCase(c.intent)} intent: monetisable traffic (affiliate, products, services), but expect stronger competition.`, link: null });
    }
    if (rec.kd) {
      ev.push({ strength: rec.kd.value <= 30 ? 'strong' : 'info', text: `Keyword difficulty ${rec.kd.value}/100 (${rec.kd.basis === 'serp' ? 'measured from the live top-10' : rec.kd.basis === 'dataforseo' ? 'DataForSEO Labs' : 'estimated - add a SERP key for a measured score'}).`, link: links.google(k, m), linkLabel: 'Inspect top 10' });
      (rec.kd.weak || []).slice(0, 4).forEach((w) => ev.push({ strength: 'strong', text: 'Weak spot: ' + w.text, link: w.url, linkLabel: 'Open result' }));
    }
    if (rec.wikiTitle && rec.wikiDaily) ev.push({ strength: 'info', text: `Wikipedia "${rec.wikiTitle}" averages ${fmtNum(avg(rec.wikiDaily.slice(-30).map((p) => p.v)))} views/day - a floor for real-world interest in the topic.`, link: links.pageviews(rec.wikiTitle, m), linkLabel: 'Pageview graph' });
    return ev;
  }

  function tips(rec, m) {
    const out = [];
    const c = rec.cls;
    const y = new Date().getFullYear();
    if (!c) return out;
    if (c.types.includes('question')) out.push('Answer the question directly in the first 40-60 words under an H2 that repeats the question - this is the format Google lifts into Featured Snippets.');
    if (c.types.includes('how-to')) out.push('Use numbered steps with one action per step, add images/screens per step, and mark up with HowTo-style structure. Include time and tools needed.');
    if (c.types.includes('comparison')) out.push('Lead with a side-by-side comparison table and a clear verdict ("Choose X if..., choose Y if..."). Searchers want the decision, not a history lesson.');
    if (c.types.includes('best-of')) out.push(`Show first-hand testing (photos, data, criteria). Google's reviews system rewards evidence of real use. Put "${y}" in the title and refresh it yearly.`);
    if (c.types.includes('list')) out.push('Lists win clicks: use a number in the title, make every item scannable (bold lead + 2-3 sentences), and add one unique item nobody else lists.');
    if (c.types.includes('definition')) out.push('Open with a one-sentence definition, then examples, then "why it matters". Add a short FAQ to capture related questions.');
    if (c.types.includes('local')) out.push('Local intent: a Google Business Profile and local citations matter more than the article. Mention the place name in title, H1 and URL.');
    if (c.types.includes('fresh') || (rec.trend && /Breakout|Rising/.test(rec.trend.label))) out.push('Timing matters: publish within 24-72 hours, request indexing in Search Console, share it on social/news aggregators, and update it as the story develops.');
    if (c.intent === 'transactional' || c.intent === 'commercial') out.push('Commercial intent: include pricing, pros/cons, and a clear recommendation. Thin affiliate content does not rank; original insight does.');
    if (c.tail === 'head') out.push('Head term: make this a pillar page (3,000+ words) and link to it from every supporting article in this cluster. Expect months, not weeks.');
    if (c.tail === 'long-tail') out.push('Long-tail: a focused 900-1,500 word article that answers exactly this query often outranks broad guides from big sites.');
    if (rec.kd && rec.kd.weak && rec.kd.weak.some((w) => w.type === 'ugc')) out.push('Forums rank here, meaning nobody has written the definitive answer. Read those threads and answer every sub-question they raise, with more depth and clearer structure.');
    if (rec.kd && rec.kd.weak && rec.kd.weak.some((w) => w.type === 'outdated')) out.push(`Competitors are outdated: put "${y}" (or "Updated ${MONTHS[new Date().getMonth()]} ${y}") in the title and include current data.`);
    if (rec.serp && rec.serp.features.videos) out.push('Google shows videos for this query: embed a short video (even a screen recording) to compete for the video carousel too.');
    if (rec.seasonal && rec.seasonal.seasonal) out.push(`Seasonal topic peaking in ${rec.seasonal.peakMonth}: publish 6-8 weeks before the peak so it has time to rank.`);
    out.push('E-E-A-T: show who wrote it and why they are qualified, cite primary sources, and add something original (data, photos, experience) that AI summaries cannot copy.');
    return out;
  }

  /* ============================== clustering ============================== */

  function clusterKeywords(recs, seed) {
    const seedT = new Set(coreTokens(seed));
    const surface = new Map(); // stem -> {word: count}
    const residual = (k) => tokens(k)
      .filter((t) => ((!STOPWORDS.has(t) && !CLUSTER_STOP.has(t)) || CLUSTER_KEEP.has(t)) && !/^\d+$/.test(t) && t.length > 1)
      .map((t) => { const s = stem(t); const m = surface.get(s) || {}; m[t] = (m[t] || 0) + 1; surface.set(s, m); return s; })
      .filter((t) => !seedT.has(t));
    const minSize = Math.max(2, Math.min(5, Math.round(recs.length / 150)));
    const df = new Map();
    recs.forEach((r) => new Set(residual(r.keyword)).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
    const groups = new Map();
    recs.forEach((r) => {
      const res = residual(r.keyword);
      let key = 'core';
      if (res.length) key = res.reduce((best, t) => ((df.get(t) || 0) > (df.get(best) || 0) || ((df.get(t) || 0) === (df.get(best) || 0) && t.length > best.length) ? t : best), res[0]);
      if ((df.get(key) || 0) < minSize && key !== 'core') key = 'more';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    // Fold singleton groups into "more" so the plan only shows real clusters.
    for (const [key, items] of [...groups.entries()]) {
      if (key !== 'core' && key !== 'more' && items.length < 2) {
        if (!groups.has('more')) groups.set('more', []);
        groups.get('more').push(...items);
        groups.delete(key);
      }
    }
    const label = (key) => { const m = surface.get(key); return m ? Object.entries(m).sort((a, b) => b[1] - a[1])[0][0] : key; };
    const seedNorm = normalize(seed);
    const pillarScore = (r) => (r.demand ? r.demand.value : 0) * 0.6 + (r.opportunity || 0) * 0.4 - r.cls.words * 4 - (r.cls.types.includes('dated') ? 50 : 0);
    const clusters = [...groups.entries()].map(([key, items]) => {
      items.sort((a, b) => (b.opportunity || 0) - (a.opportunity || 0));
      const pillar = items.find((r) => r.keyword === seedNorm) || [...items].sort((a, b) => pillarScore(b) - pillarScore(a))[0];
      return {
        key,
        name: key === 'core' ? `${seed} (pillar)` : key === 'more' ? 'More long-tail ideas' : `${seed}: ${label(key)}`,
        items,
        pillar,
        score: items.reduce((s, r) => s + (r.opportunity || 0), 0),
        avgKd: Math.round(avg(items.map((r) => (r.kd ? r.kd.value : 50)))),
        questions: items.filter((r) => r.cls.types.includes('question')),
      };
    });
    clusters.sort((a, b) => (a.key === 'core' ? -1 : b.key === 'core' ? 1 : a.key === 'more' ? 1 : b.key === 'more' ? -1 : b.score - a.score));
    return clusters;
  }

  /* ============================ content brief ============================ */

  function titleIdeas(keyword, cls) {
    const y = new Date().getFullYear();
    const K = titleCase(keyword);
    const t = [];
    if (cls.types.includes('how-to')) { const x = keyword.replace(/^.*?\bhow to\b\s*/, ''); t.push(`How to ${titleCase(x)}: Step-by-Step Guide (${y})`, `How to ${titleCase(x)} (Even If You're a Beginner)`); }
    else if (cls.types.includes('question')) t.push(`${K}? A Clear Answer (With Examples)`, `${K}? Here's What the Evidence Says`);
    if (cls.types.includes('comparison')) { const p = keyword.split(/\s+(?:vs\.?|versus|or)\s+/); if (p.length === 2) t.push(`${titleCase(p[0])} vs ${titleCase(p[1])}: Which Is Better in ${y}?`, `${titleCase(p[0])} vs ${titleCase(p[1])}: Key Differences Explained`); }
    if (cls.types.includes('best-of')) { const x = keyword.replace(/\b(best|top)\b\s*/g, ''); t.push(`11 Best ${titleCase(x)} in ${y} (Tested & Compared)`, `The Best ${titleCase(x)}: Our Top Picks for ${y}`); }
    if (cls.types.includes('list')) t.push(`25+ ${K} That Actually Work`, `${K}: The Ultimate List for ${y}`);
    if (cls.types.includes('beginner')) t.push(`${K}: The Complete Beginner's Guide`);
    if (!t.length) t.push(`${K}: The Complete Guide (${y})`, `${K} Explained: Everything You Need to Know`, `${K}: ${cls.intent === 'commercial' ? 'Honest Review & Buyer\'s Guide' : '7 Things Most People Get Wrong'}`);
    return [...new Set(t)].slice(0, 4);
  }

  function wordCountGuide(cls) {
    if (cls.types.includes('local')) return '800-1,200';
    if (cls.types.includes('best-of')) return '2,500-3,500';
    if (cls.types.includes('comparison')) return '1,800-2,500';
    if (cls.types.includes('how-to')) return '1,500-2,200';
    if (cls.types.includes('question') || cls.types.includes('definition')) return '900-1,500';
    if (cls.tail === 'head') return '3,000+ (pillar)';
    return '1,200-1,800';
  }

  function schemaFor(cls) {
    const s = ['Article', 'BreadcrumbList'];
    if (cls.types.includes('how-to')) s.push('HowTo-style steps');
    if (cls.types.includes('question') || cls.types.includes('definition')) s.push('FAQPage (for the FAQ block)');
    if (cls.types.includes('best-of') || cls.intent === 'commercial') s.push('Review / ItemList');
    if (cls.types.includes('local')) s.push('LocalBusiness');
    return s;
  }

  /** Markdown article brief (Obsidian/Docs friendly). */
  function brief(rec, related, m) {
    const c = rec.cls;
    const qs = [...new Set([
      ...((rec.serp && rec.serp.paa) || []).map((p) => normalize(p.question)),
      ...related.filter((r) => r.cls.types.includes('question') && r.keyword !== rec.keyword).map((r) => r.keyword),
    ])].slice(0, 10);
    const secondary = related.filter((r) => r.keyword !== rec.keyword && !r.cls.types.includes('question')).slice(0, 10).map((r) => r.keyword);
    const relatedSearches = ((rec.serp && rec.serp.related) || []).slice(0, 8);
    const L = [];
    L.push(`# Brief: ${rec.keyword}`, '');
    L.push(`- **Primary keyword:** ${rec.keyword}`);
    L.push(`- **Intent:** ${c.intent} | **Type:** ${[c.tail, ...c.types].join(', ')}`);
    L.push(`- **Difficulty:** ${rec.kd ? rec.kd.value : '-'} / 100 (${rec.kd ? rec.kd.basis : 'n/a'}) | **Demand:** ${rec.demand ? demandTier(rec.demand.value) : '-'}${rec.volume ? ` (${fmtNum(rec.volume)}/mo)` : ''} | **Trend:** ${rec.trend ? rec.trend.label : 'Unknown'}`);
    if (rec.rank) L.push(`- **Rankability for your site:** ${rec.rank.label} (~${rec.rank.chance}% chance index)`);
    L.push(`- **Target length (guideline):** ${wordCountGuide(c)} words`);
    L.push(`- **Suggested schema:** ${schemaFor(c).join(', ')}`, '');
    L.push('## Title options', ...titleIdeas(rec.keyword, c).map((t) => `- ${t}`), '');
    L.push('## Suggested outline');
    L.push(`- **Intro:** answer "${rec.keyword}" in the first 2-3 sentences, then say what the reader will get.`);
    qs.slice(0, 6).forEach((q) => L.push(`- **H2:** ${titleCase(q)}${q.endsWith('?') ? '' : '?'}`));
    secondary.slice(0, 4).forEach((s) => L.push(`- **H2:** ${titleCase(s)}`));
    L.push('- **H2:** Frequently asked questions', '- **Conclusion:** verdict / next step + internal links', '');
    if (secondary.length) L.push('## Secondary keywords to include naturally', ...secondary.map((s) => `- ${s}`), '');
    if (relatedSearches.length) L.push('## Google "related searches"', ...relatedSearches.map((s) => `- ${s}`), '');
    if (qs.length) L.push('## FAQ candidates (People Also Ask / autocomplete)', ...qs.map((q) => `- ${q}`), '');
    L.push('## How to win this SERP', ...tips(rec, m).map((t) => `- ${t}`), '');
    if (rec.kd && rec.kd.rows) {
      L.push('## Current top 10', '| # | Domain | Authority | Title match |', '|---|---|---|---|');
      rec.kd.rows.forEach((r) => L.push(`| ${r.position} | [${r.domain}](${r.url}) | ${r.authority}${r.authorityKnown ? '' : '?'} | ${Math.round(r.titleMatch * 100)}% |`));
      L.push('');
    }
    L.push('## Evidence', ...(rec.evidence || []).filter((e) => e.link).map((e) => `- ${e.text} [${e.linkLabel}](${e.link})`));
    L.push('', `_Generated by RankScope on ${new Date().toISOString().slice(0, 10)} for market ${m.gl.toUpperCase()}/${m.hl}._`);
    return L.join('\n');
  }

  /* ================================ export ================================ */

  function toCsv(recs) {
    const head = ['keyword', 'words', 'tail', 'intent', 'types', 'demand_index', 'demand_tier', 'volume', 'cpc', 'kd', 'kd_basis', 'rankability', 'rank_chance', 'trend', 'opportunity', 'engines'];
    const esc = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = recs.map((r) => [
      r.keyword, r.cls.words, r.cls.tail, r.cls.intent, r.cls.types.join('|'), r.demand && r.demand.value, r.demand && demandTier(r.demand.value),
      r.volume, r.cpc, r.kd && r.kd.value, r.kd && r.kd.basis, r.rank && r.rank.label, r.rank && r.rank.chance, r.trend && r.trend.label, r.opportunity,
      r.engines ? [...r.engines].join('|') : '',
    ].map(esc).join(','));
    return [head.join(','), ...rows].join('\n');
  }

  return {
    // constants
    QUESTION_PREFIXES, SUFFIX_MODIFIERS, UGC_DOMAINS, KNOWN_AUTH, RANK_LABELS, RANK_COLORS, MONTHS, ENGINE_NAMES,
    // helpers
    clamp, round, avg, median, normalize, tokens, coreTokens, stem, titleCase, ymd, daysAgo, fmtNum, domainOf, decodeEntities, toData, pct,
    links, gdeltQuery,
    // pipeline
    buildExpansions, parseSuggest, parseTrendsRss, parseNewsRss, parseWikiSearch, pickWikiArticle, parseWikiViews, parseWikiTop,
    parseHN, parseReddit, parseGdelt, parseSerp, parseOpr, parseDfsVolume, parseDfsKd, relevant,
    classify, aggregate, demandIndex, demandFromVolume, demandTier, kdHeuristic, kdFromSerp, authorityOf, rankability,
    trendFromDaily, seasonality, newsVelocity, matchesTrending, trendScore, volumeTrend, opportunity,
    justify, tips, clusterKeywords, titleIdeas, wordCountGuide, schemaFor, brief, toCsv,
  };
});

