// Small hand-rolled SVG chart kit: stacked area, lines, bars, heatmap, donut, gauge, sparkline.
// Every plotted chart gets a touch/mouse crosshair with a tooltip.
'use strict';

const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || name;
}
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function ticks(max, n = 4) {
  const step = niceMax(max / n);
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
// Smooth path through points (monotone cubic, so no overshoot)
function smooth(pts) {
  if (pts.length < 3) return pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
  const n = pts.length, dx = [], dy = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; dy[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1); }
  t[0] = dy[0]; t[n - 1] = dy[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = dy[i - 1] * dy[i] <= 0 ? 0 : (dy[i - 1] + dy[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (dy[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / dy[i], b = t[i + 1] / dy[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * dy[i]; t[i + 1] = k * b * dy[i]; }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + t[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

// Shared frame: axes, gridlines, x labels, crosshair + tooltip.
function frame(host, o) {
  host.innerHTML = '';
  host.classList.add('chart');
  const W = Math.max(260, host.clientWidth || 340);
  const H = o.height || 200;
  const pad = { l: o.padL ?? 34, r: o.padR ?? 6, t: o.padT ?? 10, b: o.noX ? 6 : 24 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': o.label || '' }, host);
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const x0 = o.xMin, x1 = o.xMax;
  const yMin = o.yMin ?? 0;
  const yMax = o.yMax;
  const X = (t) => pad.l + ((t - x0) / (x1 - x0 || 1)) * iw;
  const Y = (v) => pad.t + ih - ((v - yMin) / (yMax - yMin || 1)) * ih;
  const g = el('g', {}, svg);
  if (!o.noY) {
    for (const v of o.yTicks || ticks(yMax - yMin).map((v) => v + yMin)) {
      if (v > yMax + 1e-9) continue;
      el('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: 'gridline' }, g);
      const tx = el('text', { x: pad.l - 7, y: Y(v) + 3.5, 'text-anchor': 'end' }, g);
      tx.textContent = (o.yFmt || String)(v);
    }
  }
  if (!o.noX && o.xTicks) {
    for (const [t, label] of o.xTicks) {
      if (t < x0 || t > x1) continue;
      const tx = el('text', { x: X(t), y: H - 6, 'text-anchor': 'middle' }, g);
      tx.textContent = label;
    }
  }
  return { svg, g, W, H, pad, iw, ih, X, Y };
}

function attachTip(host, f, o) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  host.appendChild(tip);
  const cross = el('line', { y1: f.pad.t, y2: f.H - f.pad.b, class: 'cross', opacity: 0 }, f.svg);
  const dots = el('g', { opacity: 0 }, f.svg);
  const n = o.n;
  const hit = el('rect', { x: f.pad.l, y: 0, width: f.iw, height: f.H, fill: 'transparent' }, f.svg);
  const show = (clientX) => {
    const r = f.svg.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * f.W;
    const i = o.indexAt(sx);
    if (i == null || i < 0 || i >= n) return hide();
    const x = o.xAt(i);
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', o.noCross ? 0 : 1);
    dots.innerHTML = '';
    for (const [y, c] of o.dotsAt ? o.dotsAt(i) : []) el('circle', { cx: x, cy: y, r: 4.5, fill: c, stroke: cssVar('--bg'), 'stroke-width': 2 }, dots);
    dots.setAttribute('opacity', 1);
    o.onHover?.(i);
    tip.innerHTML = o.html(i);
    tip.classList.add('on');
    const tw = tip.offsetWidth, hostW = host.clientWidth;
    const px = (x / f.W) * hostW;
    let left = px + 14;
    if (left + tw > hostW) left = px - tw - 14;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = Math.max(0, f.pad.t - 4) + 'px';
  };
  const hide = () => { tip.classList.remove('on'); cross.setAttribute('opacity', 0); dots.setAttribute('opacity', 0); o.onHover?.(null); };
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerdown', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') setTimeout(hide, 1600); });
  // Long horizontal drags on touch scrub the chart instead of doing nothing
  let sx0 = null;
  hit.addEventListener('touchstart', (e) => { sx0 = e.touches[0].clientX; show(sx0); }, { passive: true });
  hit.addEventListener('touchmove', (e) => { show(e.touches[0].clientX); }, { passive: true });
  hit.addEventListener('touchend', () => setTimeout(hide, 1600));
  return { tip, hide };
}

function nearestIndex(ts, X, sx) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < ts.length; i++) { const d = Math.abs(X(ts[i]) - sx); if (d < bd) { bd = d; best = i; } }
  return best;
}
function row(color, name, value) {
  return `<div class="row"><span><i style="--c:${color}"></i>${name}</span><b>${value}</b></div>`;
}

const Charts = {
  cssVar, niceMax, smooth, row,

  // series: [{name, color, values}] stacked bottom-up in the order given.
  stacked(host, o) {
    const n = o.t.length;
    if (!n) { host.innerHTML = '<div class="shimmer"></div>'; return; }
    const totals = o.t.map((_, i) => o.series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const yMax = o.yMax || niceMax(Math.max(...totals) * 1.05);
    const f = frame(host, { ...o, xMin: o.t[0], xMax: o.t[n - 1], yMax });
    const id = 'st' + (++uid);
    const base = new Array(n).fill(0);
    const layers = [];
    for (const s of o.series) {
      const top = base.map((b, i) => b + (s.values[i] || 0));
      const upper = top.map((v, i) => [f.X(o.t[i]), f.Y(v)]);
      const lower = base.map((v, i) => [f.X(o.t[i]), f.Y(v)]).reverse();
      const d = smooth(upper) + 'L' + smooth(lower).slice(1) + 'Z';
      const grad = el('linearGradient', { id: id + s.key, x1: 0, x2: 0, y1: 0, y2: 1 }, el('defs', {}, f.svg));
      el('stop', { offset: 0, 'stop-color': s.color, 'stop-opacity': 0.95 }, grad);
      el('stop', { offset: 1, 'stop-color': s.color, 'stop-opacity': 0.72 }, grad);
      const p = el('path', { d, fill: `url(#${id + s.key})`, stroke: cssVar('--bg'), 'stroke-width': 1, 'stroke-opacity': 0.55 }, f.g);
      layers.push({ s, p });
      for (let i = 0; i < n; i++) base[i] = top[i];
    }
    // Reveal: wipe in from the left
    const clip = el('clipPath', { id: id + 'clip' }, el('defs', {}, f.svg));
    const cr = el('rect', { x: 0, y: 0, width: f.W, height: f.H }, clip);
    f.g.setAttribute('clip-path', `url(#${id}clip)`);
    cr.style.width = '0px';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cr.style.transition = 'width 1.4s cubic-bezier(.2,.8,.2,1)';
      cr.style.width = f.W + 'px';
    }));
    // Gridlines must sit under the areas but the y labels above — re-append labels
    f.g.querySelectorAll('text').forEach((t) => f.svg.appendChild(t));
    if (o.marker) {
      const x = f.X(o.marker);
      if (x > f.pad.l && x < f.W - f.pad.r) el('line', { x1: x, x2: x, y1: f.pad.t, y2: f.H - f.pad.b, class: 'now' }, f.svg);
    }
    attachTip(host, f, {
      n,
      indexAt: (sx) => nearestIndex(o.t, f.X, sx),
      xAt: (i) => f.X(o.t[i]),
      onHover: (i) => o.onHover?.(i),
      html: (i) => `<div class="tt">${o.tFmt(o.t[i])}</div>` +
        [...o.series].reverse().filter((s) => (s.values[i] || 0) > 0.5 || !o.hideZero).map((s) => row(s.color, s.name, o.vFmt(s.values[i] || 0, totals[i]))).join('') +
        (o.totalLabel ? `<div class="row" style="margin-top:4px;border-top:1px solid rgba(255,255,255,.1);padding-top:4px"><span>${o.totalLabel}</span><b>${o.vFmt(totals[i])}</b></div>` : '') +
        (o.footer ? o.footer(i) : ''),
    });
  },

  // series: [{name, color, values, dashedFrom?, area?, width?}] on one shared y axis.
  lines(host, o) {
    const n = o.t.length;
    if (!n) { host.innerHTML = '<div class="shimmer"></div>'; return; }
    const all = o.series.flatMap((s) => s.values.filter((v) => v != null));
    const yMax = o.yMax ?? niceMax(Math.max(...all) * 1.08);
    const yMin = o.yMin ?? 0;
    const f = frame(host, { ...o, xMin: o.xMin ?? o.t[0], xMax: o.xMax ?? o.t[n - 1], yMax, yMin });
    const defs = el('defs', {}, f.svg);
    for (const band of o.bands || []) {
      const x1 = Math.max(f.pad.l, f.X(band[0])), x2 = Math.min(f.W - f.pad.r, f.X(band[1]));
      if (x2 > x1) el('rect', { x: x1, y: f.pad.t, width: x2 - x1, height: f.ih, fill: band[2], rx: 4 }, f.g);
    }
    for (const s of o.series) {
      const segs = [];
      let cur = [];
      s.values.forEach((v, i) => {
        if (v == null) { if (cur.length) segs.push(cur); cur = []; return; }
        cur.push([f.X(o.t[i]), f.Y(v), i]);
      });
      if (cur.length) segs.push(cur);
      for (const pts of segs) {
        if (s.area) {
          const gid = 'lg' + (++uid);
          const gr = el('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
          if (s.gradientStops) {
            for (const [off, c, op] of s.gradientStops) el('stop', { offset: off, 'stop-color': c, 'stop-opacity': op ?? 0.35 }, gr);
          } else {
            el('stop', { offset: 0, 'stop-color': s.color, 'stop-opacity': 0.38 }, gr);
            el('stop', { offset: 1, 'stop-color': s.color, 'stop-opacity': 0 }, gr);
          }
          el('path', { d: smooth(pts) + `L${pts[pts.length - 1][0]},${f.Y(yMin)}L${pts[0][0]},${f.Y(yMin)}Z`, fill: `url(#${gid})` }, f.g);
        }
        let stroke = s.color;
        if (s.strokeStops) {
          const gid = 'ls' + (++uid);
          const gr = el('linearGradient', { id: gid, x1: 0, x2: 0, y1: f.pad.t, y2: f.pad.t + f.ih, gradientUnits: 'userSpaceOnUse' }, defs);
          for (const [v, c] of s.strokeStops(yMin, yMax)) el('stop', { offset: v, 'stop-color': c }, gr);
          stroke = `url(#${gid})`;
        }
        if (s.dashedFrom != null) {
          const solid = pts.filter((p) => o.t[p[2]] <= s.dashedFrom);
          const dash = pts.filter((p) => o.t[p[2]] >= s.dashedFrom);
          if (solid.length > 1) el('path', { d: smooth(solid), fill: 'none', stroke, 'stroke-width': s.width || 2, 'stroke-linecap': 'round' }, f.g);
          if (dash.length > 1) el('path', { d: smooth(dash), fill: 'none', stroke, 'stroke-width': s.width || 2, 'stroke-dasharray': '3 4', 'stroke-linecap': 'round', opacity: 0.85 }, f.g);
        } else {
          const p = el('path', { d: smooth(pts), fill: 'none', stroke, 'stroke-width': s.width || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, f.g);
          if (s.glow) p.style.filter = `drop-shadow(0 0 6px ${s.color})`;
          const len = 4000;
          p.style.strokeDasharray = len; p.style.strokeDashoffset = len;
          requestAnimationFrame(() => { p.style.transition = 'stroke-dashoffset 1.6s cubic-bezier(.3,.7,.2,1)'; p.style.strokeDashoffset = 0; });
        }
      }
    }
    for (const m of o.points || []) {
      el('circle', { cx: f.X(m.t), cy: f.Y(m.v), r: 5, fill: m.color, stroke: cssVar('--bg'), 'stroke-width': 2.5 }, f.svg);
    }
    if (o.marker) {
      const x = f.X(o.marker);
      if (x >= f.pad.l && x <= f.W - f.pad.r) {
        el('line', { x1: x, x2: x, y1: f.pad.t, y2: f.H - f.pad.b, class: 'now' }, f.svg);
        if (o.markerLabel) { const tx = el('text', { x: x + 4, y: f.pad.t + 8 }, f.svg); tx.textContent = o.markerLabel; }
      }
    }
    if (o.noTip) return;
    attachTip(host, f, {
      n,
      indexAt: (sx) => nearestIndex(o.t, f.X, sx),
      xAt: (i) => f.X(o.t[i]),
      dotsAt: (i) => o.series.filter((s) => s.values[i] != null).map((s) => [f.Y(s.values[i]), s.color.startsWith('url') ? '#fff' : (s.dotColor ? s.dotColor(s.values[i]) : s.color)]),
      html: (i) => `<div class="tt">${o.tFmt(o.t[i])}${o.tExtra ? o.tExtra(i) : ''}</div>` +
        o.series.filter((s) => s.values[i] != null).map((s) => row(s.dotColor ? s.dotColor(s.values[i]) : s.color, s.name, o.vFmt(s.values[i], s))).join(''),
    });
  },

  // Vertical bars; values: number[]; color or colorAt(i); optional `partial` index drawn faded.
  bars(host, o) {
    const n = o.t.length;
    if (!n) { host.innerHTML = '<div class="shimmer"></div>'; return; }
    const yMax = o.yMax || niceMax(Math.max(...o.values.map((v) => v || 0)) * 1.08);
    const f = frame(host, { ...o, xMin: 0, xMax: n, yMax });
    const slot = f.iw / n;
    const bw = Math.max(1.5, Math.min(o.maxBar || 22, slot - 2)); // 2px gap between bars
    const grp = el('g', {}, f.svg);
    // a bar segment from value lo to hi; only the top segment of a stack gets rounded corners
    const seg = (x, lo, hi, round, fill, i) => {
      const yb = f.Y(lo), y = f.Y(hi), h = yb - y;
      if (h <= 0.5) return;
      const r = round ? Math.min(4, bw / 2, h) : 0;
      const d = `M${x},${yb}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${yb}Z`;
      const p = el('path', { d, fill, opacity: o.faded?.(i) ? 0.45 : 1 }, grp);
      p.style.transformOrigin = `0 ${f.Y(0)}px`;
      p.style.transform = 'scaleY(0)';
      p.style.transition = `transform .9s cubic-bezier(.2,.9,.25,1.05) ${Math.min(i * 12, 500)}ms`;
      requestAnimationFrame(() => requestAnimationFrame(() => { p.style.transform = 'scaleY(1)'; }));
    };
    const gap = (f.Y(0) - f.Y(yMax)) ? 2 * (yMax / (f.Y(0) - f.Y(yMax))) : 0; // 2px in data units
    o.values.forEach((v, i) => {
      if (!v) return;
      const x = f.pad.l + i * slot + (slot - bw) / 2;
      // o.under: an optional lower segment of each bar (e.g. the car's share of the electricity), in o.underColor
      const u = Math.min(v, o.under?.[i] || 0);
      if (u > 0) seg(x, 0, u, v - u <= gap, o.underColor, i);
      if (v - u > gap || !u) seg(x, u ? u + gap : 0, v, true, o.colorAt ? o.colorAt(i) : o.color, i);
    });
    if (o.avg) {
      el('line', { x1: f.pad.l, x2: f.W - f.pad.r, y1: f.Y(o.avg), y2: f.Y(o.avg), stroke: cssVar('--ink-2'), 'stroke-dasharray': '2 4', 'stroke-width': 1 }, f.svg);
      const tx = el('text', { x: f.W - f.pad.r, y: f.pad.t + 2, 'text-anchor': 'end', style: 'fill:var(--ink-2)' }, f.svg);
      tx.textContent = o.avgLabel || '';
    }
    const hl = el('rect', { y: f.pad.t, height: f.ih, width: slot, fill: 'rgba(255,255,255,.05)', rx: 6, opacity: 0 }, f.svg);
    grp.parentNode.insertBefore(hl, grp);
    attachTip(host, f, {
      n, noCross: true,
      indexAt: (sx) => Math.floor((sx - f.pad.l) / slot),
      xAt: (i) => f.pad.l + (i + 0.5) * slot,
      onHover: (i) => { if (i == null) hl.setAttribute('opacity', 0); else { hl.setAttribute('x', f.pad.l + i * slot); hl.setAttribute('opacity', 1); } },
      html: (i) => o.html(i),
    });
  },

  // rows: [{t, v: number[48]}], sequential single-hue ramp.
  heatmap(host, o) {
    host.innerHTML = '';
    host.classList.add('chart');
    const rows = o.rows;
    if (!rows.length) { host.innerHTML = '<div class="shimmer"></div>'; return; }
    const W = Math.max(260, host.clientWidth || 340);
    const padL = 40, padT = 4, padB = 22;
    const cols = 48;
    const cw = (W - padL) / cols;
    const ch = Math.max(3, Math.min(9, 360 / rows.length));
    const H = padT + rows.length * ch + padB;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, class: 'heat' }, host);
    const all = rows.flatMap((r) => r.v.filter((x) => x != null)).sort((a, b) => a - b);
    const max = all[Math.floor(all.length * 0.98)] || 1; // clip the top 2% so one spike doesn't wash it out
    const g = el('g', {}, svg);
    rows.forEach((r, ri) => {
      r.v.forEach((v, ci) => {
        if (v == null) return;
        const k = Math.min(1, v / max);
        el('rect', { x: padL + ci * cw + 0.5, y: padT + ri * ch + 0.5, width: cw - 1, height: ch - 1, rx: Math.min(2, ch / 3), fill: o.ramp(k) }, g);
      });
      if (o.rowLabel) {
        const lab = o.rowLabel(r.t, ri);
        if (lab) { const tx = el('text', { x: padL - 6, y: padT + ri * ch + ch / 2 + 3.5, 'text-anchor': 'end' }, svg); tx.textContent = lab; }
      }
    });
    for (const h of [0, 6, 12, 18, 24]) {
      const tx = el('text', { x: padL + h * 2 * cw, y: H - 6, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle' }, svg);
      tx.textContent = h === 24 ? '24:00' : String(h).padStart(2, '0') + ':00';
    }
    const ring = el('rect', { width: cw + 2, height: ch + 2, fill: 'none', stroke: '#fff', 'stroke-width': 1.5, rx: 2, opacity: 0 }, svg);
    const tip = document.createElement('div');
    tip.className = 'tip';
    host.appendChild(tip);
    const show = (cx, cy) => {
      const r = svg.getBoundingClientRect();
      const sx = ((cx - r.left) / r.width) * W, sy = ((cy - r.top) / r.height) * H;
      const ci = Math.floor((sx - padL) / cw), ri = Math.floor((sy - padT) / ch);
      if (ci < 0 || ci >= cols || ri < 0 || ri >= rows.length || rows[ri].v[ci] == null) { tip.classList.remove('on'); ring.setAttribute('opacity', 0); return; }
      ring.setAttribute('x', padL + ci * cw - 0.5); ring.setAttribute('y', padT + ri * ch - 0.5); ring.setAttribute('opacity', 1);
      tip.innerHTML = o.html(rows[ri], ci);
      tip.classList.add('on');
      const hostW = host.clientWidth, px = ((padL + ci * cw) / W) * hostW;
      let left = px + 16; if (left + tip.offsetWidth > hostW) left = px - tip.offsetWidth - 10;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = Math.max(0, ((padT + ri * ch) / H) * r.height - 50) + 'px';
    };
    svg.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
    svg.addEventListener('pointerdown', (e) => show(e.clientX, e.clientY));
    svg.addEventListener('pointerleave', () => { tip.classList.remove('on'); ring.setAttribute('opacity', 0); });
  },

  // Ring of arcs with 2px gaps; parts: [{key, color, value}]
  donut(svgHost, parts, o = {}) {
    const S = 300, R = o.r || 128, w = o.width || 20;
    svgHost.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${S} ${S}` }, svgHost);
    const c = S / 2;
    const defs = el('defs', {}, svg);
    const glow = el('filter', { id: 'glow' + (++uid), x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
    el('feGaussianBlur', { stdDeviation: 6 }, glow);
    el('circle', { cx: c, cy: c, r: R, fill: 'none', stroke: 'rgba(255,255,255,.05)', 'stroke-width': w }, svg);
    const total = parts.reduce((a, p) => a + p.value, 0) || 1;
    const circ = 2 * Math.PI * R;
    const gapLen = 3;
    let acc = 0;
    const arcs = [];
    const glowG = el('g', { filter: `url(#${glow.id})`, opacity: 0.55 }, svg);
    const mainG = el('g', {}, svg);
    for (const p of parts) {
      const frac = p.value / total;
      const len = Math.max(0, frac * circ - gapLen);
      if (len <= 0.5) { acc += frac; continue; }
      for (const [g, extra] of [[glowG, 0], [mainG, 0]]) {
        const a = el('circle', {
          cx: c, cy: c, r: R, fill: 'none', stroke: p.color, 'stroke-width': w + extra, 'stroke-linecap': 'butt',
          'stroke-dasharray': `0 ${circ}`, transform: `rotate(${-90 + acc * 360} ${c} ${c})`,
        }, g);
        a.dataset.key = p.key;
        a.style.transition = 'stroke-dasharray 1.3s cubic-bezier(.2,.8,.2,1), opacity .3s';
        arcs.push([a, `${len} ${circ}`]);
      }
      acc += frac;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => arcs.forEach(([a, d]) => a.setAttribute('stroke-dasharray', d))));
    return {
      highlight(key) {
        mainG.querySelectorAll('circle').forEach((a) => { a.style.opacity = !key || a.dataset.key === key ? 1 : 0.25; });
        glowG.querySelectorAll('circle').forEach((a) => { a.style.opacity = !key || a.dataset.key === key ? 1 : 0.1; });
      },
    };
  },

  // Semicircle gauge with a needle
  gauge(host, { min, max, value, bands, fmt }) {
    host.innerHTML = '';
    const W = 200, H = 116, cx = 100, cy = 104, R = 82;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` }, host);
    const ang = (v) => Math.PI * (1 - (Math.min(max, Math.max(min, v)) - min) / (max - min));
    const pt = (a, r) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    const arc = (a0, a1, r) => { const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r); return `M${x0},${y0}A${r},${r} 0 0 1 ${x1},${y1}`; };
    for (const [v0, v1, color] of bands) el('path', { d: arc(ang(v0), ang(v1), R), stroke: color, 'stroke-width': 8, fill: 'none', 'stroke-linecap': 'butt' }, svg);
    for (const v of [min, (min + max) / 2, max]) {
      const [x, y] = pt(ang(v), R - 16);
      const tx = el('text', { x, y: y + 3, 'text-anchor': 'middle', fill: cssVar('--ink-3'), 'font-size': 9, 'font-weight': 600 }, svg);
      tx.textContent = fmt(v);
    }
    const needle = el('g', {}, svg);
    el('line', { x1: cx, y1: cy, x2: cx - R + 6, y2: cy, stroke: '#fff', 'stroke-width': 2.5, 'stroke-linecap': 'round' }, needle);
    el('circle', { cx, cy, r: 6, fill: '#fff' }, needle);
    el('circle', { cx, cy, r: 2.5, fill: cssVar('--bg') }, needle);
    const deg = 180 - (ang(value) * 180) / Math.PI;
    needle.style.transformOrigin = `${cx}px ${cy}px`;
    needle.style.transform = 'rotate(0deg)';
    needle.style.transition = 'transform 1.4s cubic-bezier(.3,1.5,.5,1)';
    requestAnimationFrame(() => requestAnimationFrame(() => { needle.style.transform = `rotate(${deg}deg)`; }));
    return { set(v) { needle.style.transform = `rotate(${180 - (ang(v) * 180) / Math.PI}deg)`; } };
  },

  spark(host, values, color, o = {}) {
    host.innerHTML = '';
    host.classList.add('chart');
    const W = Math.max(120, host.clientWidth || 160), H = o.height || 44;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, preserveAspectRatio: 'none' }, host);
    const vs = values.filter((v) => v != null);
    if (vs.length < 2) return;
    const lo = o.min ?? Math.min(...vs), hi = o.max ?? Math.max(...vs);
    const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6)]);
    const gid = 'sp' + (++uid);
    const gr = el('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 }, el('defs', {}, svg));
    el('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0.35 }, gr);
    el('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0 }, gr);
    el('path', { d: smooth(pts) + `L${W},${H}L0,${H}Z`, fill: `url(#${gid})` }, svg);
    el('path', { d: smooth(pts), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }, svg);
    const last = pts[pts.length - 1];
    el('circle', { cx: last[0], cy: last[1], r: 3.5, fill: color }, svg);
    if (o.ref != null) el('line', { x1: 0, x2: W, y1: H - 3 - ((o.ref - lo) / (hi - lo || 1)) * (H - 6), y2: H - 3 - ((o.ref - lo) / (hi - lo || 1)) * (H - 6), stroke: 'rgba(255,255,255,.18)', 'stroke-dasharray': '2 3' }, svg);
  },
};
window.Charts = Charts;
