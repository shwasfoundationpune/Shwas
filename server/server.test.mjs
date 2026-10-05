import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { createHandler, validate } from './server.mjs';

const data = { name: 'Test Volunteer', email: 'volunteer@example.com', mobile: '9876543210', interest: 'Volunteering', message: 'I would like to help.', consent: true, token: 'test-token', website: '' };
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  ALLOWED_ORIGINS: 'https://shwasfoundation.in', TURNSTILE_HOSTNAMES: 'shwasfoundation.in',
  TURNSTILE_SECRET_KEY: 'mock-secret', GOOGLE_SHEET_ID: 'mock-sheet',
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'mock@example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) })
};
test('every field and consent are mandatory; mobile and interests validated', () => {
  assert.ok(validate(data));
  for (const key of ['name', 'email', 'mobile', 'interest', 'message', 'token', 'consent']) assert.equal(validate({ ...data, [key]: '' }), null, key);
  for (const bad of [{ mobile: '123' }, { message: '  ' }, { consent: 'true' }, { email: 'invalid' }, { interest: 'Other' }, { website: 'spam' }, { message: 'x'.repeat(2001) }]) assert.equal(validate({ ...data, ...bad }), null);
  assert.equal(validate({ ...data, mobile: '+91 98765 43210' }).mobile, '+919876543210');
});
async function fixture(t, options = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('siteverify')) return Response.json(options.captcha || { success: true, hostname: 'shwasfoundation.in', action: 'enquiry' });
    if (url.includes('oauth2')) return Response.json({ access_token: 'mock-access-token', expires_in: 3600 });
    if (options.failSave) return Response.json({ error: 'mock' }, { status: 503 });
    return Response.json({ updates: { updatedRows: 1 } });
  };
  const server = http.createServer(createHandler(options.unconfigured ? {} : env, fetcher));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (body = data, origin = 'https://shwasfoundation.in') => fetch(url + '/api/enquiries', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { calls, send, url };
}
test('valid CAPTCHA saves all values as RAW, including formula-like text and mobile', async t => {
  const { send, calls } = await fixture(t);
  const r = await send({ ...data, message: '=SUM(A1:A2)' });
  assert.equal(r.status, 201); assert.equal((await r.json()).ok, true);
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /valueInputOption=RAW/);
  const row = JSON.parse(calls[2].init.body).values[0];
  assert.equal(row[3], '9876543210'); assert.equal(row[5], '=SUM(A1:A2)'); assert.equal(row[7], 'New'); assert.equal(row.length, 11);
});
test('invalid form and foreign origin never reach CAPTCHA or Sheets', async t => {
  const { send, calls } = await fixture(t);
  assert.equal((await send({ ...data, mobile: '' })).status, 400);
  assert.equal((await send(data, 'https://untrusted.example')).status, 403);
  assert.equal(calls.length, 0);
});
for (const captcha of [{ success: false }, { success: true, hostname: 'other.example', action: 'enquiry' }, { success: true, hostname: 'shwasfoundation.in', action: 'login' }]) {
  test('reject invalid CAPTCHA result ' + JSON.stringify(captcha), async t => {
    const { send, calls } = await fixture(t, { captcha });
    assert.equal((await send()).status, 400); assert.equal(calls.length, 1);
  });
}
test('storage failure never reports success', async t => {
  const { send } = await fixture(t, { failSave: true });
  const r = await send(); assert.equal(r.status, 503); assert.equal((await r.json()).ok, false);
});
test('repeated enquiries are limited', async t => {
  const { send } = await fixture(t);
  for (let i = 0; i < 3; i++) assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 429);
});
test('CORS preflight is supported and oversized payloads rejected', async t => {
  const { send, url } = await fixture(t);
  const r = await fetch(url + '/api/enquiries', { method: 'OPTIONS', headers: { Origin: 'https://shwasfoundation.in' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'https://shwasfoundation.in');
  assert.equal((await send({ ...data, message: 'x'.repeat(17000) })).status, 413);
});
test('unconfigured service fails health check', async t => {
  const { url } = await fixture(t, { unconfigured: true });
  assert.equal((await fetch(url + '/health')).status, 503);
});
