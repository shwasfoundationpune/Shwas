import http from 'node:http';
import { createPrivateKey, sign, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const interests = new Set(['Volunteering', 'Membership', 'Partnership', 'General enquiry']);
export function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const clean = {};
  for (const [key, max] of Object.entries({ name: 100, email: 254, mobile: 24, interest: 40, token: 2048 })) {
    if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > max) return null;
    clean[key] = data[key].trim();
  }
  const message = data.message ?? '';
  if (typeof message !== 'string' || message.length > 2000) return null;
  clean.message = message.trim();
  clean.mobile = clean.mobile.replace(/[\s()-]/g, '');
  if (data.consent !== true || (data.website != null && data.website !== '') ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email) ||
      !/^(?:[6-9]\d{9}|\+[1-9]\d{7,14})$/.test(clean.mobile) ||
      !interests.has(clean.interest)) return null;
  return clean;
}

export function createHandler(env, fetcher = fetch) {
  const origins = new Set((env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
  const hosts = new Set((env.TURNSTILE_HOSTNAMES || '').split(',').map(x => x.trim()).filter(Boolean));
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  const ready = !!(origins.size && hosts.size && env.TURNSTILE_SECRET_KEY && env.GOOGLE_SHEET_ID && credentials.client_email && credentials.private_key);
  // Fail startup on a malformed private key, without logging its contents.
  const privateKey = ready ? createPrivateKey(credentials.private_key) : null;
  let cachedToken, tokenExpires = 0;
  const recent = new Map();
  async function googleToken() {
    if (cachedToken && Date.now() < tokenExpires) return cachedToken;
    const now = Math.floor(Date.now() / 1000);
    const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
      iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
    });
    const assertion = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
    const result = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await result.json();
    if (!result.ok || !body.access_token) throw new Error('Google authentication unavailable');
    cachedToken = body.access_token; tokenExpires = Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000;
    return cachedToken;
  }
  return async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    const path = req.url?.split('?')[0];
    if (path === '/health' && req.method === 'GET') return reply(ready ? 200 : 503, { ok: ready });
    if (path !== '/api/enquiries') return reply(404, { ok: false });
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!origins.has(origin)) return reply(403, { ok: false, message: 'This website is not allowed to submit enquiries.' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204); return res.end();
    }
    if (req.method !== 'POST') return reply(405, { ok: false });
    if (!ready) return reply(503, { ok: false, message: 'Online enquiries are temporarily unavailable. Please email us.' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { ok: false, message: 'Invalid submission format.' });
    const chunks = [];
    let size = 0, data;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) return reply(413, { ok: false, message: 'Your message is too long.' });
        chunks.push(chunk);
      }
      data = validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { return reply(400, { ok: false, message: 'Invalid submission.' }); }
    if (!data) return reply(400, { ok: false, message: 'Please complete all required fields with valid details and agree to be contacted.' });
    try {
      const check = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: data.token }),
        signal: AbortSignal.timeout(15000)
      });
      const captcha = await check.json();
      if (!check.ok || captcha.success !== true || !hosts.has(captcha.hostname) || captcha.action !== 'enquiry')
        return reply(400, { ok: false, message: 'Security verification expired or failed. Please complete it again.' });
      // A small extra limit per email; CAPTCHA remains the primary spam control.
      // This limit is per process and resets when the service restarts.
      const now = Date.now();
      for (const [key, value] of recent) if (value.until <= now) recent.delete(key);
      const key = data.email.toLowerCase();
      const count = recent.get(key) || { count: 0, until: now + 600000 };
      if (count.count >= 3 || recent.size >= 10000) return reply(429, { ok: false, message: 'Too many enquiries. Please wait ten minutes or email us.' });
      count.count++; recent.set(key, count);
      const accessToken = await googleToken();
      const sheetName = (env.GOOGLE_SHEET_TAB || 'Enquiries').replace(/'/g, "''");
      const range = encodeURIComponent("'" + sheetName + "'!A:K");
      const id = randomUUID();
      const result = await fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[new Date().toISOString(), data.name, data.email, data.mobile, data.interest, data.message, 'Agreed to enquiry contact (v1)', 'New', '', '', id]] }),
        signal: AbortSignal.timeout(20000)
      });
      const saved = await result.json();
      if (!result.ok || saved.updates?.updatedRows !== 1) throw new Error('Save not confirmed');
      return reply(201, { ok: true });
    } catch {
      // Do not log personal information, CAPTCHA tokens, or credentials.
      return reply(503, { ok: false, message: 'We could not confirm receipt. Please email us before trying again to avoid a duplicate enquiry.' });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = http.createServer(createHandler(process.env));
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
