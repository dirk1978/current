// The car's own data from the EU Data Act portal files (see euda.mjs), stored as time series and turned into
// trips, efficiency (miles/kWh, and against outside temperature), mileage and pence per mile.
// Files are zipped JSON: { vin, user_id, Data: [{ key, dataFieldName, value, timestampUtc? }] }. Readings in the
// 15-minute files have no timestamp of their own, so they take the delivery time from the file name.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDb, DAY, log } from './lib.mjs';

const KM_TO_MI = 0.621371;

// Fields we keep as series, with the names they appear under in the different file formats
const SERIES = {
  soc: ['currentSOCInPct', 'battery_state_report.soc', 'batteryStatus.currentSOC_pct', 'hvsoc_info.value'],
  km: ['mileage', 'mileage_info.value'],
  range: ['cruisingRangeElectricInKm', 'cruise_range_primary_info.value', 'batteryStatus.cruisingRange.range'],
  temp: ['temperatureOutsideVehicle', 'outdoortemperature_info.value'], // kelvin in the first, °C in the second
  chargeKw: ['chargePowerInKW', 'battery_state_report.charge_power', 'chargingStatus.chargePower_kW'],
};
const FIELD_TO_SERIES = Object.fromEntries(Object.entries(SERIES).flatMap(([s, names]) => names.map((n) => [n, s])));
// Never stored: anything that could be a position or an identifier
const PRIVATE = /lat|lon|position|location|address|gps|vin|user_?id|tracking|messageId|identifier/i;

function tables() {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cd_series (s TEXT, t INTEGER, v REAL, PRIMARY KEY (s, t));
    CREATE TABLE IF NOT EXISTS cd_latest (name TEXT PRIMARY KEY, value TEXT, t INTEGER);
    CREATE TABLE IF NOT EXISTS cd_files (name TEXT PRIMARY KEY, at INTEGER, readings INTEGER);
  `);
  return db;
}

// Minimal zip reader (deflate or stored), via the central directory
export function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(data) : data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// "20261024141824_<vin>.zip" -> the delivery time (UTC)
function fileTime(name) {
  const m = name.match(/(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.now();
}

// Stores the readings of one parsed file; returns how many were kept
export function ingest(json, name) {
  const db = tables();
  const putS = db.prepare('INSERT OR REPLACE INTO cd_series (s, t, v) VALUES (?, ?, ?)');
  const putL = db.prepare('INSERT INTO cd_latest (name, value, t) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, t = excluded.t WHERE excluded.t >= cd_latest.t');
  const ft = fileTime(name);
  const units = {};
  for (const e of json.Data || []) if (/\.unit$/.test(e.dataFieldName)) units[e.dataFieldName.replace(/\.unit$/, '.value')] = String(e.value);
  let kept = 0;
  db.exec('BEGIN');
  try {
    for (const e of json.Data || []) {
      const n = e.dataFieldName;
      if (!n || PRIVATE.test(n)) continue;
      if (e.timestampUtc?.startsWith('0001')) continue; // placeholder date: not a real reading
      const t = e.timestampUtc && /^\d{4}-/.test(e.timestampUtc) ? Date.parse(e.timestampUtc) : ft;
      if (!Number.isFinite(t)) continue;
      const s = FIELD_TO_SERIES[n];
      if (s) {
        let v = Number(e.value);
        if (!Number.isFinite(v)) continue;
        if (s === 'temp' && (n === 'temperatureOutsideVehicle' || /kelvin/i.test(units[n] || '') || v > 150)) v -= 273.15;
        if ((s === 'km' || s === 'range') && /mile/i.test(units[n] || '')) v /= KM_TO_MI; // stored in km
        putS.run(s, t, v);
        kept++;
      }
      // everything else: keep its latest value (status, service due, battery temperature, doors/windows...)
      if (/^\d+-\d+-\d+$/.test(n)) continue; // numbered diagnostic codes
      putL.run(n, String(e.value).slice(0, 200), t);
    }
    db.prepare('INSERT OR REPLACE INTO cd_files (name, at, readings) VALUES (?, ?, ?)').run(name, Date.now(), kept);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return kept;
}

// Imports every not-yet-imported file in dir (skipping empty deliveries and, inside the server, very big files)
export function ingestDir(dir, { maxBytes = 20e6 } = {}) {
  const db = tables();
  const done = new Set(db.prepare('SELECT name FROM cd_files').all().map((r) => r.name));
  let n = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (!f.endsWith('.zip') || f.includes('no_content') || done.has(f)) continue;
    const full = path.join(dir, f);
    if (fs.statSync(full).size > maxBytes) { log(`cardata: ${f.slice(0, 15)}… is large; import it with tools/euda-import.mjs`); continue; }
    for (const part of unzip(fs.readFileSync(full))) if (part.name.endsWith('.json')) n += ingest(JSON.parse(part.data), f);
  }
  return n;
}

// ---------- analysis ----------
const series = (s, from, to) => tables().prepare('SELECT t, v FROM cd_series WHERE s = ? AND t >= ? AND t < ? ORDER BY t').all(s, from, to).map((r) => [r.t, r.v]);
function lowerBound(a, t) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m][0] < t) lo = m + 1; else hi = m; } return lo; }

// Trips: runs of rising mileage with gaps under 30 minutes. Energy = battery % just before minus just after, so it's
// the driving energy only (standby, pre-heating while parked and charging losses are left out). Trips with a charge
// part-way (the battery rose) are left out of the efficiency figures.
export function trips(from, to, usableKwh) {
  const km = series('km', from - DAY, to), soc = series('soc', from - DAY, to + DAY), temp = series('temp', from - DAY, to + DAY);
  const out = [];
  let cur = null;
  for (let i = 1; i < km.length; i++) {
    const [t0, m0] = km[i - 1], [t1, m1] = km[i];
    if (m1 <= m0 || m1 - m0 > 1500) continue; // ignore resets and jumps
    if (cur && t0 - cur.end < 30 * 60e3) { cur.end = t1; cur.km += m1 - m0; } else { cur = { start: t0, end: t1, km: m1 - m0 }; out.push(cur); }
  }
  const res = [];
  for (const tr of out) {
    if (tr.start < from || tr.start >= to) continue;
    const i0 = lowerBound(soc, tr.start + 1) - 1, i1 = lowerBound(soc, tr.end);
    let kwh = null;
    if (i0 >= 0 && i1 < soc.length) {
      const seg = soc.slice(i0, i1 + 1).map((x) => x[1]);
      const charged = seg.some((v, k) => k && v > seg[k - 1] + 1);
      const d = seg[0] - seg[seg.length - 1];
      if (!charged && d > 0) kwh = (d / 100) * usableKwh;
    }
    const ti = lowerBound(temp, tr.start);
    const near = [temp[ti - 1], temp[ti]].filter((x) => x && Math.abs(x[0] - tr.start) < 6 * 3600e3);
    res.push({ start: tr.start, end: tr.end, miles: tr.km * KM_TO_MI, kwh, tempC: near.length ? near[0][1] : null });
  }
  return res;
}

export function carDataSummary({ usableKwh = 77, chargeCost = null } = {}) {
  const db = tables();
  if (!db.prepare('SELECT count(*) n FROM cd_series').get().n) return null;
  const now = Date.now();
  const T = trips(now - 400 * DAY, now + 1, usableKwh);
  const eff = (list) => {
    const ok = list.filter((x) => x.kwh && x.miles >= 2);
    const mi = ok.reduce((a, x) => a + x.miles, 0), kwh = ok.reduce((a, x) => a + x.kwh, 0);
    return kwh ? +(mi / kwh).toFixed(2) : null;
  };
  // monthly: miles, driving efficiency, average temperature
  const months = new Map();
  for (const x of T) {
    const d = new Date(x.start); const k = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(x);
  }
  const monthly = [...months].sort((a, b) => a[0] - b[0]).map(([t, xs]) => {
    const tt = xs.filter((x) => x.tempC != null);
    return { t, miles: Math.round(xs.reduce((a, x) => a + x.miles, 0)), miPerKwh: eff(xs), trips: xs.length,
      tempC: tt.length ? +(tt.reduce((a, x) => a + x.tempC, 0) / tt.length).toFixed(1) : null };
  });
  // efficiency against outside temperature, in 3 °C bands
  const bands = new Map();
  for (const x of T) {
    if (x.tempC == null || !x.kwh || x.miles < 2) continue;
    const b = Math.floor(x.tempC / 3) * 3;
    const r = bands.get(b) || { mi: 0, kwh: 0, n: 0 };
    r.mi += x.miles; r.kwh += x.kwh; r.n++;
    bands.set(b, r);
  }
  const byTemp = [...bands].sort((a, b) => a[0] - b[0]).filter(([, r]) => r.n >= 5).map(([b, r]) => ({ fromC: b, toC: b + 3, miPerKwh: +(r.mi / r.kwh).toFixed(2), trips: r.n }));
  const last30 = T.filter((x) => x.start >= now - 30 * DAY);
  const miles30 = last30.reduce((a, x) => a + x.miles, 0);
  const latest = Object.fromEntries(db.prepare('SELECT name, value, t FROM cd_latest').all().map((r) => [r.name, { v: r.value, t: r.t }]));
  const km = db.prepare("SELECT t, v FROM cd_series WHERE s = 'km' ORDER BY t DESC LIMIT 1").get();
  const soc = db.prepare("SELECT t, v FROM cd_series WHERE s = 'soc' ORDER BY t DESC LIMIT 1").get();
  const range = db.prepare("SELECT t, v FROM cd_series WHERE s = 'range' ORDER BY t DESC LIMIT 1").get();
  const lastFile = db.prepare('SELECT max(at) at FROM cd_files').get().at;
  return {
    updated: lastFile,
    odometerMiles: km ? Math.round(km.v * KM_TO_MI) : null, odometerAt: km?.t ?? null,
    soc: soc ? { v: soc.v, t: soc.t } : null, rangeMiles: range ? Math.round(range.v * KM_TO_MI) : null,
    // days until the service (negative: overdue); the newer field first
    serviceDueDays: [latest['service_maintenance_info.due_in_time.value'], latest.inspectionDueDays].filter(Boolean).sort((a, b) => b.t - a.t).map((x) => Number(x.v))[0] ?? null,
    batteryTempC: latest['hvbatterytemperature_info.max_temperature.value'] ? Number(latest['hvbatterytemperature_info.max_temperature.value'].v) : null,
    efficiency: { year: eff(T), last30: eff(last30) }, usableKwh,
    miles30: Math.round(miles30), trips30: last30.length,
    penceMile30: chargeCost && miles30 > 50 ? +(chargeCost / miles30).toFixed(1) : null,
    monthly, byTemp,
    recentTrips: T.slice(-12).reverse().map((x) => ({ ...x, miles: +x.miles.toFixed(1), kwh: x.kwh && +x.kwh.toFixed(1) })),
  };
}
