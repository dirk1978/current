// Weather across Britain from Open-Meteo (free, no key), hourly, to set beside the generation mix:
//   wind at turbine height (100 m) averaged over the main wind-farm areas,
//   sunshine (shortwave radiation) and cloud averaged over where most solar panels are,
//   temperature averaged over the same (mostly English) places, since it drives heating demand.
// A year of history from the archive API (which lags ~5 days); the forecast API covers the last week + 2 days ahead.
import { getJson, every, log, openDb, HOUR, DAY } from './lib.mjs';
import { bucketKey } from './gridhistory.mjs';

const WIND_POINTS = [
  [54.75, 1.9], [53.9, 1.8], [52.3, 2.3], // Dogger Bank, Hornsea, East Anglia offshore
  [58.2, -3.0], [56.3, -2.2], [54.05, -3.6], // Moray Firth, Firth of Forth, Walney (Irish Sea)
  [55.8, -3.9], [57.4, -4.6], // central Scotland and Highland onshore
];
const SUN_POINTS = [
  [50.4, -4.9], [51.1, -2.9], [51.3, -1.9], [51.7, -1.3], // Cornwall, Somerset, Wiltshire, Oxfordshire
  [51.2, 0.8], [52.3, 0.1], [53.1, -0.3], [52.5, -2.1], // Kent, Cambridgeshire, Lincolnshire, West Midlands
];
const VARS = 'wind_speed_100m,shortwave_radiation,temperature_2m,cloud_cover';

function table() {
  const db = openDb();
  db.exec('CREATE TABLE IF NOT EXISTS weather (t INTEGER PRIMARY KEY, wind REAL, sun REAL, cloud REAL, temp REAL)');
  return db;
}

const mean = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

async function pull(url) {
  const pts = [...WIND_POINTS, ...SUN_POINTS];
  const q = `latitude=${pts.map((p) => p[0]).join(',')}&longitude=${pts.map((p) => p[1]).join(',')}&hourly=${VARS}&wind_speed_unit=mph&timezone=GMT`;
  const d = await getJson(`${url}${url.includes('?') ? '&' : '?'}${q}`, { timeout: 90000 });
  const times = d[0].hourly.time;
  const put = table().prepare('INSERT OR REPLACE INTO weather (t, wind, sun, cloud, temp) VALUES (?, ?, ?, ?, ?)');
  const w = d.slice(0, WIND_POINTS.length), s = d.slice(WIND_POINTS.length);
  let n = 0;
  times.forEach((tm, i) => {
    const wind = mean(w.map((x) => x.hourly.wind_speed_100m[i]));
    const sun = mean(s.map((x) => x.hourly.shortwave_radiation[i]));
    if (wind == null && sun == null) return;
    put.run(Date.parse(tm + ':00Z'), wind, sun, mean(s.map((x) => x.hourly.cloud_cover[i])), mean(s.map((x) => x.hourly.temperature_2m[i])));
    n++;
  });
  return n;
}

export function startWeather() {
  const db = table();
  every('weather', 30 * 60e3, async () => {
    await pull('https://api.open-meteo.com/v1/forecast?past_days=7&forecast_days=3');
  });
  every('weather archive', 24 * HOUR, async () => {
    const have = db.prepare('SELECT count(*) n FROM weather WHERE t < ?').get(Date.now() - 7 * DAY).n;
    if (have > 360 * 24) return;
    const ymd = (t) => new Date(t).toISOString().slice(0, 10);
    const n = await pull(`https://archive-api.open-meteo.com/v1/archive?start_date=${ymd(Date.now() - 370 * DAY)}&end_date=${ymd(Date.now() - 6 * DAY)}`);
    log('weather archive:', n, 'hours');
  });
}

// Shortwave radiation is the mean of the hour *ending* at t, so it is plotted at the middle of that hour.
export function weatherSeries(from, to, bucket = 'hour') {
  const rows = table().prepare('SELECT * FROM weather WHERE t >= ? AND t <= ? ORDER BY t').all(from - HOUR, to + HOUR);
  const key = bucket === 'hour' ? (t) => t : bucketKey(bucket);
  const groups = new Map();
  for (const r of rows) {
    const k = key(r.t);
    if (k < from - HOUR || k > to) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = { t: [], wind: [], sun: [], cloud: [], temp: [], forecastFrom: Math.floor(Date.now() / HOUR) * HOUR };
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  for (const [k, g] of groups) {
    out.t.push(bucket === 'hour' ? k : k);
    out.wind.push(r1(mean(g.map((r) => r.wind))));
    out.sun.push(r1(mean(g.map((r) => r.sun))));
    out.cloud.push(r1(mean(g.map((r) => r.cloud))));
    out.temp.push(r1(mean(g.map((r) => r.temp))));
  }
  if (bucket === 'hour') out.sunT = out.t.map((t) => t - HOUR / 2);
  return out;
}
