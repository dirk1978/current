// Shared helpers: .env loading, JSON fetch with timeout, logging, sqlite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      // values may be wrapped in single or double quotes
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env: settings can come from the environment instead (e.g. Docker) */ }
  const ours = /^(OCTOPUS_|OHME_|ACCESS_TOKEN$|PORT$|PUBLIC_URL$|LAN_URL$)/;
  return { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k in env || ours.test(k))) };
}

export function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

export async function getJson(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 20000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${url.split('?')[0]}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Runs fn now and then every `ms`, never overlapping, logging failures.
export function every(name, ms, fn) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { log(`${name}:`, e.message); }
    busy = false;
  };
  run();
  return setInterval(run, ms);
}

let db;
export function openDb() {
  if (db) return db;
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  db = new DatabaseSync(path.join(ROOT, 'data', 'current.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS live_power (t INTEGER PRIMARY KEY, w REAL);          -- Home Mini, 10 s
    CREATE TABLE IF NOT EXISTS usage (fuel TEXT, t INTEGER, kwh REAL, PRIMARY KEY (fuel, t)); -- half-hourly meter data
    CREATE TABLE IF NOT EXISTS charger (t INTEGER PRIMARY KEY, w REAL, soc REAL, mode TEXT);
    CREATE TABLE IF NOT EXISTS embedded_wind (t INTEGER PRIMARY KEY, mw REAL);       -- NESO forecast, last seen
  `);
  return db;
}

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

// UK local time parts for an instant. Intl is slow, so the UTC offset is cached per hour.
const offsetCache = new Map();
const ukFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: '2-digit' });
function offsetAt(t) {
  const hourKey = Math.floor(t / HOUR);
  let off = offsetCache.get(hourKey);
  if (off == null) {
    const utcH = new Date(hourKey * HOUR).getUTCHours();
    off = ((Number(ukFmt.format(new Date(hourKey * HOUR))) - utcH + 24) % 24) * HOUR; // 0 or 1 h
    offsetCache.set(hourKey, off);
  }
  return off;
}
export function london(t) {
  const off = offsetAt(t);
  const d = new Date(t + off); // read with UTC getters = UK wall clock
  let midnight = t - (d.getUTCHours() * HOUR + d.getUTCMinutes() * 60e3 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds());
  midnight += off - offsetAt(midnight); // clocks change at 01:00/02:00, so midnight may have the other offset
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay(), offset: off, midnight };
}
