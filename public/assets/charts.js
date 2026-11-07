/*!
 * RankScope Charts - tiny dependency-free SVG charts.
 * RSCharts.line(el, series, opts) | RSCharts.spark(values, opts) -> svg string
 * RSCharts.bars(el, items, opts) | RSCharts.gauge(value, opts) -> svg string
 */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  /**
   * Multi-series line/area chart.
   * series: [{ name, color, points: [{date:'YYYY-MM-DD', v:number}] }]
   */
  function line(el, series, opts = {}) {
    el.innerHTML = '';
    const valid = series.filter((s) => s.points && s.points.length > 1);
    if (!valid.length) { el.innerHTML = `<div class="chart-empty">${esc(opts.empty || 'No data available')}</div>`; return; }
    const W = el.clientWidth || 640;
    const H = opts.height || 220;
    const P = { l: 46, r: 14, t: 14, b: 28 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const dates = [...new Set(valid.flatMap((s) => s.points.map((p) => p.date)))].sort();
    const idx = new Map(dates.map((d, i) => [d, i]));
    const yMax = niceMax(Math.max(...valid.flatMap((s) => s.points.map((p) => p.v))) * 1.05);
    const x = (i) => P.l + (dates.length === 1 ? iw / 2 : (i / (dates.length - 1)) * iw);
    const y = (v) => P.t + ih - (v / yMax) * ih;

    let svg = `<svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(opts.label || 'Trend chart')}">`;
    svg += '<defs>' + valid.map((s, i) => `<linearGradient id="g${i}_${opts.id || ''}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${s.color}" stop-opacity=".35"/><stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`).join('') + '</defs>';
    for (let g = 0; g <= 4; g++) {
      const v = (yMax / 4) * g;
      svg += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${P.l - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${fmt(v)}</text>`;
    }
    const ticks = Math.min(6, dates.length);
    for (let t = 0; t < ticks; t++) {
      const i = Math.round((t / Math.max(1, ticks - 1)) * (dates.length - 1));
      const d = dates[i];
      const label = opts.monthly ? d.slice(0, 7) : d.slice(5);
      svg += `<text x="${x(i)}" y="${H - 8}" class="axis" text-anchor="middle">${label}</text>`;
    }
    valid.forEach((s, si) => {
      const pts = s.points.map((p) => [x(idx.get(p.date)), y(p.v)]);
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
      if (valid.length === 1 || s.area) svg += `<path d="${d}L${pts[pts.length - 1][0]},${P.t + ih}L${pts[0][0]},${P.t + ih}Z" fill="url(#g${si}_${opts.id || ''})"/>`;
      svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
    (opts.markers || []).forEach((mk) => {
      if (!idx.has(mk.date)) return;
      const xi = x(idx.get(mk.date));
      svg += `<line x1="${xi}" x2="${xi}" y1="${P.t}" y2="${P.t + ih}" class="marker"/><text x="${xi + 4}" y="${P.t + 10}" class="axis">${esc(mk.label)}</text>`;
    });
    svg += `<line class="hover-line" x1="0" x2="0" y1="${P.t}" y2="${P.t + ih}" style="display:none"/>`;
    svg += `<rect x="${P.l}" y="${P.t}" width="${iw}" height="${ih}" fill="transparent" class="hit"/>`;
    svg += '</svg>';
    el.innerHTML = `<div class="chart-wrap">${svg}<div class="chart-tip" style="display:none"></div></div>` +
      (valid.length > 1 || opts.legend ? `<div class="chart-legend">${valid.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '');

    const svgEl = el.querySelector('svg');
    const tip = el.querySelector('.chart-tip');
    const hl = el.querySelector('.hover-line');
    const maps = valid.map((s) => new Map(s.points.map((p) => [p.date, p.v])));
    svgEl.querySelector('.hit').addEventListener('mousemove', (ev) => {
      const r = svgEl.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(dates.length - 1, Math.round(((px - P.l) / iw) * (dates.length - 1))));
      const d = dates[i];
      hl.setAttribute('x1', x(i)); hl.setAttribute('x2', x(i)); hl.style.display = '';
      tip.innerHTML = `<b>${d}</b>` + valid.map((s, si) => (maps[si].has(d) ? `<div><i style="background:${s.color}"></i>${esc(s.name)}: ${Number(maps[si].get(d)).toLocaleString()}</div>` : '')).join('');
      tip.style.display = '';
      const left = (x(i) / W) * r.width;
      tip.style.left = Math.min(r.width - 170, Math.max(0, left + 10)) + 'px';
    });
    svgEl.querySelector('.hit').addEventListener('mouseleave', () => { tip.style.display = 'none'; hl.style.display = 'none'; });
  }

  function spark(values, opts = {}) {
    const W = opts.width || 90, H = opts.height || 24;
    if (!values || values.length < 2) return `<svg width="${W}" height="${H}"></svg>`;
    const max = Math.max(...values), min = Math.min(...values);
    const rng = max - min || 1;
    const pts = values.map((v, i) => [(i / (values.length - 1)) * (W - 2) + 1, H - 2 - ((v - min) / rng) * (H - 4)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
    const up = values[values.length - 1] >= values[0];
    const c = opts.color || (up ? '#22c55e' : '#f97316');
    return `<svg xmlns="${NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="none" stroke="${c}" stroke-width="1.6"/></svg>`;
  }

  /** items: [{label, v, color?, sub?}] horizontal bars */
  function bars(el, items, opts = {}) {
    if (!items.length) { el.innerHTML = `<div class="chart-empty">${esc(opts.empty || 'No data')}</div>`; return; }
    const max = opts.max || Math.max(...items.map((i) => i.v)) || 1;
    el.innerHTML = '<div class="bars">' + items.map((i) => `
      <div class="bar-row" title="${esc(i.title || '')}">
        <div class="bar-label">${esc(i.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (i.v / max) * 100)}%;background:${i.color || 'var(--accent)'}"></div></div>
        <div class="bar-val">${esc(i.sub !== undefined ? i.sub : fmt(i.v))}</div>
      </div>`).join('') + '</div>';
  }

  /** Semi-circular gauge for 0-100 scores */
  function gauge(value, opts = {}) {
    const v = Math.max(0, Math.min(100, value || 0));
    const color = opts.color || (opts.invert ? (v <= 30 ? '#22c55e' : v <= 55 ? '#eab308' : v <= 75 ? '#f97316' : '#ef4444') : (v >= 70 ? '#22c55e' : v >= 45 ? '#eab308' : '#f97316'));
    const r = 42, cx = 50, cy = 50;
    const a = Math.PI * (1 - v / 100);
    const ex = cx + r * Math.cos(a), ey = cy - r * Math.sin(a);
    return `<svg xmlns="${NS}" viewBox="0 0 100 60" class="gauge">
      <path d="M8,50 A42,42 0 0 1 92,50" fill="none" stroke="var(--track)" stroke-width="9" stroke-linecap="round"/>
      <path d="M8,50 A42,42 0 0 1 ${ex.toFixed(2)},${ey.toFixed(2)}" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"/>
      <text x="50" y="47" text-anchor="middle" class="gauge-v">${Math.round(v)}</text>
      <text x="50" y="58" text-anchor="middle" class="gauge-l">${esc(opts.label || '')}</text></svg>`;
  }

  root.RSCharts = { line, spark, bars, gauge };
})(typeof self !== 'undefined' ? self : this);

