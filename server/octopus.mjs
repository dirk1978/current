// Octopus Energy: live power from the Home Mini (GraphQL smartMeterTelemetry), half-hourly electricity
// and gas, tariff rates and Intelligent Octopus Go smart-charge slots.
// Works for any tariff: every half hour is priced at the rate that applied then, from the public products API
// for each agreement in the account's history. Tariffs that don't publish rates (some loyalty fixes) fall back
// to the account's current rates, with the Go / Intelligent Go off-peak window applied. Without a Home Mini
// there is no live power and the half-hourly data comes from the meter readings, about a day behind.
// Telemetry units are Wh (both fuels); it only reaches back 30 days, so older history comes from the
// REST consumption API (electricity kWh, gas m³ on SMETS2 meters).
import fs from 'node:fs';
import path from 'node:path';
import { getJson, every, log, openDb, ROOT, HOUR, DAY, london } from './lib.mjs';
import { bucketKey } from './gridhistory.mjs';

const GQL = 'https://api.octopus.energy/v1/graphql/';
const REST = 'https://api.octopus.energy/v1';
const HALF = 30 * 60e3;
const GAS_KWH_PER_M3 = 1.02264 * 39.5 / 3.6; // volume correction × typical calorific value

const iso = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';

export function createOctopus(env) {
  const key = env.OCTOPUS_API_KEY;
  let account = env.OCTOPUS_ACCOUNT; // optional: found from the key if not given
  if (!key) return null;
  const db = openDb();
  const s = {
    token: null, tokenAt: 0, info: null, dispatches: { planned: [], completed: [] },
    agreements: { elec: [], gas: [] }, rates: { elec: [], gas: [] }, standing: { elec: [], gas: [] }, meters: { elec: [], gas: [] },
    lastViewed: 0, live: null, error: null,
  };

  // Octopus rate-limits GraphQL (and token requests especially), so the token is kept on disk across
  // restarts and every call stops for 10 minutes after a "Too many requests".
  const TOKEN_FILE = path.join(ROOT, 'data', 'octopus-token.json');
  try { Object.assign(s, JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))); } catch { /* none yet */ }
  let pausedUntil = 0;
  async function gql(query, variables = {}) {
    if (Date.now() < pausedUntil) throw new Error('Octopus: pausing after rate limit');
    try {
      if (!s.token || Date.now() - s.tokenAt > 50 * 60e3) {
        const r = await getJson(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'mutation($k:String!){obtainKrakenToken(input:{APIKey:$k}){token}}', variables: { k: key } }) });
        if (r.errors) throw new Error('Octopus: ' + r.errors.map((e) => e.message).join('; '));
        s.token = r.data.obtainKrakenToken.token;
        s.tokenAt = Date.now();
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: s.token, tokenAt: s.tokenAt }), { mode: 0o600 });
      }
      const r = await getJson(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: s.token },
        body: JSON.stringify({ query, variables }) });
      if (r.errors) throw new Error('Octopus: ' + r.errors.map((e) => e.message).join('; '));
      return r.data;
    } catch (e) {
      if (/too many requests|429/i.test(e.message)) pausedUntil = Date.now() + 10 * 60e3;
      if (/signature|expired|JWT|authenticat/i.test(e.message)) s.token = null;
      throw e;
    }
  }
  const rest = (path, auth = true) => getJson(path.startsWith('http') ? path : REST + path,
    auth ? { headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') } } : {});
  async function restAll(path, auth) {
    const out = [];
    for (let url = path; url;) { const d = await rest(url, auth); out.push(...d.results); url = d.next; }
    return out;
  }

  async function loadAccount() {
    if (!account) {
      account = (await gql('{viewer{accounts{number}}}')).viewer.accounts[0]?.number;
      if (!account) throw new Error('Octopus: this API key has no accounts');
    }
    // Agreement history and every meter ever fitted come from REST; device ids and current rates from GraphQL.
    const acct = await rest(`/accounts/${account}/`);
    const prop = acct.properties.find((p) => !p.moved_out_at) || acct.properties[0];
    const emp = prop.electricity_meter_points.find((m) => !m.is_export);
    const gmp = prop.gas_meter_points[0];
    const ag = (mp) => (mp?.agreements || []).map((x) => ({ from: Date.parse(x.valid_from), to: x.valid_to ? Date.parse(x.valid_to) : Infinity, code: x.tariff_code }))
      .filter((x) => x.to > x.from).sort((x, y) => x.from - y.from);
    s.agreements = { elec: ag(emp), gas: ag(gmp) };
    s.meters = { elec: emp.meters.map((m) => m.serial_number), gas: gmp ? gmp.meters.map((m) => m.serial_number) : [] };
    const d = await gql(`query($a:String!){account(accountNumber:$a){
      electricityAgreements(active:true){tariff{__typename
        ... on HalfHourlyTariff{displayName productCode unitRates{value} standingCharge}
        ... on StandardTariff{displayName productCode unitRate standingCharge}
        ... on DayNightTariff{displayName productCode dayRate nightRate standingCharge}
        ... on ThreeRateTariff{displayName productCode dayRate nightRate offPeakRate standingCharge}
        ... on PrepayTariff{displayName productCode unitRate standingCharge}}
        meterPoint{mpan meters(includeInactive:false){serialNumber smartDevices{deviceId type}}}}
      gasAgreements(active:true){tariff{... on GasTariffType{displayName productCode unitRate standingCharge}}
        meterPoint{mprn meters(includeInactive:false){serialNumber smartDevices{deviceId type}}}}}}`, { a: account });
    const a = d.account;
    const e = a.electricityAgreements.find((x) => x.meterPoint.mpan === emp.mpan) || a.electricityAgreements[0];
    const g = a.gasAgreements[0];
    const t = e.tariff;
    const rates = (t.unitRates ? t.unitRates.map((r) => r.value) : [t.unitRate, t.dayRate, t.nightRate, t.offPeakRate]).filter((x) => x != null);
    const meter = (mp) => mp.meters.find((m) => m.smartDevices.length) || mp.meters[0];
    const em = meter(e.meterPoint), gm = g && meter(g.meterPoint);
    const code = t.productCode || '';
    s.info = {
      intelligent: /^IOG|INTELLI/.test(code),
      // off-peak window for two-rate EV tariffs, used when the products API has no timed rates
      window: /^IOG|INTELLI/.test(code) ? [23 * 60 + 30, 5 * 60 + 30] : /^GO/.test(code) ? [30, 5 * 60 + 30] : null,
      elec: { tariff: t.displayName, peak: Math.max(...rates), offPeak: Math.min(...rates), standing: t.standingCharge,
        mpan: emp.mpan, serial: em?.serialNumber, device: em?.smartDevices.find((x) => x.type === 'ESME')?.deviceId || em?.smartDevices[0]?.deviceId },
      gas: g ? { tariff: g.tariff.displayName, rate: g.tariff.unitRate, standing: g.tariff.standingCharge,
        mprn: gmp.mprn, serial: gm?.serialNumber, device: gm?.smartDevices[0]?.deviceId } : null,
    };
    log('octopus:', s.info.elec.tariff, '/', s.info.gas?.tariff || 'no gas', s.info.elec.device ? '' : '(no Home Mini)');
  }

  // Unit rates and standing charges for every agreement since `since`, from the public products API.
  const productOf = (code) => code.replace(/^[EG]-[0-9A-Z]+R-/, '').replace(/-[A-P]$/, '');
  async function loadRates(since) {
    for (const fuel of ['elec', 'gas']) {
      const list = [], standing = [];
      for (const x of s.agreements[fuel]) {
        if (x.to < since) continue;
        const from = Math.max(x.from, since), to = Math.min(x.to, Date.now() + 2 * DAY);
        const base = `${REST}/products/${productOf(x.code)}/${fuel === 'elec' ? 'electricity' : 'gas'}-tariffs/${x.code}`;
        const q = `?period_from=${iso(from)}&period_to=${iso(to)}&page_size=1500`;
        const [ur, sc] = await Promise.all([restAll(`${base}/standard-unit-rates/${q}`, false).catch(() => []),
          restAll(`${base}/standing-charges/${q}`, false).catch(() => [])]);
        const span = (r) => ({ from: Math.max(from, Date.parse(r.valid_from)), to: Math.min(to, r.valid_to ? Date.parse(r.valid_to) : Infinity), p: r.value_inc_vat });
        list.push(...ur.map(span));
        standing.push(...sc.map(span));
      }
      s.rates[fuel] = list.sort((x, y) => x.from - y.from);
      s.standing[fuel] = standing.sort((x, y) => x.from - y.from);
    }
  }
  function lookup(list, t) {
    let lo = 0, hi = list.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (t < list[m].from) hi = m - 1; else if (t >= list[m].to) lo = m + 1; else return list[m].p;
    }
    return null;
  }

  const putLive = db.prepare('INSERT OR REPLACE INTO live_power (t, w) VALUES (?, ?)');
  const putUsage = db.prepare('INSERT OR REPLACE INTO usage (fuel, t, kwh) VALUES (?, ?, ?)');

  async function telemetry(device, grouping, from, to) {
    const d = await gql(`query($d:String!,$g:TelemetryGrouping,$s:DateTime,$e:DateTime){
      smartMeterTelemetry(deviceId:$d,grouping:$g,start:$s,end:$e){readAt consumption consumptionDelta demand}}`,
    { d: device, g: grouping, s: iso(from), e: iso(to) });
    return (d.smartMeterTelemetry || []).map((r) => ({ t: Date.parse(r.readAt), delta: Number(r.consumptionDelta), demand: r.demand == null ? null : Number(r.demand), reg: Number(r.consumption) }));
  }

  async function pullLive(backfill) {
    const dev = s.info.elec.device;
    if (!dev) return; // no Home Mini
    const newest = db.prepare('SELECT max(t) t FROM live_power').get().t || 0;
    if (backfill && Date.now() - newest > 10 * 60e3) {
      const rows = await telemetry(dev, 'ONE_MINUTE', Math.max(newest, Date.now() - DAY), Date.now());
      for (const r of rows) if (r.demand != null) putLive.run(r.t, r.demand);
    }
    const rows = await telemetry(dev, 'TEN_SECONDS', Date.now() - 3 * 60e3, Date.now());
    for (const r of rows) if (r.demand != null) putLive.run(r.t, r.demand);
    const last = rows.filter((r) => r.demand != null).pop();
    if (last) s.live = { t: last.t, w: last.demand };
    db.prepare('DELETE FROM live_power WHERE t < ?').run(Date.now() - 8 * DAY);
  }

  // Half-hourly energy for both fuels from telemetry (the last `days`, at most 30).
  async function pullHalfHours(days) {
    for (const [fuel, dev] of [['elec', s.info.elec.device], ['gas', s.info.gas?.device]]) {
      if (!dev) continue;
      // the API refuses ranges much over 3 days, so ask 2 days at a time
      for (let end = Date.now(), n = 0; n < days; n += 2, end -= 2 * DAY) {
        const start = Math.max(end - 2 * DAY, Date.now() - 29.5 * DAY);
        const rows = await telemetry(dev, 'HALF_HOURLY', start, end);
        for (const r of rows) if (!Number.isNaN(r.delta)) putUsage.run(fuel, r.t, r.delta / 1000);
      }
    }
  }

  // Meter readings from the REST API (about a day behind), only for half hours telemetry has not filled.
  // Every meter ever fitted is tried, since readings sit on whichever one was installed at the time.
  async function pullRestHistory(days = 400) {
    const ins = db.prepare('INSERT OR IGNORE INTO usage (fuel, t, kwh) VALUES (?, ?, ?)');
    const jobs = [['elec', 'electricity', s.info.elec.mpan, s.meters.elec]];
    if (s.info.gas) jobs.push(['gas', 'gas', s.info.gas.mprn, s.meters.gas]);
    for (const [fuel, kind, point, serials] of jobs) {
      for (const serial of serials) {
        const rows = await restAll(`/${kind}-meter-points/${point}/meters/${serial}/consumption/?page_size=25000&period_from=${iso(Date.now() - days * DAY)}`).catch(() => []);
        // SMETS2 gas meters report m³ (most smart meters); SMETS1 report kWh: set OCTOPUS_GAS_UNITS=kWh for those
        const k = fuel === 'gas' && !/^kwh$/i.test(env.OCTOPUS_GAS_UNITS || '') ? GAS_KWH_PER_M3 : 1;
        for (const r of rows) ins.run(fuel, Date.parse(r.interval_start), r.consumption * k);
      }
    }
  }

  async function pullDispatches() {
    if (!s.info.intelligent) return;
    const d = await gql(`query($a:String!){plannedDispatches(accountNumber:$a){start end delta meta{source}}
      completedDispatches(accountNumber:$a){start end delta}}`, { a: account });
    const map = (x) => ({ start: Date.parse(x.start), end: Date.parse(x.end), kwh: -Number(x.delta), source: x.meta?.source });
    s.dispatches = { planned: d.plannedDispatches.map(map), completed: d.completedDispatches.map(map) };
    // Octopus only reports the last few days of slots, so keep them all for pricing history correctly later
    const keep = db.prepare('INSERT OR IGNORE INTO dispatch (start, end, kwh) VALUES (?, ?, ?)');
    for (const x of s.dispatches.completed) keep.run(x.start, x.end, x.kwh);
    pastSlots = null;
  }

  // Intelligent Octopus Go also charges the cheap rate in any smart-charge slot outside the night window.
  // Slots come from Octopus (recent ones, and every one seen since), plus a hint from elsewhere for older
  // history (the server passes "Ohme charged this hour at the cheap rate").
  db.exec('CREATE TABLE IF NOT EXISTS dispatch (start INTEGER PRIMARY KEY, end INTEGER, kwh REAL)');
  let pastSlots = null;
  let cheapHint = null;
  const inDispatch = (t) => {
    if ([...s.dispatches.completed, ...s.dispatches.planned].some((d) => t >= d.start && t < d.end)) return true;
    pastSlots ??= db.prepare('SELECT start, end FROM dispatch').all();
    if (pastSlots.some((d) => t >= d.start && t < d.end)) return true;
    return !!cheapHint?.(t, s.info.elec.offPeak);
  };
  function inWindow(t) {
    const w = s.info.window;
    if (!w) return false;
    const { h, mi } = london(t);
    const m = h * 60 + mi;
    return w[0] > w[1] ? (m >= w[0] || m < w[1]) : (m >= w[0] && m < w[1]);
  }
  function elecRate(t) {
    if (s.info.intelligent && inDispatch(t)) return s.info.elec.offPeak;
    const r = lookup(s.rates.elec, t);
    if (r != null) return r;
    return inWindow(t) ? s.info.elec.offPeak : s.info.elec.peak;
  }
  // "Off-peak" = at (or very near) the tariff's cheapest rate, on tariffs with a real cheap period
  function isOffPeak(t) {
    if (s.info.intelligent && inDispatch(t)) return true;
    if (s.info.window) return inWindow(t);
    return s.info.elec.peak - s.info.elec.offPeak > 5 && elecRate(t) <= s.info.elec.offPeak + 0.01;
  }
  const gasRate = (t) => lookup(s.rates.gas, t) ?? s.info.gas?.rate ?? 0;
  const standingAt = (fuel, t) => lookup(s.standing[fuel], t) ?? (fuel === 'elec' ? s.info.elec.standing : s.info.gas?.standing || 0);

  function daySummary(dayStart, dayEnd) {
    const rows = db.prepare('SELECT fuel, t, kwh FROM usage WHERE t >= ? AND t < ? ORDER BY t').all(dayStart, dayEnd);
    const out = { elec: { kwh: 0, pence: 0, halfHours: 0 }, gas: { kwh: 0, pence: 0, halfHours: 0 } };
    for (const r of rows) {
      const o = out[r.fuel];
      o.kwh += r.kwh;
      o.halfHours++;
      o.pence += r.kwh * (r.fuel === 'elec' ? elecRate(r.t) : gasRate(r.t));
    }
    const frac = Math.min(1, (Math.min(Date.now(), dayEnd) - dayStart) / DAY);
    out.elec.pence += standingAt('elec', dayStart) * frac;
    if (s.info.gas) out.gas.pence += standingAt('gas', dayStart) * frac;
    return out;
  }

  const londonMidnight = (t) => london(t).midnight;


  return {
    get ready() { return !!s.info; },
    // for the car: the unit rate and whether it's the cheap rate at a moment, and electricity use per half hour
    rateAt: (t) => (s.info ? elecRate(t) : null),
    offPeakAt: (t) => (s.info ? isOffPeak(t) : false),
    cheapRate: () => (s.info ? s.info.elec.offPeak : null),
    setCheapHint(fn) { cheapHint = fn; },
    elecHalfHours: (from, to) => db.prepare("SELECT t, kwh FROM usage WHERE fuel = 'elec' AND t >= ? AND t < ? ORDER BY t").all(from, to),
    touch() { s.lastViewed = Date.now(); },
    start() {
      every('octopus', 60e3, async () => {
        try {
          if (!s.info) {
            await loadAccount();
            await pullDispatches();
            await loadRates(Date.now() - 400 * DAY).catch((e) => log('octopus rates:', e.message));
            await pullLive(true);
            // Only go back as far as the stored data needs
            const newest = db.prepare("SELECT max(t) t FROM usage WHERE fuel = 'elec'").get().t || 0;
            const days = Math.min(30, Math.ceil((Date.now() - newest) / DAY) + 1);
            await pullHalfHours(days).catch((e) => log('octopus half-hours:', e.message));
            if (!newest) await pullRestHistory().catch((e) => log('octopus rest:', e.message));
          }
          s.error = null;
        } catch (e) { s.error = e.message; throw e; }
      });
      // Live power: every 30 s while someone is looking, otherwise every 2 minutes.
      // (The Home Mini reads every 10 s; each call returns the last 3 minutes, so nothing is lost.)
      let n = 0;
      every('octopus live', 30e3, async () => {
        if (!s.info) return;
        if (Date.now() - s.lastViewed > 3 * 60e3 && n++ % 4) return;
        await pullLive(false);
      });
      every('octopus usage', 15 * 60e3, async () => { if (s.info) { await pullHalfHours(2); await pullDispatches(); } });
      every('octopus account', 6 * HOUR, async () => {
        if (!s.info) return;
        await loadAccount();
        await loadRates(Date.now() - 400 * DAY);
        // without a Home Mini the meter readings (a day behind) are the only half-hourly data
        await pullRestHistory(5);
      });
    },
    // History for the charts, each half hour priced at the rate that applied then.
    history(days, bucket) {
      if (!s.info) return { error: s.error || 'starting' };
      const from = Date.now() - days * DAY;
      const rows = db.prepare('SELECT fuel, t, kwh FROM usage WHERE t >= ? ORDER BY t').all(from);
      const key = bucketKey(bucket);
      const b = new Map();
      const slot = (t) => {
        const k = key(t);
        if (!b.has(k)) b.set(k, { t: k, elec: 0, gas: 0, elecP: 0, gasP: 0, offPeak: 0, n: 0 });
        return b.get(k);
      };
      const hhSlot = (t) => { const l = london(t); return l.h * 2 + (l.mi >= 30 ? 1 : 0); };
      const weekday = (t) => { const d = london(t).dow; return d === 0 || d === 6 ? 'weekend' : 'weekday'; };
      const profile = { weekday: { elec: Array(48).fill(0), gas: Array(48).fill(0), n: Array(48).fill(0) },
        weekend: { elec: Array(48).fill(0), gas: Array(48).fill(0), n: Array(48).fill(0) } };
      const heat = new Map(); // day -> 48 elec kWh
      const dayKey = bucketKey('day');
      let total = { elec: 0, gas: 0, elecP: 0, gasP: 0, offPeak: 0 };
      for (const r of rows) {
        const o = slot(r.t);
        const hh = hhSlot(r.t);
        if (r.fuel === 'elec') {
          const p = r.kwh * elecRate(r.t);
          o.elec += r.kwh; o.elecP += p; total.elec += r.kwh; total.elecP += p;
          if (isOffPeak(r.t)) { o.offPeak += r.kwh; total.offPeak += r.kwh; }
        } else {
          const p = r.kwh * gasRate(r.t);
          o.gas += r.kwh; o.gasP += p; total.gas += r.kwh; total.gasP += p;
        }
        if (r.t >= Date.now() - 60 * DAY) {
          const pr = profile[weekday(r.t)];
          pr[r.fuel][hh] += r.kwh;
          if (r.fuel === 'elec') pr.n[hh]++;
        }
      }
      // The heatmap always covers the last 120 days, whatever the range
      for (const r of db.prepare("SELECT t, kwh FROM usage WHERE fuel = 'elec' AND t >= ? ORDER BY t").all(dayKey(Date.now() - 119 * DAY))) {
        const d = dayKey(r.t);
        if (!heat.has(d)) heat.set(d, Array(48).fill(null));
        heat.get(d)[hhSlot(r.t)] = +r.kwh.toFixed(3);
      }
      const daysSeen = new Set(rows.map((r) => dayKey(r.t)));
      const nDays = daysSeen.size || 1;
      let standing = 0;
      for (const d of daysSeen) standing += standingAt('elec', d) + (s.info.gas ? standingAt('gas', d) : 0);
      for (const pr of Object.values(profile)) {
        pr.elec = pr.elec.map((v, i) => +(v / (pr.n[i] || 1)).toFixed(3));
        pr.gas = pr.gas.map((v, i) => +(v / (pr.n[i] || 1)).toFixed(3));
        delete pr.n;
      }
      const r2 = (x) => Math.round(x * 100) / 100;
      return {
        buckets: [...b.values()].map((o) => ({ t: o.t, elec: r2(o.elec), gas: r2(o.gas), elecP: Math.round(o.elecP), gasP: Math.round(o.gasP), offPeak: r2(o.offPeak) })),
        heatmap: [...heat.entries()].slice(-120).map(([t, v]) => ({ t, v })),
        profile,
        totals: { elec: r2(total.elec), gas: r2(total.gas), elecP: Math.round(total.elecP), gasP: Math.round(total.gasP), standingP: Math.round(standing),
          offPeakPct: total.elec ? total.offPeak / total.elec * 100 : 0, days: nDays },
        rates: { peak: s.info.elec.peak, offPeak: s.info.elec.offPeak, gas: s.info.gas?.rate },
      };
    },
    snapshot() {
      if (!s.info) return { error: s.error || 'starting' };
      const now = Date.now();
      const today = londonMidnight(now);
      const live = db.prepare('SELECT t, w FROM live_power WHERE t >= ? ORDER BY t').all(now - DAY);
      // Downsample the 24 h of live power to 2-minute averages for the chart.
      const buckets = new Map();
      for (const r of live) {
        const b = Math.floor(r.t / 120e3) * 120e3;
        const x = buckets.get(b) || [0, 0];
        x[0] += r.w; x[1]++;
        buckets.set(b, x);
      }
      const recent = live.filter((r) => r.t >= now - 15 * 60e3).map((r) => [r.t, r.w]);
      const days = [];
      for (let i = 0; i < 30; i++) {
        // midday of each day back, snapped to its London midnight (DST-safe)
        const start = londonMidnight(today - i * DAY + 12 * HOUR);
        const end = londonMidnight(start + DAY + 12 * HOUR);
        const d = daySummary(start, end);
        days.push({ t: start, elec: +d.elec.kwh.toFixed(2), gas: +d.gas.kwh.toFixed(2), elecP: Math.round(d.elec.pence), gasP: Math.round(d.gas.pence), complete: d.elec.halfHours >= 44 });
      }
      const halfHours = db.prepare('SELECT fuel, t, kwh FROM usage WHERE t >= ? ORDER BY t').all(now - 2 * DAY);
      return {
        tariff: { ...s.info, offPeakNow: isOffPeak(now), rateNow: elecRate(now) },
        // after a restart (or while Octopus is rate-limiting) show the newest stored reading with its time
        live: s.live || (live.length ? { t: live[live.length - 1].t, w: live[live.length - 1].w } : null), recent,
        power24h: [...buckets.entries()].map(([t, [sum, n]]) => [t, Math.round(sum / n)]),
        today: days[0],
        days: days.reverse(),
        halfHours: { elec: halfHours.filter((r) => r.fuel === 'elec').map((r) => [r.t, +r.kwh.toFixed(3)]),
          gas: halfHours.filter((r) => r.fuel === 'gas').map((r) => [r.t, +r.kwh.toFixed(3)]) },
        dispatches: s.dispatches,
      };
    },
  };
}
