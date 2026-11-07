# RankScope: live keyword intelligence

**Find keywords you can actually rank for, with the evidence to back it up.**

RankScope is a self-hosted keyword research tool for writers, bloggers and SEOs. Give it a topic and it:

- **Discovers hundreds of real keywords** (long-tail, questions, comparisons, how-tos, buyer keywords) by querying Google, Bing, DuckDuckGo, YouTube and Amazon autocomplete with 70-140 prefix/suffix variations.
- **Shows live and recent trends**: Google Trends "Trending now", Google News velocity, Wikipedia pageviews (90-day daily and 3-year seasonality), GDELT global news volume, Hacker News and Reddit discussion, plus the official Google Trends chart embedded.
- **Scores keyword difficulty (KD)**: measured from the live Google top 10 (domain authority, title targeting, SERP features, forum/UGC slots) when a SERP key is connected. Otherwise it gives a clearly labelled estimate.
- **Tells you whether YOU can rank** on a six-step scale (*Very likely, Likely, Possible, Unlikely, Very unlikely, Near-impossible today*), based on your site's authority and the weak spots on page 1.
- **Explains every number.** Each keyword has a breakdown of the score inputs and a list of evidence with links to the raw data and graphs.
- **Plans your content**: topic clusters (pillar + supporting posts), "write these first" picks, title ideas, outlines, FAQ candidates, target length, schema and a Markdown brief (good for Obsidian or Google Docs).
- **Runs live**: Live mode auto-refreshes trending lists and re-checks your watchlist with history sparklines.

> [!IMPORTANT]
> No tool can guarantee rankings. Google uses hundreds of signals that no outside tool can see. RankScope helps you choose battles you can win and shows why. The writing still has to be the best answer on the page.

## Quick start (local)

Requires Node 18+. There are no dependencies to install.

```bash
npm start            # http://127.0.0.1:8787
npm test             # 24 unit tests (engine + proxy contract)
npm run smoke        # live check that every upstream source still parses
```

## Data sources

| Source | What it gives | Key needed |
|---|---|---|
| Google / Bing / DuckDuckGo / YouTube / Amazon autocomplete | Real queries people type, rank, Google relevance score | No |
| Google Trends "Trending now" RSS | What is spiking right now, by country | No |
| Google News RSS | 30-day coverage and velocity | No |
| Wikipedia search + pageviews | Absolute interest figures, trend, seasonality | No |
| GDELT | Global news volume timeline | No |
| Hacker News (Algolia) and Reddit | Live discussion, angles, questions | No |
| [Serper.dev](https://serper.dev) | Live Google top 10, People Also Ask, related searches, used for measured KD | Free tier (2,500 searches) |
| [Open PageRank](https://www.domcop.com/openpagerank/) | Domain authority for competitors and your site | Free |
| [DataForSEO](https://dataforseo.com) | Google Ads monthly volume, CPC, 12-month history, Labs KD | Pay-as-you-go |

Without keys, RankScope runs on the free sources, labels difficulty as **estimated**, and shows demand as a **relative index**. That is honest: absolute search volume only comes from Google Ads data. With the free Serper and Open PageRank keys, difficulty becomes **measured**. Add DataForSEO for real volumes.

## Architecture

```
public/                 <- the whole deployable site
  index.html
  assets/engine.js      <- all scoring logic (pure functions, unit-tested in Node)
  assets/app.js         <- UI + pipeline orchestration
  assets/charts.js      <- dependency-free SVG charts
  assets/api.js         <- data client (backend proxy, browser-only fallback)
  api/index.php         <- PHP proxy for Hostinger / any Apache+PHP host
  api/sources.json      <- whitelisted upstream URLs, shared by PHP and Node
  api/config.sample.php <- copy to config.php for API keys
server/                 <- Node proxy + static server (same API contract as PHP)
tests/                  <- node:test unit tests
scripts/                <- smoke test, Hostinger bundle builder
```

The backend is a thin, whitelisted, caching proxy. It only calls URLs defined in `sources.json`, validates every parameter, rate-limits per IP, caches responses (10 min to 30 days by source), and keeps API keys server-side. An optional `ACCESS_TOKEN` stops strangers from spending your paid credits if the tool is public.

**Browser-only mode:** if no backend is reachable (for example on GitHub Pages), the app falls back to sources that allow browser calls (Google, YouTube and DuckDuckGo autocomplete, Wikipedia, GDELT, Hacker News) and shows a banner listing what is missing.

## Deploy

- **Hostinger (any plan, including shared):** see [docs/DEPLOY-HOSTINGER.md](docs/DEPLOY-HOSTINGER.md). Run `npm run bundle` and upload `dist/rankscope/`.
- **Node host:** `npm start` with `HOST=0.0.0.0` and `PORT` set. Put keys in env vars (see `.env.example`).
- **GitHub Pages:** publish the `public/` folder. It runs in browser-only mode, or you can point Settings → API URL at your Hostinger backend (set `CORS_ORIGIN` there).

## How scores work

See the **Methodology** tab in the app. In short:

- **Demand:** cross-engine agreement, suggestion rank, prefix coverage, Google relevance and phrase length. Real Google Ads volume replaces this when DataForSEO is connected.
- **KD (measured):** 0.62 × position-weighted authority of the top 10, + title targeting, + SERP features, − forum/UGC share.
- **Rankability:** KD minus your authority, adjusted for beatable pages on page 1 (low authority, UGC, outdated) and rising interest.
- **Opportunity:** a weighted geometric mean of demand, ease and your rank chance, plus trend. A keyword needs both searchers and winnability to score high.

## License

MIT

