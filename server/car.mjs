// Car + house: combines the charger's hourly energy (Ohme) with the meter (Octopus) and the grid's carbon
// intensity, to rebuild charging sessions with their cheap-rate share and carbon, and to split the house's
// electricity from the car's.
import { DAY, HOUR } from './lib.mjs';
import { bucketKey, carbonByHalfHour } from './gridhistory.mjs';

const HALF = 30 * 60e3;

// Charging sessions in [from, to), newest first, with cost, carbon and the share charged at the cheap rate
export function carSessions(ohme, octopus, from, to = Date.now()) {
  const carbon = carbonByHalfHour(from - HOUR, to + HOUR);
  return ohme.sessions(from, to).map((x) => {
    let cheap = 0, co2 = 0, co2Known = 0, billed = 0;
    const cheapRate = octopus?.cheapRate?.();
    for (const [t, wh, pence, estimated] of x.hours) {
      // "cheap" by the price actually paid that hour (smart-charge slots outside the night window are cheap too),
      // falling back to the tariff's off-peak times when the price isn't known (e.g. the session in progress,
      // where only its total cost is known)
      const p = wh ? (pence / wh) * 1000 : null;
      if (!estimated && cheapRate != null && p != null && pence > 0) { if (p <= cheapRate + 1) cheap += wh; }
      else if (octopus?.offPeakAt(t + HALF)) cheap += wh;
      // carbon and the Octopus rate are per half hour: each hour is two of them
      for (const half of [t, t + HALF]) {
        const rate = octopus?.rateAt(half);
        if (rate != null) billed += (wh / 2 / 1000) * rate;
        const g = carbon.get(half);
        if (g != null) { co2 += (wh / 2 / 1000) * g; co2Known += wh / 2; }
      }
    }
    const kwh = x.wh / 1000;
    // what Octopus charges you (it knows about Intelligent Go's smart-charge slots); Ohme's own estimate otherwise
    const pence = octopus?.cheapRate?.() != null ? billed : x.pence;
    return {
      start: x.start, end: x.end, kwh: +kwh.toFixed(2), pence: Math.round(pence), ohmePence: Math.round(x.pence),
      penceKwh: kwh ? +(pence / kwh).toFixed(1) : null,
      cheapPct: x.wh ? Math.round((cheap / x.wh) * 100) : null,
      // grid carbon of the electricity used, scaled up if a few half hours have no carbon data yet
      co2Kg: co2Known ? +((co2 / 1000) * (x.wh / co2Known)).toFixed(2) : null,
      gPerKwh: co2Known ? Math.round(co2 / (co2Known / 1000)) : null,
      hours: x.hours.length,
    };
  }).reverse();
}

// Adds car and house kWh to each history bucket (house = meter reading minus what the charger delivered)
export function splitBuckets(home, ohme, days, bucket) {
  if (!home?.buckets || !ohme) return;
  const key = bucketKey(bucket);
  const car = new Map();
  for (const { t, wh } of ohme.hours(Date.now() - days * DAY - DAY, Date.now() + 1)) {
    if (!wh) continue;
    // spread each hour over its two half hours so half-hourly buckets line up
    for (const half of [t, t + HALF]) {
      const k = key(half);
      car.set(k, (car.get(k) || 0) + wh / 2000);
    }
  }
  let carTotal = 0;
  for (const b of home.buckets) {
    const c = Math.min(b.elec, car.get(b.t) || 0); // the charger can't have used more than the meter saw
    b.car = +c.toFixed(2);
    b.house = +(b.elec - c).toFixed(2);
    carTotal += c;
  }
  if (home.totals) {
    home.totals.car = +carTotal.toFixed(1);
    home.totals.house = +(home.totals.elec - carTotal).toFixed(1);
  }
}

// Today's car energy (kWh) since midnight, for the Home screen
export function carToday(ohme, midnight) {
  if (!ohme) return null;
  const wh = ohme.hours(midnight, Date.now() + 1).reduce((a, r) => a + r.wh, 0);
  return +(wh / 1000).toFixed(2);
}
