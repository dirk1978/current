// Sign-in to VW Group's identity service (identity.vwgroup.io), used by CUPRA/SEAT/VW/Skoda/Audi accounts.
// It's a web form: email page, then password page, then redirects back to the client's redirect URL.
// Follows the same steps as the open-source pycupra library (MIT).

// A tiny cookie jar (the sign-in and the portals rely on session cookies)
export class Jar {
  constructor() { this.c = new Map(); }
  take(res) {
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
}

// Fetch without following redirects, carrying the jar's cookies
export async function jarFetch(jar, url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), Cookie: jar.header() }, signal: AbortSignal.timeout(30000) });
  jar.take(res);
  return res;
}

const hidden = (html) => Object.fromEntries([...html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)]
  .map(([tag]) => [tag.match(/name="([^"]*)"/)?.[1], tag.match(/value="([^"]*)"/)?.[1] ?? '']).filter(([k]) => k));

export class VwIdError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; } // kind: password | throttled | terms | other
}

// Signs in and returns the final redirect URL (which carries ?code=...), following redirects until it starts
// with redirectPrefix. clientId is needed to build the password step's URL.
export async function vwSignIn({ jar, authUrl, redirectPrefix, clientId, email, password, headers }) {
  const oidc = await (await fetch('https://identity.vwgroup.io/.well-known/openid-configuration')).json();
  const go = (url, opts = {}) => jarFetch(jar, url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  let res = await go(authUrl);
  let ref = res.headers.get('location');
  // up to two hops before the sign-in page
  for (let i = 0; i < 2 && ref && !ref.includes('signin-service') && !ref.startsWith(redirectPrefix); i++) {
    if (/error/.test(ref)) throw new VwIdError('Sign-in refused: ' + (new URL(ref, oidc.issuer).searchParams.get('error_description') || 'error'), 'other');
    res = await go(new URL(ref, oidc.issuer).href);
    ref = res.headers.get('location') || ref;
  }
  let location;
  if (ref?.includes('signin-service')) {
    const pageRes = res.status === 200 ? res : await go(new URL(ref, oidc.issuer).href);
    const html = await pageRes.text();
    const form = html.match(/<form[^>]*id="emailPasswordForm"[\s\S]*?<\/form>/)?.[0];
    if (!form) throw new VwIdError('No sign-in form (the page may have changed)', 'other');
    const fields = { ...hidden(form), email };
    const action = new URL(form.match(/action="([^"]*)"/)[1], oidc.issuer).href;
    const r2 = await go(action, { method: 'POST', body: new URLSearchParams(fields), redirect: 'follow',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: oidc.authorization_endpoint, Origin: oidc.issuer } });
    const html2 = await r2.text();
    const pw = { ...fields };
    let postAction;
    const cform = html2.match(/<form[^>]*id="credentialsForm"[\s\S]*?<\/form>/)?.[0];
    if (cform) { Object.assign(pw, hidden(cform)); postAction = cform.match(/action="([^"]*)"/)[1]; } else {
      const m = html2.match(/templateModel: (.*?),\n/);
      if (!m) throw new VwIdError('Unexpected sign-in page (check the email address)', 'other');
      const model = JSON.parse(m[1]);
      if (model.error) throw new VwIdError('Sign-in: ' + model.error, 'other');
      pw.hmac = model.hmac;
      postAction = model.postAction;
    }
    pw.password = password;
    let pp = `${oidc.issuer}/${postAction.replace(/^\//, '')}`;
    if (!pp.includes('signin-service') || !pp.includes(clientId)) pp = `${oidc.issuer}/signin-service/v1/${clientId}/${postAction}`;
    const r3 = await go(pp, { method: 'POST', body: new URLSearchParams(pw),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: action, Origin: oidc.issuer } });
    location = r3.headers.get('location');
  } else {
    location = ref;
  }
  let userId = null;
  for (let i = 0; i < 12 && location && !location.startsWith(redirectPrefix); i++) {
    const u = new URL(location, oidc.issuer);
    const err = u.searchParams.get('error');
    if (err === 'login.error.throttled') throw new VwIdError('Account temporarily locked after failed sign-ins', 'throttled');
    if (err === 'login.errors.password_invalid') throw new VwIdError('Wrong password', 'password');
    if (err) throw new VwIdError('Sign-in refused: ' + err, 'other');
    if (/terms-and-conditions|consent\/marketing/.test(location)) throw new VwIdError('New terms or a consent question need answering at cupraid.vwgroup.io first', 'terms');
    if (u.searchParams.get('user_id')) userId = u.searchParams.get('user_id');
    const r = await go(u.href);
    location = r.headers.get('location');
  }
  if (!location?.startsWith(redirectPrefix)) throw new VwIdError('Sign-in did not complete', 'other');
  return { location, userId };
}
