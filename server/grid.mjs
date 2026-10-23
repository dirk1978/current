// National grid: fuel mix (Elexon FUELINST), solar (Sheffield Solar PV_Live), embedded wind
// (NESO forecast), carbon intensity (NESO), frequency and wholesale price (Elexon). All free, no key.
import { getJson, every, log, openDb, HOUR, DAY } from './lib.mjs';

const ELEXON = 'https://data.elexon.co.uk/bmrs/api/v1';
const MIN5 = 5 * 60e3;
const HALF = 30 * 60e3;

export const INTERCONNECTORS = {
  INTFR: ['France', 'IFA'], INTIFA2: ['France', 'IFA2'], INTELEC: ['France', 'ElecLink'],
  INTNED: ['Netherlands', 'BritNed'], INTNEM: ['Belgium', 'Nemo Link'], INTNSL: ['Norway', 'North Sea Link'],
  INTVKL: ['Denmark', 'Viking Link'], INTIRL: ['N. Ireland', 'Moyle'], INTEW: ['Ireland', 'East–West'],
  INTGRNL: ['Ireland', 'Greenlink'],
};
// Fuel groups shown in the app, in fixed display order.
// Pumped storage counts as hydro; its pumping is demand, not negative generation.
export const FUELS = ['wind', 'solar', 'nuclear', 'gas', 'hydro', 'biomass', 'imports', 'other'];
const GROUP = { WIND: 'wind', NUCLEAR: 'nuclear', CCGT: 'gas', OCGT: 'gas', BIOMASS: 'biomass', NPSHYD: 'hydro',
  PS: 'hydro', COAL: 'other', OIL: 'other', OTHER: 'other' };

const iso = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';
const floor = (t, step) => Math.floor(t / step) * step;

const state = {
  fuelinst: new Map(),   // t -> {FUELTYPE: MW}
  solar: new Map(),      // t (end of half hour) -> MW
  carbon: [],            // [{t, actual, forecast, index}] past 24h + 48h ahead
  freq: [],              // [[t, hz]]
  price: [],             // [[t, £/MWh]]
  updated: 0,
};

async function pullFuel(sinceMs) {
  const rows = await getJson(`${ELEXON}/datasets/FUELINST/stream?publishDateTimeFrom=${iso(sinceMs)}&publishDateTimeTo=${iso(Date.now() + MIN5)}`);
  for (const r of rows) {
    const t = Date.parse(r.startTime);
    if (!state.fuelinst.has(t)) state.fuelinst.set(t, {});
    state.fuelinst.get(t)[r.fuelType] = r.generation;
  }
  for (const t of state.fuelinst.keys()) if (t < Date.now() - DAY - HOUR) state.fuelinst.delete(t);
}

async function pullSolar() {
  const d = await getJson(`https://api.pvlive.uk/pvlive/api/v4/pes/0?start=${iso(Date.now() - DAY - HOUR)}&end=${iso(Date.now())}`);
  state.solar.clear();
  for (const [, dt, mw] of d.data) if (mw != null) state.solar.set(Date.parse(dt), mw);
}

async function pullEmbeddedWind() {
  // The forecast only runs forward from now, so every value seen is kept to build up a history.
  const sql = `SELECT "DATE_GMT","TIME_GMT","EMBEDDED_WIND_FORECAST" FROM "db6c038f-98af-4570-ab60-24d71ebd0ae5" ORDER BY "_id" ASC LIMIT 100`;
  const d = await getJson(`https://api.neso.energy/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`);
  const db = openDb();
  const put = db.prepare('INSERT OR REPLACE INTO embedded_wind (t, mw) VALUES (?, ?)');
  for (const r of d.result.records) {
    const t = Date.parse(r.DATE_GMT.slice(0, 10) + 'T' + r.TIME_GMT + ':00Z');
    // Only overwrite future values; past ones keep the last forecast made before they happened.
    if (t > Date.now() - HALF) put.run(t, Number(r.EMBEDDED_WIND_FORECAST));
  }
  db.prepare('DELETE FROM embedded_wind WHERE t < ?').run(Date.now() - 60 * DAY);
}

async function pullCarbon() {
  const now = floor(Date.now(), HALF);
  const [past, fwd] = await Promise.all([
    getJson(`https://api.carbonintensity.org.uk/intensity/${iso(now - DAY).slice(0, 16)}Z/pt24h`),
    getJson(`https://api.carbonintensity.org.uk/intensity/${iso(now).slice(0, 16)}Z/fw48h`),
  ]);
  const map = new Map();
  for (const r of [...past.data, ...fwd.data]) {
    map.set(Date.parse(r.from), { t: Date.parse(r.from), actual: r.intensity.actual, forecast: r.intensity.forecast, index: r.intensity.index });
  }
  state.carbon = [...map.values()].sort((a, b) => a.t - b.t);
}

async function pullFreq() {
  const d = await getJson(`${ELEXON}/system/frequency?from=${iso(Date.now() - 15 * 60e3)}&to=${iso(Date.now())}`);
  state.freq = d.data.map((r) => [Date.parse(r.measurementTime), r.frequency]).sort((a, b) => a[0] - b[0]);
}

async function pullPrice() {
  const d = await getJson(`${ELEXON}/balancing/pricing/market-index?from=${iso(Date.now() - DAY)}&to=${iso(Date.now())}&dataProviders=APXMIDP`);
  state.price = d.data.filter((r) => r.volume > 0).map((r) => [Date.parse(r.startTime), r.price]).sort((a, b) => a[0] - b[0]);
}

// Linear interpolation over a sorted [[t, v]] list (holds the end values outside it).
function interp(points, t) {
  if (!points.length) return 0;
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i][0]) {
      const [t0, v0] = points[i - 1], [t1, v1] = points[i];
      return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
    }
  }
  return points[points.length - 1][1];
}

function embeddedWindSeries() {
  return openDb().prepare('SELECT t, mw FROM embedded_wind WHERE t >= ? ORDER BY t').all(Date.now() - DAY - 2 * HOUR).map((r) => [r.t, r.mw]);
}

// One 5-minute point: MW per fuel group, interconnector flows, and demand.
function point(t, raw, solarPts, windPts) {
  const mix = Object.fromEntries(FUELS.map((f) => [f, 0]));
  const flows = {};
  let pumping = 0;
  for (const [k, mw] of Object.entries(raw)) {
    if (k in INTERCONNECTORS) { flows[k] = mw; if (mw > 0) mix.imports += mw; continue; }
    const g = GROUP[k] || 'other';
    if (k === 'PS' && mw < 0) pumping -= mw; else mix[g] += Math.max(0, mw);
  }
  // PV_Live timestamps the end of each half hour; shift back 15 min to centre it.
  mix.solar = Math.max(0, interp(solarPts, t + 15 * 60e3));
  const embWind = Math.max(0, interp(windPts, t));
  mix.wind += embWind;
  const exports = -Object.values(flows).filter((v) => v < 0).reduce((a, b) => a + b, 0);
  const generation = Object.values(mix).reduce((a, b) => a + b, 0);
  return { t, mix, flows, embeddedWind: embWind, exports, pumping, demand: generation - exports - pumping };
}

export function gridSnapshot() {
  const solarPts = [...state.solar.entries()].sort((a, b) => a[0] - b[0]);
  const windPts = embeddedWindSeries();
  const times = [...state.fuelinst.keys()].sort((a, b) => a - b)
    // a 5-minute slot is only complete once (nearly) every fuel type has reported
    .filter((t) => Object.keys(state.fuelinst.get(t)).length >= 15);
  if (!times.length) return null;
  const series = times.filter((t) => t >= Date.now() - DAY).map((t) => point(t, state.fuelinst.get(t), solarPts, windPts));
  const now = series[series.length - 1];
  const carbonNow = [...state.carbon].reverse().find((c) => c.t <= Date.now()) || null;
  const lowCarbon = now.mix.wind + now.mix.solar + now.mix.nuclear + now.mix.hydro + now.mix.biomass;
  const renewable = now.mix.wind + now.mix.solar + now.mix.hydro + now.mix.biomass;
  const generation = FUELS.reduce((a, f) => a + now.mix[f], 0);
  return {
    updated: state.updated,
    fuels: FUELS,
    now: {
      ...now,
      generation,
      lowCarbonPct: (lowCarbon / generation) * 100,
      renewablePct: (renewable / generation) * 100,
      carbon: carbonNow && { value: carbonNow.actual ?? carbonNow.forecast, index: carbonNow.index },
      frequency: state.freq.length ? state.freq[state.freq.length - 1][1] : null,
      price: state.price.length ? state.price[state.price.length - 1][1] : null,
    },
    interconnectors: Object.entries(INTERCONNECTORS).map(([id, [country, name]]) => ({ id, country, name, mw: now.flows[id] ?? 0 })),
    history: {
      t: series.map((p) => p.t),
      mix: Object.fromEntries(FUELS.map((f) => [f, series.map((p) => Math.round(p.mix[f]))])),
      demand: series.map((p) => Math.round(p.demand)),
    },
    carbon: state.carbon.map((c) => [c.t, c.actual ?? c.forecast, c.actual == null ? 1 : 0]),
    frequency: state.freq,
    price: state.price,
  };
}

export function startGrid() {
  let first = true;
  every('fuel', 60e3, async () => {
    await pullFuel(first ? Date.now() - DAY - HOUR : Date.now() - 20 * 60e3);
    first = false;
    state.updated = Date.now();
  });
  every('freq', 30e3, pullFreq);
  every('solar', 10 * 60e3, pullSolar);
  every('wind', 30 * 60e3, pullEmbeddedWind);
  every('carbon', 10 * 60e3, pullCarbon);
  every('price', 10 * 60e3, pullPrice);
  log('grid collectors started');
}
