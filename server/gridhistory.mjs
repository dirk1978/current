// Half-hourly national grid history (up to a year), merged from:
//   Elexon outturn summary (transmission fuels), PV_Live (solar), NESO historic demand data
//   (embedded wind, lags ~3 weeks; the stored NESO forecast fills the gap), NESO carbon
//   intensity, and the Elexon market index price.
import { getJson, every, log, openDb, DAY, london } from './lib.mjs';

const ELEXON = 'https://data.elexon.co.uk/bmrs/api/v1';
const HALF = 30 * 60e3;
const GROUP = { WIND: 'wind', NUCLEAR: 'nuclear', CCGT: 'gas', OCGT: 'gas', BIOMASS: 'biomass', NPSHYD: 'hydro', PS: 'hydro' };
const COLS = ['wind', 'solar', 'nuclear', 'gas', 'hydro', 'biomass', 'imports', 'other'];
const iso = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function table() {
  const db = openDb();
  db.exec(`CREATE TABLE IF NOT EXISTS grid_hist (t INTEGER PRIMARY KEY, wind REAL, solar REAL, nuclear REAL, gas REAL,
    hydro REAL, biomass REAL, imports REAL, other REAL, exports REAL, demand REAL, embwind REAL, carbon REAL, price REAL)`);
  return db;
}

// NESO publishes one "Historic Demand Data YYYY" resource per year; look their ids up (cached for a day).
let yearIds = null, yearIdsAt = 0;
async function yearResources() {
  if (yearIds && Date.now() - yearIdsAt < DAY) return yearIds;
  const d = await getJson('https://api.neso.energy/api/3/action/package_show?id=historic-demand-data');
  yearIds = Object.fromEntries(d.result.resources.map((r) => [r.name.match(/(\d{4})\s*$/)?.[1], r.id]).filter(([y]) => y));
  yearIdsAt = Date.now();
  return yearIds;
}

// Embedded wind actuals by half hour, from NESO's yearly historic demand files.
async function embeddedWindActuals(from, to) {
  const out = new Map();
  for (let y = new Date(from).getUTCFullYear(); y <= new Date(to).getUTCFullYear(); y++) {
    const id = (await yearResources())[y];
    if (!id) continue;
    const sql = `SELECT "SETTLEMENT_DATE","SETTLEMENT_PERIOD","EMBEDDED_WIND_GENERATION" FROM "${id}"
      WHERE "SETTLEMENT_DATE" >= '${iso(from - DAY).slice(0, 10)}' AND "SETTLEMENT_DATE" <= '${iso(to + DAY).slice(0, 10)}'`;
    const d = await getJson(`https://api.neso.energy/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, { timeout: 60000 });
    for (const r of d.result.records) {
      // Settlement periods count half hours from local (UK) midnight.
      const day = String(r.SETTLEMENT_DATE).slice(0, 10);
      const midnight = londonMidnightOf(day);
      out.set(midnight + (r.SETTLEMENT_PERIOD - 1) * HALF, Number(r.EMBEDDED_WIND_GENERATION));
    }
  }
  return out;
}

function londonMidnightOf(ymd) {
  return london(Date.parse(ymd + 'T12:00:00Z')).midnight;
}

async function fillRange(from, to) {
  const db = table();
  const rows = new Map();
  const row = (t) => {
    if (!rows.has(t)) rows.set(t, { t, ...Object.fromEntries(COLS.map((c) => [c, 0])), exports: 0, embwind: null, carbon: null, price: null });
    return rows.get(t);
  };
  const fuel = await getJson(`${ELEXON}/generation/outturn/summary?startTime=${iso(from)}&endTime=${iso(to)}`, { timeout: 60000 });
  // Recent periods come back as 5-minute readings rather than half-hours, so average them into half-hours.
  const readings = new Map();
  for (const p of fuel) {
    const t = Math.floor(Date.parse(p.startTime) / HALF) * HALF;
    readings.set(t, (readings.get(t) || 0) + 1);
    const r = row(t);
    for (const { fuelType: k, generation: mw } of p.data) {
      if (k.startsWith('INT')) { if (mw > 0) r.imports += mw; else r.exports -= mw; }
      else if (mw > 0) r[GROUP[k] || 'other'] += mw;
    }
  }
  for (const [t, n] of readings) {
    if (n < 2) continue;
    const r = rows.get(t);
    for (const k of ['wind', 'solar', 'nuclear', 'gas', 'hydro', 'biomass', 'imports', 'other', 'exports']) r[k] /= n;
  }
  const solar = await getJson(`https://api.pvlive.uk/pvlive/api/v4/pes/0?start=${iso(from)}&end=${iso(to + HALF)}`, { timeout: 60000 });
  // PV_Live stamps the end of each half hour
  for (const [, dt, mw] of solar.data) { const t = Date.parse(dt) - HALF; if (rows.has(t) && mw != null) rows.get(t).solar = mw; }
  const carbon = await getJson(`https://api.carbonintensity.org.uk/intensity/${iso(from).slice(0, 16)}Z/${iso(to).slice(0, 16)}Z`, { timeout: 60000 });
  for (const c of carbon.data) { const t = Date.parse(c.from); if (rows.has(t)) rows.get(t).carbon = c.intensity.actual ?? c.intensity.forecast; }
  const price = await getJson(`${ELEXON}/balancing/pricing/market-index?from=${iso(from)}&to=${iso(to)}&dataProviders=APXMIDP`, { timeout: 60000 });
  for (const p of price.data) { const t = Date.parse(p.startTime); if (rows.has(t) && p.volume > 0) rows.get(t).price = p.price; }
  const wind = await embeddedWindActuals(from, to).catch((e) => { log('history wind:', e.message); return new Map(); });
  const forecast = new Map(db.prepare('SELECT t, mw FROM embedded_wind WHERE t >= ? AND t < ?').all(from, to).map((r) => [r.t, r.mw]));
  const put = db.prepare(`INSERT OR REPLACE INTO grid_hist (t, ${COLS.join(', ')}, exports, demand, embwind, carbon, price)
    VALUES (?, ${COLS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?)`);
  for (const r of rows.values()) {
    if (r.t >= to) continue;
    // Elexon sometimes publishes a half hour with most fuels missing; skip those rather than store a dip.
    if (r.nuclear + r.gas + r.wind + r.biomass < 5000) { db.prepare('DELETE FROM grid_hist WHERE t = ?').run(r.t); continue; }
    // not yet published and no forecast seen: estimate from metered wind (embedded is ~27% on top)
    r.embwind = wind.get(r.t) ?? forecast.get(r.t) ?? Math.round(r.wind * 0.27);
    r.wind += r.embwind || 0;
    const gen = COLS.reduce((a, c) => a + r[c], 0);
    put.run(r.t, ...COLS.map((c) => Math.round(r[c])), Math.round(r.exports), Math.round(gen - r.exports), r.embwind, r.carbon, r.price);
  }
  return rows.size;
}

export function startGridHistory() {
  const db = table();
  every('grid history', 6 * 3600e3, async () => {
    const now = Math.floor(Date.now() / HALF) * HALF;
    // Redo the last 45 days every time (embedded wind actuals arrive late), then fill any week back to a year.
    for (let end = now, n = 0; end > now - 365 * DAY; end -= 7 * DAY, n++) {
      const start = end - 7 * DAY;
      const have = db.prepare('SELECT count(*) n FROM grid_hist WHERE t >= ? AND t < ?').get(start, end);
      if (n >= 7 && have.n >= 330) continue; // older weeks are final once filled
      await fillRange(start, end);
      await sleep(500);
    }
    log('grid history:', db.prepare('SELECT count(*) n FROM grid_hist').get().n, 'half hours');
  });
  // The most recent day, often.
  setInterval(() => fillRange(Date.now() - DAY, Math.floor(Date.now() / HALF) * HALF).catch((e) => log('grid history recent:', e.message)), 30 * 60e3);
}

// Aggregates for the history screen. bucket: 'half' | 'day' | 'week' | 'month'.
export function gridHistory(days, bucket) {
  const rows = table().prepare('SELECT * FROM grid_hist WHERE t >= ? ORDER BY t').all(Date.now() - days * DAY);
  const key = bucketKey(bucket);
  const groups = new Map();
  for (const r of rows) {
    const k = key(r.t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = { t: [], mix: Object.fromEntries(COLS.map((c) => [c, []])), demand: [], carbon: [], price: [], exports: [] };
  for (const [k, g] of groups) {
    const avg = (c) => { const v = g.map((r) => r[c]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    out.t.push(k);
    for (const c of COLS) out.mix[c].push(Math.round(avg(c)));
    out.demand.push(Math.round(avg('demand')));
    out.exports.push(Math.round(avg('exports')));
    out.carbon.push(avg('carbon') == null ? null : Math.round(avg('carbon')));
    out.price.push(avg('price') == null ? null : Math.round(avg('price') * 10) / 10);
  }
  // Records: greenest and dirtiest half hours, windiest, sunniest
  const best = (c, dir) => rows.filter((r) => r[c] != null).reduce((a, r) => (!a || (dir > 0 ? r[c] > a[c] : r[c] < a[c]) ? r : a), null);
  const pick = (r, c) => r && { t: r.t, v: r[c] };
  out.records = {
    lowestCarbon: pick(best('carbon', -1), 'carbon'), highestCarbon: pick(best('carbon', 1), 'carbon'),
    maxWind: pick(best('wind', 1), 'wind'), maxSolar: pick(best('solar', 1), 'solar'),
    maxDemand: pick(best('demand', 1), 'demand'), minDemand: pick(best('demand', -1), 'demand'),
    maxPrice: pick(best('price', 1), 'price'), minPrice: pick(best('price', -1), 'price'),
  };
  // Share of energy by fuel over the whole period
  const totals = Object.fromEntries(COLS.map((c) => [c, rows.reduce((a, r) => a + r[c], 0)]));
  const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  out.share = Object.fromEntries(COLS.map((c) => [c, totals[c] / sum * 100]));
  out.fuels = COLS;
  return out;
}

export function bucketKey(bucket) {
  if (bucket === 'half') return (t) => t;
  if (bucket === 'hour') return (t) => Math.floor(t / 3600e3) * 3600e3;
  if (bucket === 'day') return (t) => london(t).midnight;
  // Monday of that week / 1st of that month (snapped via midday so DST can't shift the day)
  if (bucket === 'week') return (t) => { const l = london(t); return london(l.midnight - ((l.dow + 6) % 7) * DAY + 12 * 3600e3).midnight; };
  if (bucket === 'month') return (t) => { const l = london(t); return london(l.midnight - (l.d - 1) * DAY + 12 * 3600e3).midnight; };
  throw new Error('bad bucket');
}
export { londonMidnightOf };
