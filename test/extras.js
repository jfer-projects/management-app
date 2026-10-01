// Announcements, lease renewal, vendors, home guide.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-extra-'));
const PORT = 3459, base = `http://localhost:${PORT}`;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dir, MAIL_TRANSPORT: 'json' }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1500));
const jar = {};
const who = n => ({ async call(method, p, body) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Cookie: jar[n] || '' }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jar[n] = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => ({})) };
} });
const ok = async (p, s = 200) => { const r = await p; assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const L = who('L'), T = who('T'), O = who('O');

try {
  await ok(L.call('POST', '/setup', { name: 'Lan', email: 'l@x.com', password: 'longpassword1', property_name: 'Condo' }));
  const t = await ok(L.call('POST', '/tenants', { name: 'Tina', email: 't@x.com', rent: '1500', due_day: 1, lease_start: '2020-01-01', lease_end: '2026-12-31' }));
  await ok(T.call('POST', '/invite/' + t.invite_token, { password: 'tenantpass99' }));
  const o = await ok(L.call('POST', '/tenants', { name: 'Olive', email: 'o@x.com', rent: '1000' }));
  await ok(O.call('POST', '/invite/' + o.invite_token, { password: 'olivepass99' }));

  // announcements
  await ok(T.call('POST', '/announcements', { title: 'x', body: 'y' }), 403);
  await ok(L.call('POST', '/announcements', { title: '', body: 'y' }), 400);
  const an = await ok(L.call('POST', '/announcements', { title: 'Water shutoff Tuesday', body: '9am to noon', email: true }));
  assert.equal((await ok(T.call('GET', '/announcements')))[0].title, 'Water shutoff Tuesday');
  await wait(300);
  const q = new DatabaseSync(path.join(dir, 'rental.db'), { readOnly: true }).prepare("SELECT to_addr FROM email_queue WHERE subject='Water shutoff Tuesday'").all().map(r => r.to_addr).sort();
  assert.deepEqual(q, ['o@x.com', 't@x.com'], 'emailed every tenant');
  await ok(T.call('DELETE', '/announcements/' + an.id), 403);
  await ok(L.call('DELETE', '/announcements/' + an.id));

  // lease renewal with a rent change
  await ok(T.call('POST', `/tenants/${t.id}/renew`, { new_end: '2027-12-31' }), 403);
  await ok(L.call('POST', `/tenants/${t.id}/renew`, { new_end: 'nope' }), 400);
  await ok(L.call('POST', `/tenants/${t.id}/renew`, { new_end: '2026-06-01' }), 400);
  const before = await ok(L.call('GET', `/tenants/${t.id}`));
  const future = before.charges.filter(c => c.type === 'rent' && c.due_date > new Date().toISOString().slice(0, 10));
  await ok(L.call('POST', `/tenants/${t.id}/renew`, { new_end: '2027-12-31', rent: '1600', effective_date: '2000-01-01', note: 'Thanks!', email: true }));
  const after = await ok(L.call('GET', `/tenants/${t.id}`));
  assert.equal(after.tenant.lease_end, '2027-12-31'); assert.equal(after.tenant.rent_cents, 160000);
  assert.ok(after.charges.filter(c => c.type === 'rent').every(c => c.amount_cents === 160000), 'billed rent updated from the effective date');
  assert.ok(after.scheduled.every(c => c.amount_cents === 160000), 'scheduled rent uses new amount');
  const hist = await ok(L.call('GET', `/tenants/${t.id}/lease-history`));
  assert.equal(hist.length, 1); assert.equal(hist[0].old_rent_cents, 150000);
  await ok(T.call('GET', `/tenants/${t.id}/lease-history`), 403);

  // vendors + ticket work (landlord-only data)
  await ok(T.call('GET', '/vendors'), 403);
  await ok(L.call('POST', '/vendors', { name: '' }), 400);
  const v = await ok(L.call('POST', '/vendors', { name: 'Reliable Plumbing', trade: 'Plumber', phone: '555-1', email: 'p@x.com' }));
  const tk = await ok(T.call('POST', '/tickets', { title: 'Leak', description: 'drip' }));
  await ok(T.call('PUT', `/tickets/${tk.id}/work`, { vendor_id: v.id, cost: '80' }), 403);
  await ok(L.call('PUT', `/tickets/${tk.id}/work`, { vendor_id: v.id, cost: '129.50' }));
  const lt = (await ok(L.call('GET', `/tickets/${tk.id}`))).ticket;
  assert.equal(lt.vendor_name, 'Reliable Plumbing'); assert.equal(lt.cost_cents, 12950);
  const tt = (await ok(T.call('GET', `/tickets/${tk.id}`))).ticket;
  assert.equal(tt.vendor_name, undefined); assert.equal(tt.cost_cents, undefined);
  assert.equal((await ok(T.call('GET', '/tickets')))[0].cost_cents, undefined, 'list also hides cost');
  const vs = (await ok(L.call('GET', '/vendors')))[0];
  assert.equal(vs.jobs, 1); assert.equal(vs.spent_cents, 12950);
  await ok(L.call('DELETE', '/vendors/' + v.id));
  assert.equal((await ok(L.call('GET', `/tickets/${tk.id}`))).ticket.vendor_name, null);

  // home guide + counts
  await ok(T.call('PUT', '/home-guide', { trash: 'x' }), 403);
  await ok(L.call('PUT', '/home-guide', { trash: 'Tuesday morning', emergency: 'Super: 555-0100' }));
  assert.equal((await ok(O.call('GET', '/home-guide'))).trash, 'Tuesday morning');
  await ok(T.call('GET', '/counts'), 403);
  assert.equal((await ok(L.call('GET', '/counts'))).open_tickets, 1);
  console.log('EXTRAS TESTS PASSED');
} finally { srv.kill(); await wait(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
