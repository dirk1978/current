// Used by setup.sh to check logins before saving them.
//   node tools/check-login.mjs octopus <api-key>        -> prints the account number(s)
//   node tools/check-login.mjs ohme <email> <password>  -> prints the charger (and car)
const [what, a, b] = process.argv.slice(2);
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then((r) => r.json());
try {
  if (what === 'octopus') {
    const t = await post('https://api.octopus.energy/v1/graphql/', { query: 'mutation($k:String!){obtainKrakenToken(input:{APIKey:$k}){token}}', variables: { k: a } });
    if (!t.data?.obtainKrakenToken) throw new Error('Octopus didn’t accept that API key');
    const v = await post('https://api.octopus.energy/v1/graphql/', { query: '{viewer{accounts{number}}}' }, { Authorization: t.data.obtainKrakenToken.token });
    console.log(v.data.viewer.accounts.map((x) => x.number).join(' '));
  } else if (what === 'ohme') {
    const r = await post('https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=AIzaSyC8ZeZngm33tpOXLpbXeKfwtyZ1WrkbdBY', { email: a, password: b, returnSecureToken: true });
    if (!r.idToken) throw new Error('Ohme didn’t accept that email and password');
    const acc = await fetch('https://api.ohme.io/v1/users/me/account', { headers: { Authorization: `Firebase ${r.idToken}` } }).then((x) => x.json());
    const d = acc.chargeDevices?.[0];
    if (!d) throw new Error('No charger found on that Ohme account');
    const car = acc.cars?.[0] ? [acc.cars[0].model?.make, acc.cars[0].model?.modelName].filter(Boolean).join(' ') : '';
    console.log([d.modelTypeDisplayName, car].filter(Boolean).join(' + '));
  } else throw new Error('usage: check-login.mjs octopus <key> | ohme <email> <password>');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
