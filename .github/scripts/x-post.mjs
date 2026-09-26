// Post one tweet via the X API v2 free tier, OAuth 1.0a user context, Node builtins only.
// env: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET, TEXT
import crypto from 'node:crypto';
const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const url = 'https://api.twitter.com/2/tweets';
const oauth = {
  oauth_consumer_key: process.env.X_CONSUMER_KEY,
  oauth_nonce: crypto.randomBytes(16).toString('hex'),
  oauth_signature_method: 'HMAC-SHA1',
  oauth_timestamp: String(Math.floor(Date.now() / 1000)),
  oauth_token: process.env.X_ACCESS_TOKEN,
  oauth_version: '1.0',
};
const paramStr = Object.keys(oauth).sort().map((k) => `${enc(k)}=${enc(oauth[k])}`).join('&');
const baseStr = `POST&${enc(url)}&${enc(paramStr)}`;
const signingKey = `${enc(process.env.X_CONSUMER_SECRET)}&${enc(process.env.X_ACCESS_SECRET)}`;
// OAuth 1.0a request signing REQUIRES HMAC-SHA1 (RFC 5849); this is a transport signature,
// not password storage, so the password-hash rule does not apply here.
oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64'); // codeql[js/insufficient-password-hash]
const header = 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
const text = (process.env.TEXT ?? '').slice(0, 279);
const res = await fetch(url, { method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
if (!res.ok) { console.error(`X post failed: ${res.status} ${await res.text()}`); process.exit(1); }
console.log('posted to X:', (await res.json()).data?.id ?? 'ok');
