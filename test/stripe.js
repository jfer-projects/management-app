// Webhook tests with locally-signed events (no network / real Stripe keys needed).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import Stripe from 'stripe';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-stripe-'));
const PORT = 3457, base = `http://localhost:${PORT}`, SECRET = 'whsec_test_secret';
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dir, STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: SECRET }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1200));
const stripe = new Stripe('sk_test_fake');

let cookie = '';
const api = async (method, p, body) => {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const hook = async (type, session, { sig } = {}) => {
  const payload = JSON.stringify({ id: 'evt_' + Math.random(), object: 'event', type, data: { object: session } });
  const header = sig ?? stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  const res = await fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header }, body: payload });
  return res.status;
};

try {
  await api('POST', '/setup', { name: 'L', email: 'l@x.com', password: 'longpassword1', property_name: 'C' });
  const t = (await api('POST', '/tenants', { name: 'Tina', email: 't@x.com', rent: '1500', due_day: 1 })).body;
  const sess = { id: 'cs_1', amount_total: 150000, payment_intent: 'pi_1', payment_status: 'unpaid', metadata: { tenant_id: String(t.id) } };
  const bal = async () => (await api('GET', `/tenants/${t.id}`)).body;
  const start = (await bal()).balance_cents;

  assert.equal(await hook('checkout.session.completed', sess, { sig: 't=1,v1=deadbeef' }), 400, 'forged signature rejected');
  assert.equal((await bal()).payments.length, 0);

  assert.equal(await hook('checkout.session.completed', sess), 200);
  let d = await bal();
  assert.equal(d.payments[0].status, 'pending'); assert.equal(d.payments[0].method, 'ach');
  assert.equal(d.balance_cents, start, 'pending ACH does not reduce balance yet');

  await hook('checkout.session.async_payment_succeeded', sess);
  await hook('checkout.session.async_payment_succeeded', sess); // duplicate delivery
  d = await bal();
  assert.equal(d.payments.length, 1, 'idempotent'); assert.equal(d.payments[0].status, 'confirmed');
  assert.equal(d.balance_cents, start - 150000);

  await hook('checkout.session.async_payment_failed', sess); // late/out-of-order failure must not undo a confirmed payment
  assert.equal((await bal()).payments[0].status, 'confirmed');

  const bad = { id: 'cs_2', amount_total: 50000, payment_intent: 'pi_2', payment_status: 'unpaid', metadata: { tenant_id: String(t.id) } };
  await hook('checkout.session.completed', bad); await hook('checkout.session.async_payment_failed', bad);
  assert.equal((await bal()).payments.find(p => p.stripe_session_id === 'cs_2').status, 'rejected');

  // tenant checkout validation (fails before any network call)
  const T = await fetch(base + '/api/tenants/' + t.id).then(() => null);
  cookie = ''; const inv = (await api('GET', `/tenants/${t.id}`)); // logged out -> 401
  assert.equal(inv.status, 401);
  console.log('STRIPE TESTS PASSED');
} finally { srv.kill(); await new Promise(r => setTimeout(r, 300)); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
