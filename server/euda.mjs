// The car's own data through VW Group's EU Data Act portal (eu-data-act.drivesomethinggreater.com): the owner sets up
// a continuous data request there, and the portal delivers it as files (every 15 minutes at best). This signs in with
// the CUPRA ID (CUPRA_EMAIL / CUPRA_PASSWORD), finds the request (the portal's "partial" data cluster), and downloads
// new files into data/euda/. Follows the portal calls in the open-source pycupra library (MIT); experimental.
import fs from 'node:fs';
import path from 'node:path';
import { every, log, ROOT } from './lib.mjs';
import { Jar, jarFetch, vwSignIn, VwIdError } from './vwid.mjs';

const BASE = 'https://eu-data-act.drivesomethinggreater.com';
const CLIENT = { id: 'f85e5b69-e3b2-43aa-9c0d-1b7d0e0b576f@apps_vw-dilab_com', scope: 'openid profile cars', redirect: `${BASE}/login` };
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

export function createEuda(env) {
  if (!env.CUPRA_EMAIL || !env.CUPRA_PASSWORD) return null;
  const DIR = path.join(ROOT, 'data', 'euda');
  const s = { jar: null, vehicles: null, vin: null, request: null, files: [], error: null, pausedUntil: 0, checked: 0, downloaded: 0 };

  async function login() {
    if (Date.now() < s.pausedUntil) throw new Error('EU Data Act sign-in paused after a failure');
    const jar = new Jar();
    const q = `client_id=${encodeURIComponent(CLIENT.id)}&response_type=code&scope=${encodeURIComponent(CLIENT.scope)}&state=de__en__CUPRA&redirect_uri=${encodeURIComponent(CLIENT.redirect)}&prompt=login`;
    const oidc = await (await fetch('https://identity.vwgroup.io/.well-known/openid-configuration')).json();
    try {
      const { location } = await vwSignIn({ jar, authUrl: `${oidc.authorization_endpoint}?${q}`, redirectPrefix: CLIENT.redirect, clientId: CLIENT.id,
        email: env.CUPRA_EMAIL, password: env.CUPRA_PASSWORD, headers: { ...BROWSER, 'Content-Type': 'application/x-www-form-urlencoded' } });
      // the portal's callback sets its session cookies; follow its redirects to the user page
      let url = location;
      for (let i = 0; i < 5 && url; i++) {
        const r = await jarFetch(jar, url, { headers: BROWSER });
        const next = r.headers.get('location');
        url = next ? new URL(next, BASE).href : null;
      }
      s.jar = jar;
      log('euda: signed in');
    } catch (e) {
      s.pausedUntil = Date.now() + (e instanceof VwIdError && e.kind === 'password' ? 6 * 3600e3 : 15 * 60e3);
      throw e;
    }
  }

  async function api(p, headers = {}, raw = false) {
    if (!s.jar) await login();
    let r = await jarFetch(s.jar, BASE + p, { headers: { ...BROWSER, Accept: 'application/json, */*', Referer: `${BASE}/de/en/user.html`, ...headers } });
    if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) {
      s.jar = null; await login();
      r = await jarFetch(s.jar, BASE + p, { headers: { ...BROWSER, Accept: 'application/json, */*', Referer: `${BASE}/de/en/user.html`, ...headers } });
    }
    if (!r.ok) { const e = new Error(`EU Data Act portal ${r.status} on ${p.replace(s.vin || '#', '{vin}')}`); e.status = r.status; throw e; }
    return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
  }

  async function check() {
    if (!s.vehicles) {
      s.vehicles = await api('/proxy_api/consent/me/vehicles?viewPosition=FRONT_LEFT');
      const car = s.vehicles.find((v) => v.role === 'PRIMARY_USER' && v.enrollmentStatus === 'COMPLETED') || s.vehicles[0];
      if (!car) throw new Error('No car on the EU Data Act portal for this account');
      s.vin = car.vin;
    }
    // Two kinds of request: the continuous one ("partial") and a one-off file of everything held ("all").
    // Files from both go into data/euda/.
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    s.files = [];
    for (const type of ['partial', 'all']) {
      let req;
      try { req = await api(`/proxy_api/euda-apim/datarequest/vehicles/${s.vin}/metadata/${type}`); } catch (e) {
        if (e.status === 404) continue; // no request of this kind
        throw e;
      }
      if (type === 'partial') s.request = req;
      else s.fullRequest = req;
      const id = req?.Identifier;
      if (!id) continue;
      let list = [];
      try { list = await api(`/proxy_api/euda-apim/datadelivery/vehicles/${s.vin}/${id}/list`, { type }); } catch (e) {
        if (e.status !== 404) throw e; // 404: nothing delivered yet
      }
      for (const f of Array.isArray(list) ? list : []) {
        s.files.push(f);
        const name = path.basename(String(f.name || ''));
        if (!name || fs.existsSync(path.join(DIR, name))) continue;
        const buf = await api(`/proxy_api/euda-apim/datadelivery/vehicles/${s.vin}/${id}/download`, { type, filename: name }, true);
        if (buf.length) { fs.writeFileSync(path.join(DIR, name), buf, { mode: 0o600 }); s.downloaded++; log(`euda: downloaded (${type})`, name.replace(s.vin, '{vin}')); }
      }
    }
    if (!s.request && !s.fullRequest) { s.error = 'No data request found yet'; return; }
    s.checked = Date.now();
    s.error = null;
  }

  return {
    dir: DIR,
    start() {
      every('euda', 15 * 60e3, async () => {
        try { await check(); } catch (e) { s.error = e.message; throw e; }
      });
    },
    status() {
      return { checked: s.checked, error: s.error, request: s.request && { name: s.request.Name, created: s.request.CreationDate || s.request.createdAt || null },
        fullRequest: s.fullRequest ? { name: s.fullRequest.Name || null, status: s.fullRequest.Status || s.fullRequest.status || null } : null,
        filesOnPortal: s.files.length, filesStored: fs.existsSync(DIR) ? fs.readdirSync(DIR).length : 0,
        // the portal names empty deliveries ..._no_content_found.zip (nothing reported by the car in that period)
        filesWithData: fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => !f.includes('no_content')).length : 0 };
    },
  };
}
