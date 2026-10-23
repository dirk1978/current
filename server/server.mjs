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

const WEB = path.join(ROOT, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

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
    'Access-Control-Allow-Headers': 'Authorization',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });

  if (url.pathname.startsWith('/api/')) {
    if (!authorised(req, url)) return send(res, 401, { error: 'key' });
    if (url.pathname === '/api/all') {
      octopus?.touch();
      return send(res, 200, {
        serverTime: Date.now(),
        grid: gridSnapshot(),
        weather: weatherSeries(Date.now() - 24 * 3600e3, Date.now() + 24 * 3600e3),
        home: octopus ? octopus.snapshot() : { error: 'not configured' },
        car: ohme ? ohme.snapshot() : { error: 'not configured' },
      });
    }
    // For the Connect phone QR code: the addresses the app should use (internet first, then home network)
    if (url.pathname === '/api/connect') {
      const bases = [env.PUBLIC_URL, env.LAN_URL].filter(Boolean).map((b) => b.replace(/\/+$/, ''));
      const here = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
      return send(res, 200, { bases: bases.length ? bases : [here] });
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
        home: octopus ? octopus.history(days, bucket) : { error: 'not configured' },
        car: ohme ? await ohme.history(days) : { error: 'not configured' },
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
