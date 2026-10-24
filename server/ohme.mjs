// Ohme EV charger. Ohme has no public API; this uses the one their own app uses, as worked out by the
// open-source ohmepy library behind the Home Assistant integration.
// Reads: the current session (with its power graph, cost and carbon), the charge schedule, and an hourly history
// of energy charged (kept in car_hour, back a year), from which charging sessions are rebuilt.
// Writes (only when asked through /api/control): pause, resume, approve, max charge, target % and time.
import { getJson, every, log, openDb, DAY, HOUR } from './lib.mjs';

const GOOGLE_KEY = 'AIzaSyC8ZeZngm33tpOXLpbXeKfwtyZ1WrkbdBY'; // Ohme app's public Firebase key
const API = 'https://api.ohme.io';

export function createOhme(env) {
  if (!env.OHME_EMAIL || !env.OHME_PASSWORD) return null;
  const db = openDb();
  db.exec('CREATE TABLE IF NOT EXISTS car_hour (t INTEGER PRIMARY KEY, wh REAL, pence REAL, co2g REAL)');
  const s = { token: null, refresh: null, tokenAt: 0, device: null, car: null, session: null, next: null, error: null, updated: 0 };

  async function auth() {
    if (s.token && Date.now() - s.tokenAt < 45 * 60e3) return;
    const form = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
    if (s.refresh) {
      try {
        const r = await getJson(`https://securetoken.googleapis.com/v1/token?key=${GOOGLE_KEY}`, form({ grantType: 'refresh_token', refreshToken: s.refresh }));
        Object.assign(s, { token: r.id_token, refresh: r.refresh_token, tokenAt: Date.now() });
        return;
      } catch { /* fall through to a fresh login */ }
    }
    const r = await getJson(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${GOOGLE_KEY}`,
      form({ email: env.OHME_EMAIL, password: env.OHME_PASSWORD, returnSecureToken: true }));
    Object.assign(s, { token: r.idToken, refresh: r.refreshToken, tokenAt: Date.now() });
  }
  async function api(path, method = 'GET', body, timeout = 20000) {
    await auth();
    const r = await fetch(API + path, { method, headers: { Authorization: `Firebase ${s.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const text = await r.text();
    if (!r.ok) throw new Error(`Ohme ${r.status}: ${text.slice(0, 160)}`);
    try { return text ? JSON.parse(text) : {}; } catch { return { text }; }
  }
  const userId = () => JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString()).user_id;

  function status(x) {
    if (!x) return 'unknown';
    if (x.mode === 'PENDING_APPROVAL') return 'pending';
    if (x.mode === 'DISCONNECTED') return 'unplugged';
    if (x.mode === 'STOPPED') return 'paused';
    if (x.mode === 'FINISHED_CHARGE') return 'finished';
    if ((x.power?.watt || 0) > 0) return 'charging';
    return 'plugged';
  }

  const put = db.prepare('INSERT OR REPLACE INTO charger (t, w, soc, mode) VALUES (?, ?, ?, ?)');
  async function poll() {
    try {
      if (!s.device) {
        const acc = await api('/v1/users/me/account');
        const d = acc.chargeDevices[0];
        const c = acc.cars?.[0];
        s.device = { id: d.id, model: d.modelTypeDisplayName, firmware: d.firmwareVersionLabel,
          car: c ? [c.model?.make, c.model?.modelName].filter(Boolean).join(' ') || c.name : null };
        s.car = c && { name: c.name, make: c.model?.make, model: c.model?.modelName, variant: c.model?.modelDetailName, year: c.model?.modelYear,
          capacityWh: c.model?.usableCapacityWh || c.model?.energyCapacityWh || null, avgWhPerKm: c.model?.averageWhPerKm || null,
          maxChargeW: c.model?.powerLimits?.maxDemandW || null };
        log('ohme:', s.device.model, s.device.car || '');
      }
      let x;
      for (let i = 0; i < 3; i++) {
        x = (await api('/v1/chargeSessions'))[0];
        if (x.mode !== 'CALCULATING' && x.mode !== 'DELIVERING') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      s.session = x;
      s.next = (await api('/v1/chargeSessions/nextSessionInfo')).rule || null;
      s.updated = Date.now();
      s.error = null;
      const soc = x.car?.batterySoc?.percent ?? x.batterySoc?.percent ?? null;
      put.run(Date.now(), x.power?.watt || 0, soc, status(x));
      db.prepare('DELETE FROM charger WHERE t < ?').run(Date.now() - 400 * DAY);
    } catch (e) {
      s.error = e.message;
      throw e;
    }
  }

  // ---- hourly history: energy, cost and carbon per hour, back a year ----
  const putHour = db.prepare('INSERT OR REPLACE INTO car_hour (t, wh, pence, co2g) VALUES (?, ?, ?, ?)');
  async function pullHours(from, to) {
    // hourly summaries are slow to build on Ohme's side, so ask for 30 days at a time
    for (let start = from; start < to; start += 30 * DAY) {
      const end = Math.min(to, start + 30 * DAY);
      const r = await api(`/v1/chargeSessions/summary/users/${userId()}?endTs=${end}&granularity=HOUR&startTs=${start}`, 'GET', undefined, 90000);
      for (const h of r.stats || []) {
        putHour.run(h.startTime, h.energyChargedTotalWh || 0, Number(h.costStats?.moneyCostTotal?.amount ?? 0), h.carbonStats?.carbonReleasedGrams ?? null);
      }
    }
  }

  // Ohme's hourly history only includes a charge once its session has ended (unplugged), so the session in
  // progress is turned into hours from its own energy graph and merged in until the history catches up.
  function liveHours() {
    const x = s.session;
    const pts = x?.chargeGraph?.points;
    if (!x?.startTime || !pts?.length) return [];
    const total = pts[pts.length - 1].y, cost = (x.chargeStats?.moneyCostTotal || 0) * 100;
    const byHour = new Map();
    for (let i = 1; i < pts.length; i++) {
      const t = x.startTime + pts[i].x * 1000;
      const h = Math.floor(t / HOUR) * HOUR;
      byHour.set(h, (byHour.get(h) || 0) + Math.max(0, pts[i].y - pts[i - 1].y));
    }
    return [...byHour].map(([t, wh]) => ({ t, wh, pence: total ? (cost * wh) / total : 0, co2g: null, est: true }));
  }
  function mergedHours(from, to) {
    const rows = db.prepare('SELECT t, wh, pence, co2g FROM car_hour WHERE t >= ? AND t < ? ORDER BY t').all(from, to);
    const have = new Map(rows.map((r) => [r.t, r]));
    for (const h of liveHours()) if (h.t >= from && h.t < to && !(have.get(h.t)?.wh > 0)) have.set(h.t, h);
    return [...have.values()].sort((a, b) => a.t - b.t);
  }

  // Charging sessions: runs of hours with energy, allowing a gap of up to 3 hours (smart charging pauses)
  function sessions(from, to = Date.now()) {
    const rows = mergedHours(from, to).filter((r) => r.wh > 50);
    const out = [];
    for (const r of rows) {
      const cur = out[out.length - 1];
      if (cur && r.t - cur.lastHour <= 3 * HOUR) {
        cur.end = r.t + HOUR; cur.lastHour = r.t; cur.wh += r.wh; cur.pence += r.pence; cur.co2g += r.co2g || 0; cur.hours.push([r.t, r.wh, r.pence, !!r.est]);
      } else {
        out.push({ start: r.t, end: r.t + HOUR, lastHour: r.t, wh: r.wh, pence: r.pence, co2g: r.co2g || 0, hours: [[r.t, r.wh, r.pence, !!r.est]] });
      }
    }
    return out.map(({ lastHour, ...x }) => x);
  }

  // Ohme's own per-day summary (energy, cost, carbon, range added), cached for an hour.
  const summaries = new Map();
  async function summary(days) {
    const c = summaries.get(days);
    if (c && Date.now() - c.at < 3600e3) return c.data;
    await auth();
    const end = Date.now(), start = end - days * DAY;
    const r = await api(`/v1/chargeSessions/summary/users/${userId()}?endTs=${end}&granularity=DAY&startTs=${start}`);
    const money = (m) => (m ? Number(m.amount) : null); // pence, like the rest of the API
    const stat = (x) => ({ t: x.startTime, kwh: (x.energyChargedTotalWh || 0) / 1000, cost: money(x.costStats?.moneyCostTotal),
      saved: money(x.costStats?.moneySavedVsStandardTariff), co2SavedKg: (x.carbonStats?.carbonSavedVsGasCarGrams || 0) / 1000,
      rangeKm: x.batteryStats?.rangeAddedKm || 0, hours: (x.activeChargeMs || 0) / 3600e3 });
    const data = { days: (r.stats || []).map(stat), total: r.totalStats ? stat(r.totalStats) : null };
    summaries.set(days, { at: Date.now(), data });
    return data;
  }

  // ---- controls ----
  async function control(action, args = {}) {
    if (!s.device) throw new Error('Ohme not connected yet');
    const id = s.device.id;
    if (action === 'pause') await api(`/v1/chargeSessions/${id}/stop`, 'POST');
    else if (action === 'resume') await api(`/v1/chargeSessions/${id}/resume`, 'POST');
    else if (action === 'approve') await api(`/v1/chargeSessions/${id}/approve?approve=true`, 'PUT');
    else if (action === 'max') await api(`/v2/charge-devices/${id}/charge-sessions/active/${id}/max-charge?enabled=${args.on ? 'true' : 'false'}`, 'PUT');
    else if (action === 'target') {
      const rule = s.session?.appliedRule || s.next;
      if (!rule?.id) throw new Error('No charge schedule to change');
      const data = {};
      if (args.percent != null) data.targetPercent = Math.max(10, Math.min(100, Math.round(args.percent)));
      if (args.time) { const [h, m] = String(args.time).split(':').map(Number); data.targetTime = h * 3600 + m * 60; }
      await api(`/v2/users/me/charge-rules/${rule.id}?persist=true&recalculateSession=true`, 'PATCH', data);
    } else throw new Error('Unknown Ohme action ' + action);
    await new Promise((r) => setTimeout(r, 2000));
    await poll().catch(() => {});
    return { ok: true };
  }

  // Hours in which Ohme recorded charging at (about) the cheap rate: evidence of an Intelligent Octopus Go
  // smart-charge slot, used to price older history where Octopus no longer reports the slots.
  let cheapHours = null, cheapHoursAt = 0, cheapHoursRate = null;
  function chargedCheapAt(t, cheapRate) {
    if (cheapRate == null) return false;
    if (!cheapHours || Date.now() - cheapHoursAt > 30 * 60e3 || cheapHoursRate !== cheapRate) {
      cheapHours = new Set(db.prepare('SELECT t FROM car_hour WHERE wh > 200 AND pence > 0 AND pence * 1000.0 / wh <= ?').all(cheapRate + 1).map((r) => r.t));
      cheapHoursAt = Date.now(); cheapHoursRate = cheapRate;
    }
    return cheapHours.has(Math.floor(t / HOUR) * HOUR);
  }

  return {
    control,
    sessions,
    chargedCheapAt,
    // energy charged per hour (Wh), for splitting the house's use from the car's
    hours(from, to) { return mergedHours(from, to).map(({ t, wh }) => ({ t, wh })); },
    async history(days) {
      if (!s.device) return { error: s.error || 'starting' };
      try { return await summary(days); } catch (e) { log('ohme summary:', e.message); return { error: e.message }; }
    },
    start() {
      // Every 30 s while charging or plugged in, every 2 min while unplugged.
      let n = 0;
      every('ohme', 30e3, async () => {
        const idle = s.session && status(s.session) === 'unplugged';
        if (idle && n++ % 4) return;
        await poll();
      });
      // Hourly history: a year on first run, then the last few days every 30 minutes.
      every('ohme hours', 30 * 60e3, async () => {
        if (!s.device) await new Promise((r) => setTimeout(r, 15000)); // let the first poll find the charger
        if (!s.device) return;
        // fill any 30-day window of the last 400 days that's missing hours (all of it on first run), then
        // always redo the last 3 days (Ohme finalises recent hours late)
        const count = db.prepare('SELECT count(*) n FROM car_hour WHERE t >= ? AND t < ?');
        for (let end = Date.now() - 3 * DAY; end > Date.now() - 400 * DAY; end -= 30 * DAY) {
          if (count.get(end - 30 * DAY, end).n < 30 * 24 * 0.95) await pullHours(end - 30 * DAY, end);
        }
        await pullHours(Date.now() - 3 * DAY, Date.now());
      });
    },
    snapshot() {
      const x = s.session;
      if (!x) return { error: s.error || 'starting' };
      const st = status(x);
      const live = st !== 'unplugged' && st !== 'pending';
      const rule = live ? x.appliedRule : s.next;
      const cs = x.chargeStats || {};
      const startT = x.startTime || null;
      const timeOf = (sec) => (sec == null ? null : `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`);
      return {
        updated: s.updated,
        online: !!x.chargerStatus?.online,
        status: st,
        mode: x.mode,
        watts: x.power?.watt || 0,
        amps: x.power?.amp || 0,
        volts: x.power?.volt || null,
        soc: x.batterySoc?.percent ?? x.car?.batterySoc?.percent ?? null,
        socSource: x.batterySoc?.source || null, // API (from the car) or EXTRAPOLATION (Ohme's estimate)
        rangeKm: x.batterySoc?.rangeKm ?? null,
        // This session (what this charge has added)
        session: live || st === 'finished' ? {
          start: startT, socBefore: x.batterySocBefore?.percent ?? null,
          kwh: (cs.energyChargedTotalWh || 0) / 1000, pence: cs.moneyCostTotal != null ? cs.moneyCostTotal * 100 : null,
          co2g: cs.carbonReleasedGrams ?? null, gPerKwh: cs.averageCarbonReleasedPerKwh ?? null, rangeAddedKm: cs.rangeAddedKm ?? null,
          savedVsStandardPence: cs.moneyCostTotalSavingsVsRegularCable != null ? cs.moneyCostTotalSavingsVsRegularCable * 100 : null,
          co2SavedVsPetrolG: cs.carbonSavedVsGasCarGrams ?? null, chargingMs: cs.activeChargeMs ?? null,
          // cumulative energy through the session: [time, Wh]
          graph: startT ? (x.chargeGraph?.points || []).map((p) => [startT + p.x * 1000, p.y]) : [],
        } : null,
        // Back-compat for the widget
        sessionKwh: live ? (cs.energyChargedTotalWh || 0) / 1000 : 0,
        target: rule ? { percent: rule.targetPercent, time: rule.targetTime } : null,
        schedule: rule ? { name: rule.name, percent: rule.targetPercent, time: timeOf(rule.targetTime), days: rule.repeatDow || [],
          maxCharge: !!rule.isMaxCharge || x.mode === 'MAX_CHARGE', preconditioning: rule.preconditioningEnabled ? rule.preconditionLengthMins : 0 } : null,
        readyBy: x.targetTime || null,
        slots: (x.allSessionSlots || []).map((sl) => ({ start: sl.startTimeMs, end: sl.endTimeMs, w: sl.watts })),
        device: s.device,
        car: s.car,
        history: db.prepare('SELECT t, w FROM charger WHERE t >= ? ORDER BY t').all(Date.now() - DAY).map((r) => [r.t, r.w]),
      };
    },
  };
}
