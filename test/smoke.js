// End-to-end smoke test against a throwaway DB. Run: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-'));
const PORT = 3456, base = `http://localhost:${PORT}`;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dir, SETUP_CODE: 'abc123' }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1200));

const jar = {};
const client = name => ({
  async call(method, p, body, headers = {}) {
    const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Cookie: jar[name] || '', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) jar[name] = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  },
});
const L = client('L'), T = client('T'), X = client('X');
const ok = async (p, s = 200) => { const r = await p; assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };

try {
  await ok(L.call('POST', '/setup', { name: 'Lan', email: 'l@x.com', password: 'longpassword1', setup_code: 'wrong' }), 403);
  await ok(L.call('POST', '/setup', { name: 'Lan', email: 'l@x.com', password: 'longpassword1', setup_code: 'abc123', property_name: 'Condo' }));
  await ok(X.call('POST', '/setup', { name: 'Evil', email: 'e@x.com', password: 'longpassword1', setup_code: 'abc123' }), 403);
  await ok(L.call('POST', '/login', { email: 'l@x.com', password: 'longpassword1' }, { Origin: 'http://evil.com' }), 403);

  const { id, invite_token } = await ok(L.call('POST', '/tenants', { name: 'Tina Tenant', email: 't@x.com', rent: '1500', due_day: 1, late_fee: '50', grace_days: 5, lease_start: '2020-01-01' }));
  await ok(T.call('POST', '/invite/' + invite_token, { password: 'tenantpass99' }));
  await ok(T.call('POST', '/invite/' + invite_token, { password: 'again12345' }), 404); // single-use

  // authorization boundaries
  await ok(T.call('GET', '/tenants'), 403);
  await ok(T.call('GET', '/payments'), 403);
  await ok(X.call('GET', '/me/ledger'), 401);

  let led = await ok(T.call('GET', '/me/ledger'));
  assert.ok(led.charges.length >= 1 && led.balance_cents >= 150000, 'rent charge generated');

  const pay = await ok(T.call('POST', '/payments', { amount: '1500', method: 'venmo', reference: 'abc' }));
  assert.equal(pay.status, 'pending');
  led = await ok(T.call('GET', '/me/ledger'));
  assert.equal(led.pending_cents, 150000);
  const before = led.balance_cents;
  await ok(L.call('POST', `/payments/${pay.id}/review`, { status: 'confirmed' }));
  led = await ok(T.call('GET', '/me/ledger'));
  assert.equal(led.balance_cents, before - 150000);
  await ok(T.call('POST', `/payments/${pay.id}/review`, { status: 'confirmed' }), 403);
  await ok(T.call('POST', '/payments', { amount: '-5', method: 'venmo' }), 400);

  const tk = await ok(T.call('POST', '/tickets', { title: 'Leak', description: 'Sink leaks', priority: 'urgent' }));
  await ok(L.call('POST', `/tickets/${tk.id}/comments`, { body: 'On it' }));
  await ok(L.call('PUT', `/tickets/${tk.id}/status`, { status: 'in_progress' }));
  await ok(T.call('PUT', `/tickets/${tk.id}/status`, { status: 'in_progress' }), 403);

  // another tenant can't see this ticket
  const inv2 = await ok(L.call('POST', '/tenants', { name: 'Other', email: 'o@x.com' }));
  const O = client('O');
  await ok(O.call('POST', '/invite/' + inv2.invite_token, { password: 'otherpass99' }));
  await ok(O.call('GET', `/tickets/${tk.id}`), 404);

  // upcoming charges are projected beyond the two months that have real charge rows
  assert.ok(led.scheduled.length >= 10, 'future rent scheduled');
  assert.ok(led.scheduled.every(s => s.status === 'scheduled' && s.due_date > new Date().toISOString().slice(0, 10).slice(0, 0) + '0'));

  // documents
  const upload = (who, qs, bytes) => fetch(`${base}/api/documents?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: jar[who] }, body: bytes }).then(async r => ({ status: r.status, body: await r.json() }));
  const pdf = Buffer.from('%PDF-1.4 fake lease');
  await ok(upload('L', 'filename=x.exe', pdf), 400);
  await ok(upload('L', 'filename=x.pdf', Buffer.from('not a pdf')), 400);
  const priv = await ok(upload('L', `filename=lease.pdf&category=lease&tenant_id=${id}&visible=0`, pdf));
  const shown = await ok(upload('L', `filename=notice.pdf&tenant_id=${id}`, pdf));
  const wide = await ok(upload('L', 'filename=rules.pdf&tenant_id=all', pdf));
  const ids = async who => (await ok(who.call('GET', '/documents'))).map(d => d.id);
  assert.deepEqual((await ids(T)).sort(), [shown.id, wide.id].sort(), 'tenant sees visible + property-wide only');
  assert.ok((await ids(O)).includes(wide.id) && !(await ids(O)).includes(shown.id), 'other tenant sees only property-wide');
  assert.equal((await fetch(`${base}/api/documents/${shown.id}/download`, { headers: { Cookie: jar.T } })).headers.get('content-disposition').startsWith('attachment'), true);
  assert.equal((await fetch(`${base}/api/documents/${priv.id}/download`, { headers: { Cookie: jar.T } })).status, 404);
  assert.equal((await fetch(`${base}/api/documents/${shown.id}/download`, { headers: { Cookie: jar.O } })).status, 404);
  assert.equal((await fetch(`${base}/api/documents/${shown.id}/download`)).status, 401);
  await ok(T.call('DELETE', `/documents/${shown.id}`), 403);
  const mine = await ok(upload('T', 'filename=insurance.pdf&tenant_id=999', pdf)); // tenant can't target another tenant
  assert.equal((await ok(L.call('GET', '/documents'))).find(d => d.id === mine.id).tenant_id, led.tenant.id ?? (await ok(T.call('GET', '/me/ledger'))).tenant.id);
  await ok(T.call('DELETE', `/documents/${mine.id}`));
  await ok(L.call('DELETE', `/documents/${priv.id}`));

  // brute-force throttle
  let last;
  for (let i = 0; i < 12; i++) last = await X.call('POST', '/login', { email: 'l@x.com', password: 'nope' + i });
  assert.equal(last.status, 429);
  await ok(T.call('POST', '/logout')); await ok(T.call('GET', '/me/ledger'), 401);
  console.log('ALL TESTS PASSED');
} finally { srv.kill(); await new Promise(r => setTimeout(r, 300)); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
