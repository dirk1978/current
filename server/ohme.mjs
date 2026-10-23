// Ohme EV charger. Ohme has no public API; this uses the one their own app uses, as worked out by the
// open-source ohmepy library behind the Home Assistant integration. Read-only here.
import { getJson, every, log, openDb, DAY } from './lib.mjs';

const GOOGLE_KEY = 'AIzaSyC8ZeZngm33tpOXLpbXeKfwtyZ1WrkbdBY'; // Ohme app's public Firebase key
const API = 'https://api.ohme.io';

export function createOhme(env) {
  if (!env.OHME_EMAIL || !env.OHME_PASSWORD) return null;
  const db = openDb();
  const s = { token: null, refresh: null, tokenAt: 0, device: null, session: null, next: null, error: null, updated: 0 };

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
  async function api(path) {
    await auth();
    return getJson(API + path, { headers: { Authorization: `Firebase ${s.token}`, 'Content-Type': 'application/json' } });
  }

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
        s.device = { id: d.id, model: d.modelTypeDisplayName, firmware: d.firmwareVersionLabel,
          car: acc.cars?.[0] ? [acc.cars[0].model?.make, acc.cars[0].model?.modelName].filter(Boolean).join(' ') || acc.cars[0].name : null,
          batteryKwh: acc.cars?.[0]?.model?.availableBatteryCapacity || null };
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
      db.prepare('DELETE FROM charger WHERE t < ?').run(Date.now() - 8 * DAY);
    } catch (e) {
      s.error = e.message;
      throw e;
    }
  }

  // Ohme's own per-day summary (energy, cost, carbon, range added), cached for an hour.
  const summaries = new Map();
  async function summary(days) {
    const c = summaries.get(days);
    if (c && Date.now() - c.at < 3600e3) return c.data;
    await auth();
    const uid = JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString()).user_id;
    const end = Date.now(), start = end - days * DAY;
    const r = await getJson(`${API}/v1/chargeSessions/summary/users/${uid}?endTs=${end}&granularity=DAY&startTs=${start}`,
      { headers: { Authorization: `Firebase ${s.token}` } });
    const money = (m) => (m ? Number(m.amount) : null); // pence, like the rest of the API
    const stat = (x) => ({ t: x.startTime, kwh: (x.energyChargedTotalWh || 0) / 1000, cost: money(x.costStats?.moneyCostTotal),
      saved: money(x.costStats?.moneySavedVsStandardTariff), co2SavedKg: (x.carbonStats?.carbonSavedVsGasCarGrams || 0) / 1000,
      rangeKm: x.batteryStats?.rangeAddedKm || 0, hours: (x.activeChargeMs || 0) / 3600e3 });
    const data = { days: (r.stats || []).map(stat), total: r.totalStats ? stat(r.totalStats) : null };
    summaries.set(days, { at: Date.now(), data });
    return data;
  }

  return {
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
    },
    snapshot() {
      const x = s.session;
      if (!x) return { error: s.error || 'starting' };
      const st = status(x);
      const live = st !== 'unplugged' && st !== 'pending';
      const rule = live ? x.appliedRule : s.next;
      const slots = (x.allSessionSlots || []).map((sl) => ({ start: sl.startTimeMs, end: sl.endTimeMs, w: sl.watts }));
      const hist = db.prepare('SELECT t, w FROM charger WHERE t >= ? ORDER BY t').all(Date.now() - DAY).map((r) => [r.t, r.w]);
      return {
        updated: s.updated,
        online: !!x.chargerStatus?.online,
        status: st,
        mode: x.mode,
        watts: x.power?.watt || 0,
        amps: x.power?.amp || 0,
        volts: x.power?.volt || null,
        soc: x.car?.batterySoc?.percent ?? x.batterySoc?.percent ?? null,
        sessionKwh: live && x.batterySoc?.wh ? x.batterySoc.wh / 1000 : 0,
        target: rule ? { percent: rule.targetPercent, time: rule.targetTime } : null,
        slots,
        device: s.device,
        history: hist,
      };
    },
  };
}
