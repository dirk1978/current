'use strict';
/* global Charts */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const C = (v) => Charts.cssVar(v);
const TZ = 'Europe/London';

const FUEL = {
  wind: { name: 'Wind' }, solar: { name: 'Solar' }, nuclear: { name: 'Nuclear' }, gas: { name: 'Gas' },
  hydro: { name: 'Hydro', sub: 'incl. pumped storage' }, biomass: { name: 'Biomass' },
  imports: { name: 'Imports' }, other: { name: 'Other', sub: 'coal, oil and others' },
};
const IC_CODE = { France: 'FR', Netherlands: 'NL', Belgium: 'BE', Norway: 'NO', Denmark: 'DK', 'N. Ireland': 'NI', Ireland: 'IE' };

// Small SVG flags (emoji flags don't render on Windows). Moyle runs to Northern Ireland, so it gets the Union flag.
const FLAG = (() => {
  const v = (a, b, c) => `<rect width="1" height="2" fill="${a}"/><rect x="1" width="1" height="2" fill="${b}"/><rect x="2" width="1" height="2" fill="${c}"/>`;
  const h = (a, b, c) => `<rect width="3" height=".667" fill="${a}"/><rect y=".667" width="3" height=".667" fill="${b}"/><rect y="1.333" width="3" height=".667" fill="${c}"/>`;
  const nordic = (bg, outer, inner) => `<rect width="3" height="2" fill="${bg}"/><rect x=".75" width=".5" height="2" fill="${outer}"/><rect y=".75" width="3" height=".5" fill="${outer}"/>` +
    (inner ? `<rect x=".875" width=".25" height="2" fill="${inner}"/><rect y=".875" width="3" height=".25" fill="${inner}"/>` : '');
  const union = '<clipPath id="uk"><rect width="3" height="2"/></clipPath><g clip-path="url(#uk)"><rect width="3" height="2" fill="#012169"/>' +
    '<path d="M0,0 3,2M3,0 0,2" stroke="#fff" stroke-width=".4"/><path d="M0,0 3,2M3,0 0,2" stroke="#C8102E" stroke-width=".13"/>' +
    '<path d="M1.5,0V2M0,1H3" stroke="#fff" stroke-width=".67"/><path d="M1.5,0V2M0,1H3" stroke="#C8102E" stroke-width=".4"/></g>';
  const svg = (body) => `<svg viewBox="0 0 3 2" preserveAspectRatio="none">${body}</svg>`;
  return {
    France: svg(v('#0055A4', '#fff', '#EF4135')), Belgium: svg(v('#000', '#FDDA24', '#EF3340')),
    Ireland: svg(v('#169B62', '#fff', '#FF883E')), Netherlands: svg(h('#AE1C28', '#fff', '#21468B')),
    Norway: svg(nordic('#BA0C2F', '#fff', '#00205B')), Denmark: svg(nordic('#C8102E', '#fff')),
    'N. Ireland': svg(union),
  };
})();

// ---------- config ----------
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }
// Where the server is and the access key. In order of preference: built into the app (personal builds), a
// connect link (#bases=...&key=..., from the QR code or the Android app), what was saved last time, or, in a
// browser, the server the page came from (with ?key= once).
const cfg = (() => {
  const inj = window.CURRENT_CONFIG || {};
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.slice(1));
  const clean = (list) => list.map((b) => b.trim().replace(/\/+$/, '')).filter(Boolean);
  let saved = null;
  try { saved = JSON.parse(store('bases') || 'null'); } catch { /* ignore */ }
  const fromLink = h.get('bases') ? clean(h.get('bases').split(',')) : h.get('base') ? clean([h.get('base')]) : null;
  const key = inj.key || h.get('key') || q.get('key') || store('key');
  const bases = inj.bases?.length ? inj.bases : fromLink || saved || (location.protocol.startsWith('http') ? [location.origin] : []);
  if (!inj.key && key) store('key', key);
  if (!inj.bases?.length && bases.length) store('bases', JSON.stringify(bases));
  if (fromLink && h.get('key')) window.Android?.saveConfig?.(bases.join(','), h.get('key'));
  if (q.get('key') || location.hash) history.replaceState(null, '', location.pathname);
  return { key, bases, base: bases[0], baked: !!inj.key };
})();

async function api(path) {
  let r, err;
  for (const base of [cfg.base, ...cfg.bases.filter((b) => b !== cfg.base)]) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      r = await fetch(base + path, { headers: { Authorization: 'Bearer ' + cfg.key }, cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      cfg.base = base;
      break;
    } catch (e) { err = e; r = null; }
  }
  if (!r) throw err;
  if (r.status === 401) throw Object.assign(new Error('The access key was refused'), { auth: true });
  if (!r.ok) throw new Error('Server said ' + r.status);
  return r.json();
}

// ---------- formatting ----------
const fmtTime = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtDay = (t) => new Date(t).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fmtDayShort = (t) => new Date(t).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
const fmtWeekday = (t) => new Date(t).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short' });
const fmtDT = (t) => `${fmtDay(t)}, ${fmtTime(t)}`;
const gw = (mw) => (mw / 1000).toFixed(mw >= 10000 ? 1 : 2);
const kw = (w) => (w >= 1000 ? (w / 1000).toFixed(2) : Math.round(w));
const kwUnit = (w) => (w >= 1000 ? 'kW' : 'W');
const pounds = (p) => '£' + (p / 100).toFixed(2);
const pence = (p) => (p >= 100 ? pounds(p) : Math.round(p) + 'p');
const kwh = (v) => (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const londonHM = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).split(':').map(Number);

function carbonStatus(g) {
  if (g == null) return { label: '—', c: '--ink-3' };
  if (g < 40) return { label: 'Very low', c: '--good' };
  if (g < 120) return { label: 'Low', c: '--good' };
  if (g < 200) return { label: 'Moderate', c: '--warn' };
  if (g < 290) return { label: 'High', c: '--bad' };
  return { label: 'Very high', c: '--bad' };
}
// Sequential-ish colour along the carbon scale (used for the line's stroke, with the value always labelled)
function carbonColor(g) {
  const stops = [[0, [52, 211, 153]], [120, [52, 211, 153]], [200, [251, 191, 36]], [300, [248, 113, 113]]];
  for (let i = 1; i < stops.length; i++) {
    if (g <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const k = (g - a) / (b - a || 1);
      return `rgb(${ca.map((x, j) => Math.round(x + (cb[j] - x) * k)).join(',')})`;
    }
  }
  return 'rgb(248,113,113)';
}

// Count-up animation for numbers
const tweens = new WeakMap();
function countTo(node, value, fmt, ms = 900) {
  if (!node) return;
  const from = tweens.get(node) ?? (parseFloat(node.dataset.v) || 0);
  tweens.set(node, value);
  node.dataset.v = value;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || from === value) { node.textContent = fmt(value); return; }
  const t0 = performance.now();
  const step = (now) => {
    // rAF timestamps can be slightly earlier than t0; clamp so the ease never runs backwards
    const k = Math.min(1, Math.max(0, (now - t0) / ms));
    const e = 1 - Math.pow(1 - k, 4);
    node.textContent = fmt(from + (value - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const ICON = {
  leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/></svg>',
};

// ---------- state ----------
let data = null;
let lastGridT = 0, lastHomeT = 0, lastCarT = 0;
let donut = null;
let freqGauge = null;
let tab = store('tab') || 'grid';
let histRange = store('range') || 'week';
let histData = {};
const shown = new Set();

// ---------- layout ----------
function setTab(t) {
  tab = t;
  store('tab', t);
  $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $$('.page').forEach((p) => p.classList.toggle('on', p.id === t));
  window.scrollTo({ top: 0, behavior: 'instant' });
  // Charts render at the page's real width, so draw a page the first time it is shown
  if (!shown.has(t)) { shown.add(t); renderAll(true); }
  if (t === 'history') loadHistory();
  reveal();
}
let io;
function reveal() {
  io ??= new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -40px 0px' });
  $$('.page.on .card.reveal:not(.in)').forEach((c) => io.observe(c));
}

// ---------- GRID ----------
function renderGrid(force) {
  const g = data.grid;
  if (!g) { $('#grid-err').innerHTML = '<div class="err">Waiting for the first grid reading…</div>'; return; }
  $('#grid-err').innerHTML = '';
  const n = g.now;
  const fresh = force || g.now.t !== lastGridT;
  lastGridT = g.now.t;

  // Aura follows carbon
  const cs = carbonStatus(n.carbon?.value);
  const root = document.documentElement.style;
  const aura = { '--good': ['#0f766e', '#1e3a8a'], '--warn': ['#92400e', '#3730a3'], '--bad': ['#9f1239', '#581c87'] }[cs.c] || ['#0f766e', '#1e3a8a'];
  root.setProperty('--aura-1', aura[0]);
  root.setProperty('--aura-2', aura[1]);

  countTo($('#carbon-val'), n.carbon?.value ?? 0, (v) => Math.round(v));
  $('#carbon-pill').style.setProperty('--c', C(cs.c));
  $('#carbon-pill').innerHTML = ICON.leaf + cs.label;
  countTo($('#demand'), n.demand / 1000, (v) => v.toFixed(1));
  countTo($('#lowc'), n.lowCarbonPct, (v) => Math.round(v));
  countTo($('#renew'), n.renewablePct, (v) => Math.round(v));
  $('#grid-time').textContent = fmtTime(n.t);

  const parts = g.fuels.map((k) => ({ key: k, color: C('--' + k), value: n.mix[k] }));
  if (fresh || !donut) donut = Charts.donut($('#ring'), parts);

  // fuel rows
  const total = g.fuels.reduce((a, k) => a + n.mix[k], 0);
  const list = $('#fuels');
  if (!list.children.length) {
    list.innerHTML = g.fuels.map((k) => `
      <div class="fuel" data-k="${k}" style="--c:var(--${k})">
        <i class="dot"></i>
        <span class="name">${FUEL[k].name}<em data-sub></em></span>
        <span class="gw"><span data-gw>0</span><small class="muted"> GW</small></span>
        <span class="pct" data-pct>0%</span>
        <span class="bar"><i></i></span>
      </div>`).join('');
    $$('.fuel', list).forEach((row) => {
      const on = () => { donut?.highlight(row.dataset.k); row.classList.add('hl'); };
      const off = () => { donut?.highlight(null); row.classList.remove('hl'); };
      row.addEventListener('pointerenter', on); row.addEventListener('pointerleave', off);
      row.addEventListener('touchstart', on, { passive: true }); row.addEventListener('touchend', () => setTimeout(off, 1200));
    });
  }
  for (const k of g.fuels) {
    const row = $(`.fuel[data-k="${k}"]`, list);
    countTo($('[data-gw]', row), n.mix[k] / 1000, (v) => v.toFixed(2));
    countTo($('[data-pct]', row), (n.mix[k] / total) * 100, (v) => v.toFixed(1) + '%');
    $('.bar i', row).style.width = ((n.mix[k] / Math.max(...g.fuels.map((f) => n.mix[f]))) * 100).toFixed(1) + '%';
    $('[data-sub]', row).textContent = k === 'wind' ? `incl. ${gw(n.embeddedWind)} GW on local networks` : k === 'solar' ? 'estimated, all on local networks' : FUEL[k].sub || '';
  }

  if (!fresh) return;

  // 24 h stacked mix
  const h = g.history;
  $('#mix-legend').innerHTML = g.fuels.map((k) => `<span><i style="--c:var(--${k})"></i>${FUEL[k].name}</span>`).join('');
  Charts.stacked($('#mix-chart'), {
    t: h.t, height: 220, label: 'Generation by fuel over the last 24 hours',
    series: g.fuels.map((k) => ({ key: k, name: FUEL[k].name, color: C('--' + k), values: h.mix[k] })),
    yFmt: (v) => v / 1000 + '', xTicks: hourTicks(h.t[0], h.t[h.t.length - 1], 6),
    tFmt: fmtTime, vFmt: (v, tot) => gw(v) + ' GW' + (tot ? ` <span class="muted">${Math.round((v / tot) * 100)}%</span>` : ''),
    totalLabel: 'Total', hideZero: true,
    onHover: (i) => donut?.highlight(null),
    footer: (i) => wxTip(data.weather, h.t[i]),
  });
  drawWeather(['#wx-wind', '#wx-sun', '#wx-temp'], data.weather, h.t[0], h.t[h.t.length - 1], hourTicks(h.t[0], h.t[h.t.length - 1], 6), fmtTime);
  $('#wx-next').innerHTML = weatherOutlook(data.weather);

  // Carbon: past actual + forecast
  const ct = g.carbon.map((c) => c[0]), cv = g.carbon.map((c) => c[1]);
  const firstFc = g.carbon.find((c) => c[2])?.[0];
  const future = g.carbon.filter((c) => c[0] >= Date.now() - 15 * 60e3);
  // greenest 3-hour window in the forecast
  let best = null;
  for (let i = 0; i + 6 <= future.length; i++) {
    const avg = future.slice(i, i + 6).reduce((a, c) => a + c[1], 0) / 6;
    if (!best || avg < best.avg) best = { t: future[i][0], avg };
  }
  Charts.lines($('#carbon-chart'), {
    t: ct, height: 190, label: 'Carbon intensity, past day and next two days',
    series: [{ name: 'Carbon intensity', color: '#fff', values: cv, dashedFrom: firstFc, width: 2.5,
      strokeStops: (lo, hi) => [[0, carbonColor(hi)], [0.5, carbonColor((lo + hi) / 2)], [1, carbonColor(lo)]],
      dotColor: carbonColor, area: true,
      gradientStops: [[0, carbonColor(Math.max(...cv)), 0.28], [1, carbonColor(Math.min(...cv)), 0]] }],
    marker: Date.now(), markerLabel: 'now', yFmt: (v) => v,
    xTicks: dayTicks(ct[0], ct[ct.length - 1]),
    bands: best ? [[best.t, best.t + 3 * 3600e3, 'rgba(52,211,153,.12)']] : [],
    tFmt: fmtDT, tExtra: (i) => (g.carbon[i][2] ? ' · forecast' : ''),
    vFmt: (v) => `${v} g · ${carbonStatus(v).label.toLowerCase()}`,
  });
  $('#carbon-best').innerHTML = best ? `${ICON.leaf}<div>Cleanest 3 hours ahead: <b>${fmtWeekday(best.t)} ${fmtTime(best.t)}–${fmtTime(best.t + 3 * 3600e3)}</b>, around <b>${Math.round(best.avg)} g</b>. Shaded on the chart.</div>` : '';

  // Interconnectors, grouped by country
  const byCountry = new Map();
  for (const ic of g.interconnectors) {
    const c = byCountry.get(ic.country) || { country: ic.country, links: [], mw: 0 };
    c.links.push(ic); c.mw += ic.mw; byCountry.set(ic.country, c);
  }
  const maxIc = Math.max(1000, ...[...byCountry.values()].map((c) => Math.abs(c.mw)));
  $('#ics').innerHTML = [...byCountry.values()].sort((a, b) => b.mw - a.mw).map((c) => {
    const w = (Math.abs(c.mw) / maxIc) * 50;
    const dir = c.mw > 10 ? 'in' : c.mw < -10 ? 'out' : '';
    return `<div class="ic">
      <span class="flag" title="${c.country}">${FLAG[c.country] || IC_CODE[c.country] || ''}</span>
      <span class="nm">${c.country}<em>${c.links.map((l) => l.name).join(' · ')}</em></span>
      <span class="flow">${dir ? `<i class="${dir}" style="width:${w}%"></i>` : ''}</span>
      <span class="mw">${gw(Math.abs(c.mw))}<em>${dir === 'in' ? 'import' : dir === 'out' ? 'export' : 'idle'}</em></span>
    </div>`;
  }).join('');
  const imp = g.interconnectors.filter((i) => i.mw > 0).reduce((a, i) => a + i.mw, 0);
  const exp = -g.interconnectors.filter((i) => i.mw < 0).reduce((a, i) => a + i.mw, 0);
  $('#ic-sum').innerHTML = `<span>Importing <b>${gw(imp)} GW</b></span><span>Exporting <b>${gw(exp)} GW</b></span><span>Net <b>${imp >= exp ? '+' : '−'}${gw(Math.abs(imp - exp))}</b></span>`;

  // Frequency
  if (n.frequency != null) {
    $('#freq-val').innerHTML = `${n.frequency.toFixed(3)}<small>Hz</small>`;
    const bands = [[49.8, 49.9, 'rgba(251,191,36,.6)'], [49.9, 49.95, 'rgba(52,211,153,.35)'], [49.95, 50.05, C('--good')], [50.05, 50.1, 'rgba(52,211,153,.35)'], [50.1, 50.2, 'rgba(251,191,36,.6)']];
    if (!freqGauge) freqGauge = Charts.gauge($('#freq-gauge'), { min: 49.8, max: 50.2, value: n.frequency, bands, fmt: (v) => v.toFixed(1) });
    else freqGauge.set(n.frequency);
    Charts.spark($('#freq-spark'), g.frequency.map((f) => f[1]), C('--good'), { ref: 50, min: Math.min(49.9, ...g.frequency.map((f) => f[1])), max: Math.max(50.1, ...g.frequency.map((f) => f[1])) });
  }
  // Price
  if (n.price != null) {
    $('#price-val').innerHTML = `£${Math.round(n.price)}<small>/MWh</small>`;
    $('#price-sub').textContent = `${(n.price / 10).toFixed(1)}p per kWh wholesale`;
    Charts.spark($('#price-spark'), g.price.map((p) => p[1]), C('--warn'));
  }
}

// ---------- weather ----------
// Nearest weather reading to t (sunshine is plotted mid-hour); null if none within `tol`
function wxIndex(w, t, sun, tol = 2 * 3600e3) {
  const ts = sun && w.sunT ? w.sunT : w.t;
  let best = -1, bd = Infinity;
  for (let i = 0; i < ts.length; i++) { const d = Math.abs(ts[i] - t); if (d < bd) { bd = d; best = i; } }
  return bd <= tol ? best : null;
}
function wxTip(w, t, tol) {
  if (!w?.t?.length) return '';
  const i = wxIndex(w, t, false, tol), j = wxIndex(w, t, true, tol);
  const parts = [];
  if (i != null && w.wind[i] != null) parts.push(Charts.row(C('--wind'), 'Wind speed', Math.round(w.wind[i]) + ' mph'));
  if (j != null && w.sun[j] != null) parts.push(Charts.row(C('--solar'), 'Sunshine', Math.round(w.sun[j]) + ' W/m²'));
  return parts.length ? `<div style="margin-top:4px;border-top:1px solid rgba(255,255,255,.1);padding-top:4px">${parts.join('')}</div>` : '';
}
// Three aligned small charts (wind, sun, temperature) over [x0, x1], matching the chart above them.
function drawWeather(ids, w, x0, x1, xTicks, tFmt) {
  if (!w?.t?.length) { ids.forEach((id) => { $(id).innerHTML = '<div class="empty">Weather is still downloading.</div>'; }); return; }
  const clip = (ts, vs) => { const t = [], v = []; ts.forEach((x, i) => { if (x >= x0 - 1 && x <= x1 + 1) { t.push(x); v.push(vs[i]); } }); return { t, v }; };
  const wind = clip(w.t, w.wind), sun = clip(w.sunT || w.t, w.sun), temp = clip(w.t, w.temp);
  const common = { xMin: x0, xMax: x1, xTicks, tFmt };
  Charts.lines($(ids[0]), { ...common, t: wind.t, height: 110, series: [{ name: 'Wind speed', color: C('--wind'), values: wind.v, area: true, width: 1.8 }],
    yFmt: (v) => v, vFmt: (v) => Math.round(v) + ' mph' + (v >= 25 ? ' · strong' : v >= 12 ? ' · good for turbines' : ' · light') });
  Charts.lines($(ids[1]), { ...common, t: sun.t, height: 90, series: [{ name: 'Sunshine', color: C('--solar'), values: sun.v, area: true, width: 1.8 }],
    yFmt: (v) => v, yMax: Math.max(100, Charts.niceMax(Math.max(...sun.v.filter((x) => x != null)) * 1.05)),
    vFmt: (v) => Math.round(v) + ' W/m²' });
  const tv = temp.v.filter((x) => x != null);
  const step = Math.max(...tv) - Math.min(...tv) > 18 ? 10 : 5;
  const lo = Math.floor(Math.min(...tv) / step) * step, hi = Math.max(Math.ceil(Math.max(...tv) / step) * step, Math.floor(Math.min(...tv) / step) * step + step);
  Charts.lines($(ids[2]), { ...common, t: temp.t, height: 90, yMin: lo, yMax: hi,
    yTicks: Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, k) => lo + k * step),
    series: [{ name: 'Temperature', color: C('--gasfuel'), values: temp.v, width: 2 }], yFmt: (v) => v + '°', vFmt: (v) => v.toFixed(1) + '°C' });
}
// One line on what the next day's weather means for the grid
function weatherOutlook(w) {
  if (!w?.t?.length) return '';
  const now = Date.now();
  const past = w.t.map((t, i) => [t, w.wind[i]]).filter(([t, v]) => t <= now && t > now - 6 * 3600e3 && v != null).map((x) => x[1]);
  const next = w.t.map((t, i) => [t, w.wind[i]]).filter(([t, v]) => t > now && v != null);
  if (!next.length) return '';
  const avgNext = next.reduce((a, x) => a + x[1], 0) / next.length;
  const avgPast = past.length ? past.reduce((a, b) => a + b, 0) / past.length : avgNext;
  const trend = avgNext > avgPast * 1.2 ? 'picking up' : avgNext < avgPast * 0.8 ? 'dropping' : 'staying about the same';
  const sunNext = (w.sunT || w.t).map((t, i) => [t, w.sun[i]]).filter(([t, v]) => t > now && v != null);
  const peak = sunNext.reduce((a, x) => (!a || x[1] > a[1] ? x : a), null);
  const sunTxt = peak && peak[1] > 30 ? ` Sunniest around <b>${fmtTime(peak[0])}</b> (${Math.round(peak[1])} W/m²).` : ' Little sun before tomorrow.';
  return `${ICON.leaf}<div>Next 24 hours: wind <b>${trend}</b>, averaging <b>${Math.round(avgNext)} mph</b> at turbine height.${sunTxt}</div>`;
}

function hourTicks(t0, t1, every) {
  const out = [];
  const start = Math.ceil(t0 / 3600e3) * 3600e3;
  for (let t = start; t <= t1; t += 3600e3) {
    const [hh, mm] = londonHM(t);
    if (mm === 0 && hh % every === 0) out.push([t, String(hh).padStart(2, '0') + ':00']);
  }
  return out;
}
function dayTicks(t0, t1) {
  const out = [];
  for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t <= t1; t += 3600e3) {
    const [hh, mm] = londonHM(t);
    if (mm !== 0) continue;
    if (hh === 0) out.push([t, fmtWeekday(t)]);
    else if (hh === 12) out.push([t, '12:00']);
  }
  return out;
}

// ---------- HOME ----------
function renderHome(force) {
  const h = data.home;
  if (!h || h.error) { $('#home-err').innerHTML = `<div class="err">Octopus: ${h?.error || 'no data'}</div>`; return; }
  $('#home-err').innerHTML = '';
  const live = h.live;
  const tf = h.tariff;
  const w = live?.w ?? 0;
  countTo($('#power'), w, (v) => kw(v));
  $('#power-unit').textContent = kwUnit(w);
  const age = live ? (Date.now() - live.t) / 1000 : 999;
  $('#power-age').textContent = live ? (age < 90 ? 'live from the Home Mini' : `last reading ${fmtTime(live.t)}`) : 'waiting for the Home Mini';
  const orb = $('#orb');
  orb.style.setProperty('--oc', tf.offPeakNow ? C('--good') : C('--elec'));
  orb.style.setProperty('--speed', Math.max(0.9, 4 - (w / 1000) * 0.6).toFixed(2) + 's');

  const rate = tf.rateNow;
  $('#rate-pill').style.setProperty('--c', tf.offPeakNow ? C('--good') : C('--elec'));
  $('#rate-pill').innerHTML = (tf.offPeakNow ? ICON.moon : ICON.sun) + (tf.offPeakNow ? 'Off-peak' : 'Peak') + ` · ${rate.toFixed(rate % 1 ? 2 : 0)}p`;
  $('#cost-hour').innerHTML = `Costing <b>${pence((w / 1000) * rate)}</b> an hour at this rate` +
    (live?.carW > 0 ? `<div class="sub" style="margin-top:4px">House <b style="color:var(--ink)">${kw(live.houseW)} ${kwUnit(live.houseW)}</b> · car <b style="color:var(--car)">${kw(live.carW)} ${kwUnit(live.carW)}</b></div>` : '');
  $('#next-cheap').textContent = tf.intelligent ? nextRateChange(tf) : '';

  // Today
  const t = h.today;
  countTo($('#t-elec'), t.elec, (v) => kwh(v));
  countTo($('#t-gas'), t.gas, (v) => kwh(v));
  $('#t-elecp').textContent = pounds(t.elecP) + ' so far' + (t.car > 0.1 ? ` · car ${kwh(t.car)} kWh` : '');
  $('#t-gasp').textContent = pounds(t.gasP) + ' so far';
  const dayStart = t.t;
  const hhE = Array(48).fill(0), hhG = Array(48).fill(0);
  for (const [tt, v] of h.halfHours.elec) if (tt >= dayStart) hhE[Math.floor((tt - dayStart) / 1800e3)] = v;
  for (const [tt, v] of h.halfHours.gas) if (tt >= dayStart) hhG[Math.floor((tt - dayStart) / 1800e3)] = v;
  Charts.spark($('#t-elec-spark'), hhE, C('--elec'), { height: 36 });
  Charts.spark($('#t-gas-spark'), hhG, C('--gasfuel'), { height: 36 });

  // Live 15 minutes
  if (h.recent.length > 1) Charts.spark($('#live-spark'), h.recent.map((r) => r[1]), tf.offPeakNow ? C('--good') : C('--elec'), { height: 54, min: 0 });

  const fresh = force || (h.power24h.length && h.power24h[h.power24h.length - 1][0] !== lastHomeT);
  if (!fresh) return;
  lastHomeT = h.power24h.length ? h.power24h[h.power24h.length - 1][0] : 0;

  // 24 h power with off-peak bands and smart-charge slots
  const pt = h.power24h.map((p) => p[0]), pv = h.power24h.map((p) => p[1]);
  const bands = offPeakBands(Date.now() - 86400e3, Date.now(), tf).map(([a, b]) => [a, b, 'rgba(52,211,153,.08)']);
  for (const d of h.dispatches.completed) bands.push([d.start, d.end, 'rgba(143,124,255,.16)']);
  Charts.lines($('#power-chart'), {
    t: pt, height: 200, label: 'Electricity use over the last 24 hours',
    series: [{ name: 'Power', color: C('--elec'), values: pv, area: true, width: 1.6 }],
    bands, yFmt: (v) => (v >= 1000 ? v / 1000 + 'k' : v), xTicks: hourTicks(pt[0], pt[pt.length - 1], 6),
    tFmt: fmtTime, vFmt: (v) => (v >= 1000 ? (v / 1000).toFixed(2) + ' kW' : v + ' W'),
    tExtra: (i) => (isOffPeak(pt[i], tf, h.dispatches) ? ' · off-peak' : ''),
  });

  renderSlots(h, tf);

  // Last 30 days
  renderDays();
}

let dayMode = store('dayMode') || 'kwh';
function renderDays() {
  const h = data.home;
  if (!h?.days) return;
  const days = h.days;
  const money = dayMode === 'gbp';
  const e = days.map((d) => (money ? d.elecP / 100 : d.elec));
  const g = days.map((d) => (money ? d.gasP / 100 : d.gas));
  const avgE = e.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, e.length - 1);
  const avgG = g.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, g.length - 1);
  const f = (v) => (money ? '£' + v.toFixed(2) : kwh(v) + ' kWh');
  const xt = days.map((d, i) => [i + 0.5, i % 7 === (days.length - 1) % 7 ? fmtDayShort(d.t) : null]).filter((x) => x[1]);
  Charts.bars($('#days-elec'), {
    t: days.map((d) => d.t), values: e, color: C('--elec'), height: 150, xTicks: xt, faded: (i) => i === days.length - 1,
    yFmt: (v) => (money ? '£' + v : v), avg: avgE, avgLabel: 'avg ' + f(avgE),
    html: (i) => `<div class="tt">${fmtDay(days[i].t)}${i === days.length - 1 ? ' · so far' : ''}</div>${Charts.row(C('--elec'), 'Electricity', f(e[i]))}`,
  });
  Charts.bars($('#days-gas'), {
    t: days.map((d) => d.t), values: g, color: C('--gasfuel'), height: 150, xTicks: xt, faded: (i) => i === days.length - 1,
    yFmt: (v) => (money ? '£' + v : v), avg: avgG, avgLabel: 'avg ' + f(avgG),
    html: (i) => `<div class="tt">${fmtDay(days[i].t)}${i === days.length - 1 ? ' · so far' : ''}</div>${Charts.row(C('--gasfuel'), 'Gas', f(g[i]))}`,
  });
}

function isOffPeak(t, tf, disp) {
  if (!tf.intelligent) return false;
  const [hh, mm] = londonHM(t);
  const m = hh * 60 + mm;
  if (m >= 23 * 60 + 30 || m < 5 * 60 + 30) return true;
  return [...(disp?.completed || []), ...(disp?.planned || [])].some((d) => t >= d.start && t < d.end);
}
// Off-peak windows (23:30–05:30 UK) overlapping [from, to]
function offPeakBands(from, to, tf) {
  if (!tf.intelligent) return [];
  const out = [];
  let start = null;
  for (let t = Math.floor(from / 1800e3) * 1800e3; t <= to + 1800e3; t += 1800e3) {
    const [hh, mm] = londonHM(t);
    const m = hh * 60 + mm;
    const on = m >= 23 * 60 + 30 || m < 5 * 60 + 30;
    if (on && start == null) start = t;
    if (!on && start != null) { out.push([start, t]); start = null; }
  }
  if (start != null) out.push([start, to + 1800e3]);
  return out;
}
function nextRateChange(tf) {
  const disp = data.home.dispatches;
  const now = Date.now();
  const target = !tf.offPeakNow;
  for (let t = Math.ceil(now / 1800e3) * 1800e3; t < now + 2 * 86400e3; t += 1800e3) {
    if (isOffPeak(t, tf, disp) === target) {
      const mins = Math.round((t - now) / 60e3);
      const when = mins < 60 ? `in ${mins} min` : `at ${fmtTime(t)}`;
      return target ? `Cheap rate (${tf.elec.offPeak}p) starts ${when}` : `Peak rate (${tf.elec.peak.toFixed(2)}p) from ${fmtTime(t)}`;
    }
  }
  return '';
}

function renderSlots(h, tf) {
  const from = Date.now() - 2 * 3600e3, to = from + 24 * 3600e3;
  const X = (t) => ((Math.min(to, Math.max(from, t)) - from) / (to - from)) * 100;
  const segs = offPeakBands(from, to, tf).map(([a, b]) => `<span class="seg offpeak" style="left:${X(a)}%;width:${X(b) - X(a)}%"></span>`);
  const planned = h.dispatches.planned.filter((d) => d.end > from && d.start < to);
  const carSlots = (data.car?.slots || []).filter((d) => d.end > from && d.start < to);
  for (const d of planned) segs.push(`<span class="seg slot" style="left:${X(d.start)}%;width:${Math.max(0.8, X(d.end) - X(d.start))}%"></span>`);
  const ticks = [];
  for (let t = Math.ceil(from / 3600e3) * 3600e3; t <= to; t += 3600e3) {
    const [hh] = londonHM(t);
    if (hh % 4 === 0) ticks.push(`<span style="left:${X(t)}%">${String(hh).padStart(2, '0')}:00</span>`);
  }
  const html = `<div class="timeline"><div class="track">${segs.join('')}</div><span class="nowmark" style="left:calc(${X(Date.now())}% - 1px)"></span><div class="ticks">${ticks.join('')}</div></div>`;
  const list = planned.length
    ? planned.map((d) => `<div class="slotrow"><b>${fmtTime(d.start)} – ${fmtTime(d.end)}</b><span>${fmtWeekday(d.start)} · ${d.kwh.toFixed(1)} kWh at ${tf.elec.offPeak}p</span></div>`).join('')
    : `<div class="slotrow"><span>No smart-charge slots planned right now. Plug the car in and Octopus will schedule them.</span></div>`;
  for (const id of ['#slots-home', '#slots-car']) {
    const host = $(id);
    if (host) host.innerHTML = html + `<div class="legend" style="margin:14px 0 0"><span><i style="--c:rgba(52,211,153,.4)"></i>Off-peak 23:30–05:30</span><span><i style="--c:var(--car)"></i>Smart charging</span></div><div class="slots">${list}</div>`;
  }
  void carSlots;
}

// ---------- CAR ----------
const miles = (km) => Math.round(km * 0.621371);
const hhmm = (sec) => (sec == null ? null : `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`);
const CAR_STATUS = {
  charging: ['Charging', '--car'], plugged: ['Plugged in', '--elec'], paused: ['Paused', '--warn'], finished: ['Charged', '--good'],
  unplugged: ['Unplugged', '--ink-3'], pending: ['Waiting for approval', '--warn'], unknown: ['—', '--ink-3'],
};

async function apiPost(path, body) {
  let r, err;
  for (const base of [cfg.base, ...cfg.bases.filter((b) => b !== cfg.base)]) {
    try {
      r = await fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      break;
    } catch (e) { err = e; r = null; }
  }
  if (!r) throw err;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Server said ' + r.status);
  return j;
}

// A small confirm sheet; resolves true/false
function confirmSheet(title, text, okLabel = 'Yes, do it') {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'sheet';
    box.innerHTML = `<div class="card sheet-card"><h2>${title}</h2><p class="sub" style="font-size:14px;margin:0 0 16px">${text}</p>
      <div class="btn-row"><button class="btn ghost" data-a="no">Cancel</button><button class="btn primary" data-a="yes">${okLabel}</button></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (e.target === box || a) { box.remove(); resolve(a === 'yes'); }
    });
  });
}
function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 400); }, 3200);
}
async function carCommand(action, args, question, detail) {
  if (!(await confirmSheet(question, detail))) return;
  try {
    await apiPost('/api/control', { target: 'ohme', action, args });
    window.Android?.haptic?.();
    toast('Done. The charger can take a minute to respond.');
    setTimeout(() => refresh().then(() => renderCar(true)), 2500);
  } catch (e) { toast('Ohme said: ' + e.message, true); }
}

function renderCar(force) {
  const c = data.car;
  const h = data.home;
  if (!c || c.error) {
    $('#car-hero').innerHTML = `<div class="empty"><b>Ohme charger not connected yet</b>Add your Ohme login to <code>.env</code> on the server to see the charger and car here. Octopus's smart-charge plan is below.</div>`;
    ['#car-controls-card', '#car-session-card'].forEach((s) => { $(s).hidden = true; });
    if (h?.tariff) renderSlots(h, h.tariff);
    return;
  }
  const fresh = force || c.updated !== lastCarT;
  lastCarT = c.updated;
  if (!fresh) return;
  ['#car-controls-card', '#car-session-card'].forEach((s) => { $(s).hidden = false; });
  const [label, col] = CAR_STATUS[c.status] || CAR_STATUS.unknown;
  const soc = c.soc;
  const sch = c.schedule;
  const target = sch?.percent ?? c.target?.percent;
  const before = c.session?.socBefore;
  const readyBy = sch?.time || hhmm(c.target?.time);
  const charging = c.status === 'charging';
  const plugged = !['unplugged', 'unknown'].includes(c.status);

  // ---- hero
  $('#car-hero').innerHTML = `
    <div class="car-head">
      <div>
        <div class="car-name">${c.car ? [c.car.make, c.car.model, c.car.variant].filter(Boolean).join(' ') : c.device?.car || 'Your car'}</div>
        <span class="pill" style="--c:var(${col})">${charging ? ICON.bolt : ICON.plug}${label}${charging ? ` · ${(c.watts / 1000).toFixed(1)} kW` : ''}</span>
      </div>
      <div class="car-soc">
        <div class="big"><span id="car-soc">0</span><small>%</small></div>
        <div class="unit">${c.rangeKm != null ? `≈ ${miles(c.rangeKm)} MILES` : 'BATTERY'}</div>
      </div>
    </div>
    <div class="car-stage ${charging ? 'charging' : ''} ${c.photo ? 'photo' : ''}">${c.photo
      ? `<img src="${cfg.base}/api/car-photo?key=${encodeURIComponent(cfg.key)}&v=${Math.round(c.photo)}" alt="The car">`
      : window.carSvg({ paint: c.paint || '#7a8594', accent: '#c8875a', charging, plugged })}</div>
    <div class="soc-bar" aria-label="Battery ${soc ?? '?'}%">
      ${before != null && plugged ? `<i class="before" style="width:${before}%"></i>` : ''}
      <i class="now ${charging ? 'live' : ''}" style="width:0%" data-w="${soc ?? 0}"></i>
      ${target != null ? `<span class="target" style="left:${target}%"><em>${target}%</em></span>` : ''}
    </div>
    <div class="soc-legend">
      <span>${before != null && plugged ? `Started at ${before}%` : ''}</span>
      <span>${target != null ? `Target ${target}%${readyBy ? ' by ' + readyBy : ''}` : ''}</span>
    </div>
    <div class="sub" style="margin-top:8px">${c.socSource === 'EXTRAPOLATION' ? 'Battery level estimated by Ohme from the energy delivered. ' : ''}${c.online ? '' : 'The charger is offline. '}</div>`;
  if (soc != null) countTo($('#car-soc'), soc, (v) => Math.round(v), 1300);
  requestAnimationFrame(() => requestAnimationFrame(() => { const b = $('.soc-bar .now'); if (b) b.style.width = b.dataset.w + '%'; }));

  // ---- controls
  const maxOn = sch?.maxCharge;
  const buttons = [];
  if (c.status === 'pending') buttons.push(`<button class="btn primary" data-cmd="approve">${ICON.bolt}Approve charge</button>`);
  if (plugged && c.status !== 'pending') {
    buttons.push(`<button class="btn ${maxOn ? 'on' : ''}" data-cmd="max">${ICON.bolt}${maxOn ? 'Max charge is on' : 'Charge now at full power'}</button>`);
    if (c.status === 'paused') buttons.push(`<button class="btn" data-cmd="resume">▶ Resume</button>`);
    else if (c.status !== 'finished') buttons.push(`<button class="btn" data-cmd="pause">❚❚ Pause</button>`);
  }
  $('#car-schedule-name').textContent = sch?.name ? `schedule: ${sch.name}` : '';
  $('#car-controls').innerHTML = `
    ${buttons.length ? `<div class="btn-row">${buttons.join('')}</div>` : `<p class="sub" style="margin:0 0 12px">Plug the car in to charge${sch ? `. Next: ${sch.percent}% by ${sch.time}` : ''}.</p>`}
    ${sch ? `<div class="target-edit">
      <label>Charge to <b id="tg-val">${target}%</b><input type="range" id="tg-pct" min="30" max="100" step="5" value="${target}"></label>
      <label>Ready by <input type="time" id="tg-time" value="${readyBy || '07:00'}"></label>
      <button class="btn primary" id="tg-save" disabled>Save</button>
    </div>
    <p class="sub" style="font-size:12px;margin:10px 0 0">${sch.days?.length ? 'This schedule runs on ' + sch.days.map((d) => d[0] + d.slice(1, 3).toLowerCase()).join(', ') + '. ' : ''}With Intelligent Octopus Go, Octopus picks the cheapest times to reach it.</p>` : ''}`;
  $$('#car-controls [data-cmd]').forEach((b) => b.addEventListener('click', () => {
    const cmd = b.dataset.cmd;
    if (cmd === 'max') carCommand('max', { on: !maxOn }, maxOn ? 'Back to smart charging?' : 'Charge now at full power?',
      maxOn ? 'The charger goes back to the smart schedule and the cheapest times.' : 'The car charges straight away at full power, whatever the rate. On Intelligent Octopus Go that can mean paying the peak rate.');
    if (cmd === 'pause') carCommand('pause', {}, 'Pause charging?', 'The car stops charging until you resume it.');
    if (cmd === 'resume') carCommand('resume', {}, 'Resume charging?', 'The car carries on charging on its schedule.');
    if (cmd === 'approve') carCommand('approve', {}, 'Approve this charge?', 'The charger starts the session it is waiting on.');
  }));
  if (sch) {
    const pct = $('#tg-pct'), time = $('#tg-time'), save = $('#tg-save');
    const changed = () => { $('#tg-val').textContent = pct.value + '%'; save.disabled = Number(pct.value) === target && time.value === readyBy; };
    pct.addEventListener('input', changed); time.addEventListener('input', changed);
    save.addEventListener('click', () => carCommand('target', { percent: Number(pct.value), time: time.value },
      `Charge to ${pct.value}% by ${time.value}?`, `This changes the "${sch.name}" schedule in Ohme.`, 'Save'));
  }

  // ---- this charge
  const ss = c.session;
  if (ss?.start) {
    const billed = (c.sessions || []).find((x) => Math.abs(x.start - ss.start) < 3 * 3600e3);
    const pence = billed?.pence ?? ss.pence;
    const kwhNow = ss.kwh;
    $('#car-session-when').textContent = `started ${fmtDT(ss.start)}`;
    $('#car-session').innerHTML = `
      <div class="charge-line"><b>${ss.socBefore ?? '?'}%</b><span class="arrow">→</span><b>${soc ?? '?'}%</b><span class="sub">+${kwh(kwhNow)} kWh${ss.rangeAddedKm ? ` · +${miles(ss.rangeAddedKm)} miles` : ''}</span></div>
      <div class="stats">
        <div class="stat"><b>${pence != null ? pounds(pence) : '—'}</b><span>${billed ? 'At your rates' : 'Ohme’s estimate'}</span></div>
        <div class="stat"><b>${pence != null && kwhNow ? (pence / kwhNow).toFixed(1) : '—'}<small>p/kWh</small></b><span>${billed?.cheapPct != null ? billed.cheapPct + '% at the cheap rate' : 'Average'}</span></div>
        <div class="stat"><b>${billed?.gPerKwh ?? ss.gPerKwh ?? '—'}<small>g/kWh</small></b><span>${billed?.co2Kg != null ? billed.co2Kg.toFixed(1) + ' kg CO₂' : ss.co2g != null ? (ss.co2g / 1000).toFixed(1) + ' kg CO₂' : 'Grid carbon'}</span></div>
      </div>
      ${ss.co2SavedVsPetrolG ? `<p class="sub" style="margin:12px 0 0">About <b style="color:var(--ink)">${(ss.co2SavedVsPetrolG / 1000).toFixed(1)} kg</b> less CO₂ than driving the same distance in a petrol car (Ohme’s figure).</p>` : ''}
      <div id="car-session-graph" style="margin-top:14px"></div>`;
    if (ss.graph?.length > 1) {
      const g = ss.graph;
      const bands = (c.slots || []).map((sl) => [sl.start, sl.end, 'rgba(143,124,255,.13)']);
      Charts.lines($('#car-session-graph'), {
        t: g.map((p) => p[0]), height: 150, series: [{ name: 'Energy added', color: C('--car'), values: g.map((p) => p[1] / 1000), area: true, width: 2 }],
        bands, yFmt: (v) => v, xTicks: hourTicks(g[0][0], g[g.length - 1][0], 2), tFmt: fmtTime, vFmt: (v) => kwh(v) + ' kWh added',
      });
    }
  } else {
    $('#car-session-when').textContent = '';
    $('#car-session').innerHTML = `<div class="empty">No charge in progress.${c.sessions?.[0] ? ` The last one was ${fmtDay(c.sessions[0].start)}: ${kwh(c.sessions[0].kwh)} kWh for ${pounds(c.sessions[0].pence)}.` : ''}</div>`;
  }

  // ---- last 30 days
  const S = c.sessions || [];
  const tot = S.reduce((a, x) => ({ kwh: a.kwh + x.kwh, p: a.p + x.pence, co2: a.co2 + (x.co2Kg || 0), cheap: a.cheap + (x.kwh * (x.cheapPct || 0)) / 100 }), { kwh: 0, p: 0, co2: 0, cheap: 0 });
  $('#car-month').innerHTML = `
    <div class="stat"><b>${kwh(tot.kwh)}<small>kWh</small></b><span>${S.length} charge${S.length === 1 ? '' : 's'}</span></div>
    <div class="stat"><b>${pounds(tot.p)}</b><span>${tot.kwh ? (tot.p / tot.kwh).toFixed(1) + 'p per kWh' : ''}</span></div>
    <div class="stat"><b>${tot.kwh ? Math.round((tot.cheap / tot.kwh) * 100) : 0}<small>%</small></b><span>At the cheap rate</span></div>
    <div class="stat"><b>${tot.co2.toFixed(1)}<small>kg</small></b><span>CO₂ · ${tot.kwh ? Math.round((tot.co2 * 1000) / tot.kwh) : 0} g/kWh</span></div>`;
  const dayBins = [];
  const t0 = new Date(Date.now() - 29 * 86400e3);
  for (let i = 0; i < 30; i++) {
    const d0 = new Date(t0.getTime() + i * 86400e3); d0.setHours(0, 0, 0, 0);
    dayBins.push({ t: d0.getTime(), kwh: 0, p: 0 });
  }
  for (const x of S) {
    const d = new Date(x.start); d.setHours(0, 0, 0, 0);
    const bin = dayBins.find((b) => b.t === d.getTime());
    if (bin) { bin.kwh += x.kwh; bin.p += x.pence; }
  }
  Charts.bars($('#car-days'), {
    t: dayBins.map((b) => b.t), values: dayBins.map((b) => b.kwh), color: C('--car'), height: 120,
    xTicks: dayBins.map((b, i) => [i + 0.5, i % 7 === 2 ? fmtDayShort(b.t) : null]).filter((x) => x[1]), yFmt: (v) => v,
    html: (i) => `<div class="tt">${fmtDay(dayBins[i].t)}</div>${Charts.row(C('--car'), 'Charged', kwh(dayBins[i].kwh) + ' kWh')}${dayBins[i].kwh ? Charts.row('#fff', 'Cost', pounds(dayBins[i].p)) : ''}`,
  });

  // ---- efficiency, from the car's own data (EU Data Act portal)
  renderCarEfficiency(c);

  // ---- charges list
  $('#car-sessions').innerHTML = S.length ? `<div class="sessions">${S.slice(0, 14).map((x) => `
    <div class="sess">
      <div class="when"><b>${fmtDay(x.start)}</b><span>${fmtTime(x.start)}–${fmtTime(x.end)} · ${x.hours}h</span></div>
      <div class="num"><b>${kwh(x.kwh)}</b><span>kWh</span></div>
      <div class="num"><b>${pounds(x.pence)}</b><span>${x.penceKwh}p/kWh</span></div>
      <div class="cheap" title="${x.cheapPct}% at the cheap rate"><i style="width:${x.cheapPct ?? 0}%"></i><span>${x.cheapPct ?? '–'}% cheap</span></div>
      <div class="co2"><span class="chip" style="--c:${x.gPerKwh != null ? carbonColor(x.gPerKwh) : 'var(--ink-3)'}">${x.gPerKwh ?? '–'} g</span></div>
    </div>`).join('')}</div>` : '<div class="empty">No charges in the last 30 days.</div>';

  // ---- charger 24 h
  if (c.history?.length > 1 && c.history.some((p) => p[1] > 0)) {
    Charts.lines($('#car-chart'), {
      t: c.history.map((p) => p[0]), height: 170, yMax: Math.max(7400, ...c.history.map((p) => p[1])),
      series: [{ name: 'Charging', color: C('--car'), values: c.history.map((p) => p[1]), area: true }],
      yFmt: (v) => v / 1000 + 'k', xTicks: hourTicks(c.history[0][0], c.history[c.history.length - 1][0], 6),
      tFmt: fmtTime, vFmt: (v) => (v / 1000).toFixed(2) + ' kW',
    });
  } else {
    $('#car-chart').innerHTML = `<div class="empty">No charging in the last 24 hours.</div>`;
  }

  // ---- facts
  const car = c.car || {};
  const miPerKwh = car.avgWhPerKm ? (1000 / car.avgWhPerKm) * 0.621371 : null;
  const fact = (k, val) => (val ? `<div><span>${k}</span><b>${val}</b></div>` : '');
  $('#car-facts').innerHTML = [
    fact('Model', [car.make, car.model, car.variant, car.year].filter(Boolean).join(' ')),
    c.data?.odometerMiles ? fact('Odometer', c.data.odometerMiles.toLocaleString() + ' miles') : '',
    c.data?.serviceDueDays != null ? fact('Service', c.data.serviceDueDays < 0 ? `<span style="color:var(--warn)">overdue by ${-c.data.serviceDueDays} days</span>` : `due in ${c.data.serviceDueDays} days`) : '',
    c.data?.batteryTempC != null ? fact('Battery temperature', c.data.batteryTempC + '°C') : '',
    fact('Battery', car.capacityWh ? Math.round(car.capacityWh / 1000) + ' kWh' : null),
    fact('Typical efficiency', miPerKwh ? `${miPerKwh.toFixed(1)} miles/kWh` : null),
    fact('Full charge costs', car.capacityWh && h?.tariff ? `${pounds((car.capacityWh / 1000) * h.tariff.elec.offPeak)} at ${h.tariff.elec.offPeak}p` : null),
    fact('Charging power', car.maxChargeW ? (car.maxChargeW / 1000).toFixed(1) + ' kW max (AC)' : null),
    fact('Charger', [c.device?.model, c.device?.firmware && 'firmware ' + c.device.firmware].filter(Boolean).join(' · ')),
    c.euda ? fact('Car data (EU Data Act)', c.euda.filesWithData ? `${c.euda.filesWithData} file${c.euda.filesWithData === 1 ? '' : 's'} with data` :
      c.euda.filesStored ? `${c.euda.filesStored} deliver${c.euda.filesStored === 1 ? 'y' : 'ies'} so far, no data in them yet` :
      c.euda.request ? `“${c.euda.request.name}”: waiting for the first delivery` : (c.euda.error || 'checking…')) : '',
  ].join('');

  if (h?.tariff) renderSlots(h, h.tariff);
  reveal();
}

function renderCarEfficiency(c) {
  const d = c.data;
  $('#car-eff-card').hidden = !d;
  if (!d) return;
  const eff = d.efficiency || {};
  // a petrol car for comparison: 45 mpg at 140p a litre (4.546 litres per gallon)
  const petrolPpm = (140 * 4.546) / 45;
  $('#car-eff-src').textContent = `from the car · updated ${fmtTime(d.updated)}`;
  $('#car-eff-stats').innerHTML = `
    <div class="stat"><b>${eff.last30 ?? '—'}<small>mi/kWh</small></b><span>Last 30 days · ${eff.year ?? '—'} over the year</span></div>
    <div class="stat"><b>${d.penceMile30 != null ? d.penceMile30 + '<small>p/mile</small>' : '—'}</b><span>${d.penceMile30 ? `Home charging · a petrol car ≈ ${Math.round(petrolPpm)}p` : 'Cost per mile'}</span></div>
    <div class="stat"><b>${d.miles30.toLocaleString()}<small>miles</small></b><span>Last 30 days · ${d.trips30} trips</span></div>`;
  const m = d.monthly.filter((x) => x.miPerKwh);
  const fmtMonth = (t) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  Charts.bars($('#car-eff-months'), {
    t: m.map((x) => x.t), values: m.map((x) => x.miPerKwh), color: C('--car'), height: 150, maxBar: 26,
    xTicks: m.map((x, i) => [i + 0.5, i % 2 === m.length % 2 ? fmtMonth(x.t) : null]).filter((x) => x[1]), yFmt: (v) => v,
    avg: eff.year, avgLabel: `year ${eff.year}`,
    html: (i) => `<div class="tt">${new Date(m[i].t).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</div>
      ${Charts.row(C('--car'), 'Efficiency', m[i].miPerKwh + ' mi/kWh')}${Charts.row('#fff', 'Driven', m[i].miles.toLocaleString() + ' miles')}${m[i].tempC != null ? Charts.row(C('--gasfuel'), 'Average outside', m[i].tempC + '°C') : ''}`,
  });
  const b = d.byTemp;
  Charts.bars($('#car-eff-temp'), {
    t: b.map((x) => x.fromC), values: b.map((x) => x.miPerKwh), height: 140, maxBar: 30,
    // colour runs cold blue to warm orange so the trend reads at a glance; the value is always in the tooltip
    colorAt: (i) => `color-mix(in oklab, ${C('--hydro')} ${Math.round(100 - (i / Math.max(1, b.length - 1)) * 100)}%, ${C('--gasfuel')})`,
    xTicks: b.map((x, i) => [i + 0.5, `${x.fromC}°`]), yFmt: (v) => v,
    html: (i) => `<div class="tt">${b[i].fromC}–${b[i].toC}°C outside</div>${Charts.row(C('--car'), 'Efficiency', b[i].miPerKwh + ' mi/kWh')}${Charts.row('#fff', 'Trips', b[i].trips)}`,
  });
  $('#car-trips').innerHTML = `<div class="sessions">${d.recentTrips.slice(0, 8).map((x) => `
    <div class="sess trip">
      <div class="when"><b>${fmtDay(x.end)}</b><span>ended ${fmtTime(x.end)}${x.tempC != null ? ` · ${Math.round(x.tempC)}°C` : ''}</span></div>
      <div class="num"><b>${x.miles}</b><span>miles</span></div>
      <div class="num"><b>${x.kwh ?? '–'}</b><span>kWh</span></div>
      <div class="num"><b>${x.kwh ? (x.miles / x.kwh).toFixed(1) : '–'}</b><span>mi/kWh</span></div>
    </div>`).join('')}</div>
    <p class="sub" style="font-size:12px;margin:10px 0 0">Energy is the battery used while driving (battery % before and after, with a ${d.usableKwh} kWh usable battery), so it leaves out standby and charging losses. Short trips are rough: the car reports whole percent.</p>`;
}

// ---------- HISTORY ----------
async function loadHistory(force) {
  const r = histRange;
  $$('.seg-ctl button').forEach((b, i) => { b.classList.toggle('on', b.dataset.r === r); if (b.dataset.r === r) $('.seg-ctl .thumb').style.transform = `translateX(${i * 100}%)`; });
  if (histData[r] && !force && Date.now() - histData[r].at < 5 * 60e3) return renderHistory(histData[r].d);
  $('#hist-body').querySelectorAll('.chart').forEach((c) => { c.innerHTML = '<div class="shimmer"></div>'; });
  try {
    const d = await api('/api/history?range=' + r);
    histData[r] = { at: Date.now(), d };
    if (r === histRange) renderHistory(d);
    // Ohme's summary is fetched by the server on first request; ask again once it has arrived
    if (d.car?.pending && !force) setTimeout(() => { if (histRange === r) loadHistory(true); }, 4000);
  } catch (e) { $('#hist-err').innerHTML = `<div class="err">${e.message}</div>`; }
}

const RANGE_LABEL = { day: 'last 24 hours', week: 'last 7 days', month: 'last 31 days', year: 'last 12 months' };
function renderHistory(d) {
  $('#hist-err').innerHTML = '';
  const r = d.range;
  $$('[data-range-label]').forEach((n) => { n.textContent = RANGE_LABEL[r]; });
  const tickFor = (ts) => {
    if (!ts.length) return [];
    if (r === 'day') return hourTicks(ts[0], ts[ts.length - 1], 6);
    if (r === 'week') return dayTicks(ts[0], ts[ts.length - 1]).filter((x) => x[1] !== '12:00');
    const out = [];
    let last = '';
    ts.forEach((t) => {
      const lab = r === 'month' ? fmtDayShort(t) : new Date(t).toLocaleDateString('en-GB', { timeZone: TZ, month: 'short' });
      const [hh] = londonHM(t);
      if (r === 'month' && (hh !== 0 || new Date(t).getUTCDate() % 7 !== 1)) return;
      // year: only label a month from its first week, so a part-month at the start doesn't crowd the next label
      if (r === 'year' && Number(new Date(t).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric' })) > 7) return;
      if (lab !== last) { out.push([t, lab]); last = lab; }
    });
    return out;
  };
  const tF = r === 'day' || r === 'week' ? fmtDT : r === 'month' ? fmtDT : fmtDay;

  // ---- Home
  const h = d.home;
  if (h && !h.error) {
    const T = h.totals;
    $('#h-totals').innerHTML = `
      <div class="stat"><b>${kwh(T.elec)}<small>kWh</small></b><span>Electricity · ${pounds(T.elecP)}</span></div>
      <div class="stat"><b>${kwh(T.gas)}<small>kWh</small></b><span>Gas · ${pounds(T.gasP)}</span></div>
      <div class="stat"><b>${pounds(T.elecP + T.gasP + T.standingP)}</b><span>Total incl. ${pounds(T.standingP)} standing</span></div>
      <div class="stat"><b>${Math.round(T.offPeakPct)}<small>%</small></b><span>Electricity at the cheap rate</span></div>${T.car != null ? `
      <div class="stat"><b>${kwh(T.house)}<small>kWh</small></b><span>House, without the car</span></div>
      <div class="stat"><b>${kwh(T.car)}<small>kWh</small></b><span>Car charging · ${T.elec ? Math.round((T.car / T.elec) * 100) : 0}% of it</span></div>` : ''}`;
    const b = h.buckets;
    const money = histMode === 'gbp';
    const per = r === 'year' ? 'week' : r === 'month' ? 'day' : 'half hour';
    $$('[data-per]').forEach((n) => { n.textContent = 'per ' + per; });
    const ev = b.map((x) => (money ? x.elecP / 100 : x.elec)), gv = b.map((x) => (money ? x.gasP / 100 : x.gas));
    const fmtV = (v) => (money ? '£' + v.toFixed(2) : kwh(v) + ' kWh');
    const bucketLabel = (t) => (r === 'year' ? 'Week of ' + fmtDayShort(t) : r === 'month' ? fmtDay(t) : fmtDT(t));
    // with a charger, the electricity charts show the car's share separately (in kWh; costs stay combined)
    const split = !money && b.some((x) => x.car > 0);
    $('#h-elec-legend').innerHTML = split ? `<span><i style="--c:var(--elec)"></i>House</span><span><i style="--c:var(--car)"></i>Car</span>` : '';
    if (r === 'day' || r === 'week') {
      Charts.lines($('#h-elec'), { t: b.map((x) => x.t), height: 170,
        series: split ? [{ name: 'House', color: C('--elec'), values: b.map((x) => x.house), area: true, width: 1.5 }, { name: 'Car', color: C('--car'), values: b.map((x) => x.car), width: 1.5 }]
          : [{ name: 'Electricity', color: C('--elec'), values: ev, area: true, width: 1.5 }],
        yFmt: (v) => (money ? '£' + v : v), xTicks: tickFor(b.map((x) => x.t)), tFmt: tF, vFmt: fmtV });
      Charts.lines($('#h-gas'), { t: b.map((x) => x.t), height: 170, series: [{ name: 'Gas', color: C('--gasfuel'), values: gv, area: true, width: 1.5 }],
        yFmt: (v) => (money ? '£' + v : v), xTicks: tickFor(b.map((x) => x.t)), tFmt: tF, vFmt: fmtV });
    } else {
      const xt = b.map((x, i) => [i + 0.5, null, x.t]);
      // labels at least 4 bars apart so neighbours (e.g. "30 Sept" and "2 Oct") don't collide
      const marks = [];
      for (const [t, l] of tickFor(b.map((x) => x.t))) {
        const x = b.findIndex((y) => y.t === t) + 0.5;
        if (!marks.length || x - marks[marks.length - 1][0] >= 4) marks.push([x, l]);
      }
      void xt;
      const avg = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
      Charts.bars($('#h-elec'), { t: b.map((x) => x.t), values: ev, color: C('--elec'), height: 170, xTicks: marks, yFmt: (v) => (money ? '£' + v : v),
        under: split ? b.map((x) => x.car) : null, underColor: C('--car'),
        avg: avg(ev), avgLabel: 'avg ' + fmtV(avg(ev)),
        html: (i) => `<div class="tt">${bucketLabel(b[i].t)}</div>${Charts.row(C('--elec'), 'Electricity', fmtV(ev[i]))}${split ? Charts.row(C('--elec'), 'House', kwh(b[i].house) + ' kWh') + Charts.row(C('--car'), 'Car', kwh(b[i].car) + ' kWh') : ''}${money ? '' : Charts.row(C('--good'), 'at cheap rate', kwh(b[i].offPeak) + ' kWh')}` });
      Charts.bars($('#h-gas'), { t: b.map((x) => x.t), values: gv, color: C('--gasfuel'), height: 170, xTicks: marks, yFmt: (v) => (money ? '£' + v : v),
        avg: avg(gv), avgLabel: 'avg ' + fmtV(avg(gv)),
        html: (i) => `<div class="tt">${bucketLabel(b[i].t)}</div>${Charts.row(C('--gasfuel'), 'Gas', fmtV(gv[i]))}` });
    }

    // Outside temperature, lined up with the gas chart above it
    const w = d.weather;
    if (w?.t?.length) {
      const tAt = b.map((x) => x.t);
      if (r === 'day' || r === 'week') {
        const pts = w.t.map((t, i) => [t, w.temp[i]]).filter(([t]) => t >= tAt[0] && t <= tAt[tAt.length - 1]);
        Charts.lines($('#h-temp'), { t: pts.map((p) => p[0]), xMin: tAt[0], xMax: tAt[tAt.length - 1], height: 90,
          series: [{ name: 'Outside', color: C('--gasfuel'), values: pts.map((p) => p[1]), width: 2 }],
          xTicks: tickFor(tAt), yFmt: (v) => v + '°', tFmt: tF, vFmt: (v) => v.toFixed(1) + '°C' });
      } else {
        // average the weather into the same day/week buckets as the bars
        const avgT = tAt.map((t0, i) => {
          const t1 = tAt[i + 1] ?? Date.now();
          const v = w.t.map((t, k) => [t, w.temp[k]]).filter(([t, x]) => t >= t0 && t < t1 && x != null).map((x) => x[1]);
          return v.length ? v.reduce((a, c) => a + c, 0) / v.length : null;
        });
        const marks = tickFor(tAt).map(([t, l]) => [tAt.indexOf(t) + 0.5, l]);
        Charts.lines($('#h-temp'), { t: tAt.map((_, i) => i + 0.5), xMin: 0, xMax: tAt.length, height: 90,
          series: [{ name: 'Outside', color: C('--gasfuel'), values: avgT.map((v) => (v == null ? null : Math.round(v * 10) / 10)), width: 2 }],
          xTicks: marks, yFmt: (v) => v + '°', tFmt: (x) => bucketLabel(tAt[Math.floor(x)]), vFmt: (v) => v.toFixed(1) + '°C average' });
      }
    }

    // Heatmap: every half hour, one row per day
    const rows = h.heatmap.slice(r === 'day' || r === 'week' ? -28 : r === 'month' ? -60 : -120);
    const ramp = (k) => `color-mix(in oklab, var(--elec) ${Math.round(8 + k * 92)}%, #0b1220)`;
    Charts.heatmap($('#h-heat'), {
      rows, ramp,
      rowLabel: (t, i) => { const dd = new Date(t).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric' }); return dd === '1' || i === 0 ? fmtDayShort(t) : (Number(dd) % 7 === 1 && rows.length < 70 ? dd : ''); },
      html: (row, ci) => `<div class="tt">${fmtDay(row.t)} · ${String(Math.floor(ci / 2)).padStart(2, '0')}:${ci % 2 ? '30' : '00'}</div>${Charts.row(C('--elec'), 'Electricity', kwh(row.v[ci]) + ' kWh')}`,
    });
    $('#h-heat-scale').innerHTML = `<span>less</span><i style="background:linear-gradient(90deg, ${ramp(0)}, ${ramp(0.5)}, ${ramp(1)})"></i><span>more</span>`;

    // Typical day: weekday v weekend (two series, one axis)
    const hh = Array.from({ length: 48 }, (_, i) => i);
    const pf = h.profile;
    const lbl = (i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`;
    Charts.lines($('#h-profile'), {
      t: hh, height: 180, xMin: 0, xMax: 47,
      series: [{ name: 'Weekdays', color: C('--elec'), values: pf.weekday.elec.map((v) => v * 2), width: 2.2, glow: true },
        { name: 'Weekends', color: C('--car'), values: pf.weekend.elec.map((v) => v * 2), width: 2.2 }],
      xTicks: [0, 12, 24, 36, 47].map((i) => [i, i === 47 ? '24:00' : lbl(i)]), yFmt: (v) => v,
      bands: [[0, 11, 'rgba(52,211,153,.07)'], [47, 47.5, 'rgba(52,211,153,.07)']],
      tFmt: lbl, vFmt: (v) => (v * 1000 >= 1000 ? v.toFixed(2) + ' kW' : Math.round(v * 1000) + ' W') + ' avg',
    });
    Charts.lines($('#h-profile-gas'), {
      t: hh, height: 150, xMin: 0, xMax: 47,
      series: [{ name: 'Weekdays', color: C('--gasfuel'), values: pf.weekday.gas.map((v) => v * 2), width: 2.2, area: true },
        { name: 'Weekends', color: C('--solar'), values: pf.weekend.gas.map((v) => v * 2), width: 2.2 }],
      xTicks: [0, 12, 24, 36, 47].map((i) => [i, i === 47 ? '24:00' : lbl(i)]), yFmt: (v) => v,
      tFmt: lbl, vFmt: (v) => v.toFixed(2) + ' kW avg',
    });
  } else {
    $('#h-totals').innerHTML = `<div class="err" style="grid-column:1/-1">Octopus: ${h?.error || 'no data'}</div>`;
  }

  // ---- Car
  const car = d.car;
  if (car?.days?.length) {
    const tot = car.total || {};
    $('#car-hist').innerHTML = `<div class="stats two" style="margin:0 0 14px">
      <div class="stat"><b>${kwh(tot.kwh || 0)}<small>kWh</small></b><span>Charged · ${tot.cost != null ? pounds(tot.cost) : ''}</span></div>
      <div class="stat"><b>${Math.round((tot.rangeKm || 0) * 0.621)}<small>miles</small></b><span>Range added</span></div>
      <div class="stat"><b>${tot.saved != null ? pounds(tot.saved) : '—'}</b><span>Saved v standard rate</span></div>
      <div class="stat"><b>${Math.round(tot.co2SavedKg || 0)}<small>kg</small></b><span>CO₂ saved v petrol</span></div></div><div id="car-bars"></div>`;
    Charts.bars($('#car-bars'), { t: car.days.map((x) => x.t), values: car.days.map((x) => x.kwh), color: C('--car'), height: 150,
      xTicks: [], yFmt: (v) => v, html: (i) => `<div class="tt">${fmtDay(car.days[i].t)}</div>${Charts.row(C('--car'), 'Charged', kwh(car.days[i].kwh) + ' kWh')}${car.days[i].cost != null ? Charts.row('#fff', 'Cost', pounds(car.days[i].cost)) : ''}` });
  } else {
    $('#car-hist').innerHTML = `<div class="empty">${car?.error === 'not configured' ? 'Connect the Ohme charger to see charging history.' : car?.pending ? 'Fetching charging history from Ohme…' : 'No charging in this period.'}</div>`;
  }

  // ---- Grid
  const g = d.grid;
  if (g?.t?.length) {
    $('#g-legend').innerHTML = g.fuels.map((k) => `<span><i style="--c:var(--${k})"></i>${FUEL[k].name}</span>`).join('');
    Charts.stacked($('#g-mix'), {
      t: g.t, height: 230, series: g.fuels.map((k) => ({ key: k, name: FUEL[k].name, color: C('--' + k), values: g.mix[k] })),
      yFmt: (v) => v / 1000 + '', xTicks: tickFor(g.t), tFmt: r === 'year' ? fmtDay : tF,
      vFmt: (v, tot) => gw(v) + ' GW' + (tot ? ` <span class="muted">${Math.round((v / tot) * 100)}%</span>` : ''), totalLabel: 'Total', hideZero: true,
      footer: (i) => wxTip(d.weather, g.t[i], r === 'year' ? 2 * 86400e3 : 2 * 3600e3),
    });
    drawWeather(['#hx-wind', '#hx-sun', '#hx-temp'], d.weather, g.t[0], g.t[g.t.length - 1], tickFor(g.t), r === 'year' ? fmtDay : tF);
    $$('[data-wx-per]').forEach((n) => { n.textContent = r === 'year' ? 'daily averages' : 'hourly'; });
    const cv = g.carbon;
    const valid = cv.filter((v) => v != null);
    Charts.lines($('#g-carbon'), {
      t: g.t, height: 170,
      series: [{ name: 'Carbon intensity', color: '#fff', values: cv, width: 2,
        strokeStops: (lo, hi) => [[0, carbonColor(hi)], [0.5, carbonColor((lo + hi) / 2)], [1, carbonColor(lo)]], dotColor: carbonColor, area: true,
        gradientStops: [[0, carbonColor(Math.max(...valid)), 0.25], [1, carbonColor(Math.min(...valid)), 0]] }],
      xTicks: tickFor(g.t), yFmt: (v) => v, tFmt: r === 'year' ? fmtDay : tF, vFmt: (v) => `${v} gCO₂/kWh`,
    });
    const avgC = valid.reduce((a, b) => a + b, 0) / (valid.length || 1);
    $('#g-carbon-avg').textContent = `average ${Math.round(avgC)} g`;
    Charts.lines($('#g-price'), {
      t: g.t, height: 150,
      series: [{ name: 'Wholesale price', color: C('--warn'), values: g.price, width: 1.8, area: true }],
      xTicks: tickFor(g.t), yFmt: (v) => '£' + v, tFmt: r === 'year' ? fmtDay : tF, vFmt: (v) => `£${v}/MWh · ${(v / 10).toFixed(1)}p/kWh`,
      yMin: Math.min(0, ...g.price.filter((v) => v != null)),
    });
    // Share bar
    const share = g.share;
    $('#g-share').innerHTML = `<div style="display:flex;height:14px;border-radius:7px;overflow:hidden;gap:2px;margin-bottom:14px">${g.fuels.map((k) => `<span title="${FUEL[k].name}" style="flex:${share[k]};background:var(--${k})"></span>`).join('')}</div>
      <div class="fuels">${g.fuels.slice().sort((a, b) => share[b] - share[a]).map((k) => `<div class="fuel" style="--c:var(--${k});grid-template-columns:12px 1fr auto"><i class="dot"></i><span class="name">${FUEL[k].name}</span><span class="gw">${share[k].toFixed(1)}%</span></div>`).join('')}</div>`;
    const rc = g.records;
    const rec = (label, x, f) => (x ? `<div class="record"><span>${label}</span><b>${f(x.v)}</b><em>${fmtDT(x.t)}</em></div>` : '');
    $('#g-records').innerHTML = [
      rec('Cleanest', rc.lowestCarbon, (v) => Math.round(v) + ' g'), rec('Dirtiest', rc.highestCarbon, (v) => Math.round(v) + ' g'),
      rec('Windiest', rc.maxWind, (v) => gw(v) + ' GW'), rec('Sunniest', rc.maxSolar, (v) => gw(v) + ' GW'),
      rec('Peak demand', rc.maxDemand, (v) => gw(v) + ' GW'), rec('Lowest demand', rc.minDemand, (v) => gw(v) + ' GW'),
      rec('Highest price', rc.maxPrice, (v) => '£' + Math.round(v)), rec('Lowest price', rc.minPrice, (v) => '£' + Math.round(v)),
    ].join('');
  } else {
    ['#g-mix', '#g-carbon', '#g-price'].forEach((s) => { $(s).innerHTML = '<div class="empty">Grid history is still downloading on the server. Check back in a few minutes.</div>'; });
  }
  reveal();
}
let histMode = store('histMode') || 'kwh';

// ---------- refresh loop ----------
function renderAll(force) {
  if (!data) return;
  try { if (tab === 'grid' || force) renderGrid(force); } catch (e) { console.error(e); }
  try { if (tab === 'home' || force) renderHome(force); } catch (e) { console.error(e); }
  try { if (tab === 'car' || force) renderCar(force); } catch (e) { console.error(e); }
}
let failures = 0;
async function refresh() {
  try {
    data = await api('/api/all');
    failures = 0;
    $('#status').classList.remove('stale');
    $('#status-text').textContent = 'LIVE';
    renderAll(false);
  } catch (e) {
    failures++;
    $('#status').classList.add('stale');
    $('#status-text').textContent = failures > 2 ? 'OFFLINE' : 'RETRYING';
    if (e.auth) return showSetup(e.message);
  }
}

// First run of the app (or a refused key): ask where the server is.
function showSetup(msg) {
  const inApp = !!window.Android;
  document.body.innerHTML = `<div class="aura"></div><main><div class="setup card">
    <div class="brand" style="justify-content:center;margin-bottom:10px">${$('#logo-tpl')?.innerHTML || ''}Current</div>
    <p class="sub">${msg || 'Connect to your Current server.'}</p>
    ${inApp ? '<p class="sub"><b>Easiest:</b> open your server in a browser on your computer, choose <b>Connect phone</b> at the top, and scan the code with this phone’s camera.</p><p class="sub">Or type it in:</p>' : ''}
    <input id="s-base" placeholder="Internet address, e.g. https://current.example.com" value="${cfg.bases[0] || ''}" autocapitalize="off" autocorrect="off">
    <input id="s-lan" placeholder="Home network address (optional), e.g. http://192.168.1.20:8092" value="${cfg.bases[1] || ''}" autocapitalize="off" autocorrect="off">
    <input id="s-key" placeholder="Access key" value="" autocapitalize="off" autocorrect="off">
    <div class="sub" id="s-msg" style="min-height:20px;margin-top:6px"></div>
    <button id="s-go">Connect</button></div></main>`;
  $('#s-go').onclick = async () => {
    const bases = [$('#s-base').value, $('#s-lan').value].map((b) => b.trim().replace(/\/+$/, '')).filter(Boolean);
    const key = $('#s-key').value.trim();
    if (!bases.length || !key) { $('#s-msg').textContent = 'Enter an address and the access key.'; return; }
    $('#s-msg').textContent = 'Checking…';
    for (const base of bases) {
      try {
        const r = await fetch(base + '/api/all', { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' });
        if (r.status === 401) { $('#s-msg').textContent = 'The server refused that key.'; return; }
        if (!r.ok) continue;
        store('bases', JSON.stringify(bases)); store('key', key);
        window.Android?.saveConfig?.(bases.join(','), key);
        location.reload();
        return;
      } catch { /* try the next address */ }
    }
    $('#s-msg').textContent = 'Couldn’t reach the server at ' + (bases.length > 1 ? 'either address.' : 'that address.');
  };
}

// In a browser: a QR code the phone's camera turns into a connect link for the Android app.
async function showConnect() {
  let info = { bases: [location.origin] };
  try { info = await api('/api/connect'); } catch { /* use this page's address */ }
  const link = 'current://connect?bases=' + encodeURIComponent(info.bases.join(',')) + '&key=' + encodeURIComponent(cfg.key);
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  const box = document.createElement('div');
  box.className = 'sheet';
  box.innerHTML = `<div class="card sheet-card">
    <h2>Connect your phone <button class="x" aria-label="Close">✕</button></h2>
    <ol class="steps">
      <li>Install the app: <a href="https://github.com/dirk1978/current/releases/latest" target="_blank" rel="noopener">download the APK</a> on your phone and open it.</li>
      <li>Point the phone’s camera at this code and tap the link it shows.</li>
    </ol>
    <div class="qr">${qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true })}</div>
    <p class="sub">It connects to ${info.bases.map((b) => `<b>${b}</b>`).join(' then ')}. ${info.bases.some((b) => b.startsWith('https://')) ? '' : 'For use away from home, set PUBLIC_URL on the server (an HTTPS address).'}</p>
    <details class="sub"><summary>Type it in instead</summary><p>Address: <code>${info.bases.join('</code> and <code>')}</code><br>Key: <code style="user-select:all">${cfg.key}</code></p></details>
  </div>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('.x')) close(); });
}

function init() {
  if (!cfg.key || !cfg.bases.length) return showSetup();
  // the Connect phone button only makes sense in a browser
  if (!window.Android && typeof qrcode === 'function') {
    const b = $('#connect');
    b.hidden = false;
    b.addEventListener('click', showConnect);
  }
  $$('nav button').forEach((b) => b.addEventListener('click', () => { setTab(b.dataset.tab); window.Android?.haptic?.(); }));
  $$('.seg-ctl button').forEach((b) => b.addEventListener('click', () => { histRange = b.dataset.r; store('range', histRange); loadHistory(); window.Android?.haptic?.(); }));
  $$('#days-toggle button').forEach((b) => b.addEventListener('click', () => {
    dayMode = b.dataset.m; store('dayMode', dayMode);
    $$('#days-toggle button').forEach((x) => x.classList.toggle('on', x === b));
    renderDays();
  }));
  $$('#days-toggle button').forEach((x) => x.classList.toggle('on', x.dataset.m === dayMode));
  $$('#hist-toggle button').forEach((b) => b.addEventListener('click', () => {
    histMode = b.dataset.m; store('histMode', histMode);
    $$('#hist-toggle button').forEach((x) => x.classList.toggle('on', x === b));
    if (histData[histRange]) renderHistory(histData[histRange].d);
  }));
  $$('#hist-toggle button').forEach((x) => x.classList.toggle('on', x.dataset.m === histMode));

  shown.add(tab);
  setTab(tab);
  refresh().then(() => renderAll(true));
  let timer = setInterval(refresh, 10e3);
  document.addEventListener('visibilitychange', () => {
    clearInterval(timer);
    if (!document.hidden) { refresh(); timer = setInterval(refresh, 10e3); }
  });
  let rw = innerWidth;
  addEventListener('resize', () => {
    if (Math.abs(innerWidth - rw) < 30) return;
    rw = innerWidth;
    clearTimeout(window._rs);
    window._rs = setTimeout(() => { renderAll(true); if (tab === 'history' && histData[histRange]) renderHistory(histData[histRange].d); }, 250);
  });
  // Pull down at the top to refresh everything
  let y0 = null;
  addEventListener('touchstart', (e) => { y0 = scrollY <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  addEventListener('touchend', (e) => {
    if (y0 != null && e.changedTouches[0].clientY - y0 > 110) {
      refresh().then(() => renderAll(true));
      if (tab === 'history') loadHistory(true);
      window.Android?.haptic?.();
    }
    y0 = null;
  }, { passive: true });
}
window.CurrentApp = { refresh, setTab };
// A connect link arriving while the app is open only changes the #hash: start again with the new details
addEventListener('hashchange', () => { if (/bases=|key=/.test(location.hash)) location.reload(); });
document.addEventListener('DOMContentLoaded', init);
