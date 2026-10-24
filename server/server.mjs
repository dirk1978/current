// Current: national grid + home energy. Serves the web UI and a JSON API.
// Plain HTTP: put it behind a reverse proxy with TLS (Caddy, nginx, Nginx Proxy Manager...) for internet access.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadEnv, log, ROOT } from './lib.mjs';
import { startGrid, gridSnapshot } from './grid.mjs';
import { startGridHistory, gridHistory } from './gridhistory.mjs';
import { startWeather, weatherSeries } from './weather.mjs';
import { createOctopus } from './octopus.mjs';
import { createOhme } from './ohme.mjs';
import { carSessions, splitBuckets, carToday } from './car.mjs';
import { createEuda } from './euda.mjs';
import { ingestDir, carDataSummary } from './cardata.mjs';

const env = loadEnv();
const PORT = Number(env.PORT || 8092);
// The access key: from .env / the environment, or generated once and kept in data/ (handy with plain docker run)
const TOKEN = (() => {
  if (env.ACCESS_TOKEN) {
    if (env.ACCESS_TOKEN.length < 16) throw new Error('ACCESS_TOKEN is too short: use at least 16 random characters');
    return env.ACCESS_TOKEN;
  }
  const file = path.join(ROOT, 'data', 'access-token');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
})();

startGrid();
startGridHistory();
startWeather();
const octopus = createOctopus(env);
octopus?.start();
const ohme = createOhme(env);
ohme?.start();
// The car's own data through the EU Data Act portal (CUPRA/VW Group cars, optional, experimental)
const euda = createEuda(env);
euda?.start();
// read new car data files into the database as they arrive (big one-off files: tools/euda-import.mjs)
if (euda) setInterval(() => { try { ingestDir(euda.dir); } catch (e) { log('cardata:', e.message); } }, 5 * 60e3);
// usable battery for turning battery % into kWh: CAR_USABLE_KWH, else what Ohme knows about the car
const usableKwh = () => Number(env.CAR_USABLE_KWH) || ((ohme?.snapshot().car?.capacityWh || 0) / 1000) || 60;
// the car's own data, cached for a minute (the trip analysis reads a year of readings)
let cdCache = null, cdAt = 0;
function carData(sessions) {
  if (Date.now() - cdAt > 60e3) {
    const cost30 = (sessions || []).reduce((a, x) => a + x.pence, 0);
    try { cdCache = carDataSummary({ usableKwh: usableKwh(), chargeCost: cost30 || null }); } catch (e) { log('cardata:', e.message); cdCache = null; }
    cdAt = Date.now();
  }
  return cdCache;
}
// Intelligent Octopus Go bills smart-charge slots at the cheap rate; Ohme's history shows where they were
if (octopus && ohme) octopus.setCheapHint((t, rate) => ohme.chargedCheapAt(t, rate));

// The Home screen's numbers, with the car's share separated out when there's a charger
function homeNow() {
  if (!octopus) return { error: 'not configured' };
  const h = octopus.snapshot();
  if (!ohme || h.error) return h;
  const car = ohme.snapshot();
  if (h.live && !car.error) h.live = { ...h.live, carW: car.status === 'charging' ? car.watts : 0, houseW: Math.max(0, h.live.w - (car.status === 'charging' ? car.watts : 0)) };
  if (h.today) h.today.car = carToday(ohme, h.today.t);
  return h;
}

const carPhoto = () => ['jpg', 'jpeg', 'png', 'webp'].map((x) => path.join(ROOT, 'data', 'car-photo.' + x)).find((f) => fs.existsSync(f)) || null;
const WEB = path.join(ROOT, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

function authorised(req, url) {
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  // The only thing that changes anything: charger commands, e.g. POST /api/control {"target":"ohme","action":"pause"}
  if (req.method === 'POST' && url.pathname === '/api/control') {
    if (!authorised(req, url)) return send(res, 401, { error: 'key' });
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(res, 413, { error: 'too big' }); }
    let cmd;
    try { cmd = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
    const allowed = { ohme: ['pause', 'resume', 'approve', 'max', 'target'] };
    if (!allowed[cmd.target]?.includes(cmd.action)) return send(res, 400, { error: 'unknown command' });
    const dev = { ohme }[cmd.target];
    if (!dev) return send(res, 400, { error: `${cmd.target} is not set up` });
    log(`control: ${cmd.target} ${cmd.action} ${JSON.stringify(cmd.args || {})}`);
    try { return send(res, 200, await dev.control(cmd.action, cmd.args || {})); } catch (e) {
      log(`control failed: ${e.message}`);
      return send(res, 502, { error: e.message });
    }
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });

  if (url.pathname.startsWith('/api/')) {
    if (!authorised(req, url)) return send(res, 401, { error: 'key' });
    if (url.pathname === '/api/all') {
      octopus?.touch();
      return send(res, 200, {
        serverTime: Date.now(),
        grid: gridSnapshot(),
        weather: weatherSeries(Date.now() - 24 * 3600e3, Date.now() + 24 * 3600e3),
        home: homeNow(),
        car: ohme ? (() => {
          const sessions = carSessions(ohme, octopus, Date.now() - 30 * 86400e3);
          return { ...ohme.snapshot(), euda: euda?.status() || null, data: carData(sessions), paint: env.CAR_COLOUR || null,
            photo: carPhoto() ? fs.statSync(carPhoto()).mtimeMs : null, sessions };
        })() : { error: 'not configured' },
      });
    }
    // For the Connect phone QR code: the addresses the app should use (internet first, then home network)
    if (url.pathname === '/api/connect') {
      const bases = [env.PUBLIC_URL, env.LAN_URL].filter(Boolean).map((b) => b.replace(/\/+$/, ''));
      const here = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
      return send(res, 200, { bases: bases.length ? bases : [here] });
    }
    // The car's photo, if one has been added (data/car-photo.jpg, .png or .webp)
    if (url.pathname === '/api/car-photo') {
      const f = carPhoto();
      if (!f) return send(res, 404, { error: 'no photo' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'image/jpeg', 'Cache-Control': 'private, max-age=86400',
        'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      return res.end(fs.readFileSync(f));
    }
    if (url.pathname === '/api/history') {
      // range: day | week | month | year
      const RANGES = { day: [1, 'half'], week: [7, 'half'], month: [31, 'day'], year: [366, 'week'] };
      const [days, bucket] = RANGES[url.searchParams.get('range')] || RANGES.week;
      const gridBucket = days > 31 ? 'day' : days > 7 ? 'hour' : 'half';
      return send(res, 200, {
        range: url.searchParams.get('range') || 'week',
        grid: gridHistory(days, gridBucket),
        weather: weatherSeries(Date.now() - days * 86400e3, Date.now(), days > 31 ? 'day' : 'hour'),
        home: (() => { const h = octopus ? octopus.history(days, bucket) : { error: 'not configured' }; splitBuckets(h, ohme, days, bucket); return h; })(),
        car: ohme ? { ...(await ohme.history(days)), sessions: carSessions(ohme, octopus, Date.now() - days * 86400e3) } : { error: 'not configured' },
      });
    }
    return send(res, 404, { error: 'not found' });
  }
  if (url.pathname === '/health') return send(res, 200, { ok: true, grid: !!gridSnapshot(), home: !!octopus?.ready });

  // Static UI
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(WEB, path.normalize(p));
  if (!file.startsWith(WEB + path.sep)) return send(res, 403, 'no', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(buf);
  });
}).listen(PORT, () => {
  log(`listening on :${PORT}`);
  if (!env.ACCESS_TOKEN) log(`no ACCESS_TOKEN set; using the generated one in data/access-token. Open http://<this machine>:${PORT}/?key=${TOKEN}`);
});
