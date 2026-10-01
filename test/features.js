// Feature tests: second landlord, shared leases, reset, 2FA, backups, deposits, finance, photos, inspections, listing.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-feat-'));
const PORT = 3458, base = `http://localhost:${PORT}`;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dir, MAIL_TRANSPORT: 'json' }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1500));

const jar = {};
const who = name => ({
  async call(method, p, body, headers = {}) {
    const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Cookie: jar[name] || '', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) jar[name] = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.text() };
  },
  async raw(path_, bytes, method = 'POST') {
    const res = await fetch(base + '/api' + path_, { method, headers: { 'Content-Type': 'application/octet-stream', Cookie: jar[name] || '' }, body: bytes });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  },
  async get(p) { const r = await fetch(base + p, { headers: { Cookie: jar[name] || '' } }); return { status: r.status, type: r.headers.get('content-type') || '', buf: Buffer.from(await r.arrayBuffer()) }; },
});
const ok = async (p, s = 200) => { const r = await p; assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
const mails = () => new DatabaseSync(path.join(dir, 'rental.db'), { readOnly: true }).prepare('SELECT * FROM email_queue ORDER BY id').all();
const wait = ms => new Promise(r => setTimeout(r, ms));

// --- TOTP helper (independent re-implementation) ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const dec = s => { let bits = ''; for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const o = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o); };
const totp = (secret, offset = 0) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset)); const h = crypto.createHmac('sha1', dec(secret)).update(m).digest(); const o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };

const PDF = Buffer.from('%PDF-1.4 x');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('fakepngdata')]);

const L1 = who('L1'), L2 = who('L2'), T = who('T'), M = who('M'), O = who('O'), X = who('X');

try {
  // ----- two landlords -----
  await ok(L1.call('POST', '/setup', { name: 'Lan', email: 'l1@x.com', password: 'longpassword1', property_name: 'Condo' }));
  const inv = await ok(L1.call('POST', '/landlords', { name: 'Wife', email: 'l2@x.com' }));
  await ok(L2.call('POST', '/invite/' + inv.invite_token, { password: 'wifepassword1' }));
  await ok(L2.call('GET', '/tenants'));
  assert.equal((await ok(L1.call('GET', '/landlords'))).length, 2);
  await ok(L1.call('DELETE', `/landlords/1`), 400); // cannot deactivate yourself
  await ok(T.call('GET', '/landlords'), 401);

  // ----- tenant + household -----
  const t = await ok(L1.call('POST', '/tenants', { name: 'Tina', email: 't@x.com', rent: '1500', due_day: 1, lease_start: '2020-01-01' }));
  await ok(T.call('POST', '/invite/' + t.invite_token, { password: 'tenantpass99' }));
  const mem = await ok(L1.call('POST', `/tenants/${t.id}/members`, { name: 'Tom', email: 'tom@x.com' }));
  await ok(M.call('POST', '/invite/' + mem.invite_token, { password: 'tompassword9' }));
  assert.equal((await ok(L1.call('GET', '/tenants'))).length, 1, 'members are not listed as separate tenants');
  const mses = (await ok(M.call('GET', '/session'))).user;
  assert.equal(mses.rent_cents, 150000, 'member sees lease terms');
  const a = await ok(T.call('GET', '/me/ledger')), b = await ok(M.call('GET', '/me/ledger'));
  assert.equal(a.balance_cents, b.balance_cents);
  assert.equal(b.household.length, 2);
  const p = await ok(M.call('POST', '/payments', { amount: '100', method: 'venmo' }));
  assert.equal((await ok(T.call('GET', '/me/ledger'))).payments[0].paid_by_name, 'Tom');
  const tk = await ok(M.call('POST', '/tickets', { title: 'Leak', description: 'drip' }));
  assert.equal((await ok(T.call('GET', '/tickets'))).length, 1, 'co-tenant sees the lease tickets');
  await ok(L1.call('POST', `/tenants/${t.id}/members`, { name: 'A', email: 'a@x.com' }));
  await ok(L1.call('POST', `/tenants/${t.id}/members`, { name: 'B', email: 'b@x.com' }));
  await ok(L1.call('POST', `/tenants/${t.id}/members`, { name: 'C', email: 'c@x.com' }), 400); // lease login cap
  const o = await ok(L1.call('POST', '/tenants', { name: 'Other', email: 'o@x.com' }));
  await ok(O.call('POST', '/invite/' + o.invite_token, { password: 'otherpass99' }));
  await ok(O.call('GET', `/tickets/${tk.id}`), 404);

  // ----- notifications -----
  await wait(300);
  const q = mails();
  assert.ok(q.some(m => m.to_addr === 'l1@x.com' && /Payment reported/.test(m.subject)), 'landlord emailed about reported payment');
  assert.ok(q.some(m => m.to_addr === 'l2@x.com' && /New request/.test(m.subject)), 'both landlords emailed about new ticket');
  assert.ok(q.some(m => m.to_addr === 't@x.com' && /invited/.test(m.subject)), 'invite emailed');
  assert.ok(q.filter(m => m.status === 'sent').length === q.length, 'queue delivered via test transport');
  await ok(L1.call('POST', `/payments/${p.id}/review`, { status: 'confirmed' }));
  await wait(200);
  assert.ok(mails().some(m => m.to_addr === 'tom@x.com' && /confirmed/.test(m.subject)), 'household emailed on confirmation');

  // ----- receipts & statements -----
  const rc = await T.get(`/api/payments/${p.id}/receipt`);
  assert.equal(rc.status, 200); assert.match(rc.buf.toString(), /\$100\.00/);
  assert.equal((await O.get(`/api/payments/${p.id}/receipt`)).status, 404);
  const pend = await ok(M.call('POST', '/payments', { amount: '5', method: 'cash' }));
  assert.equal((await T.get(`/api/payments/${pend.id}/receipt`)).status, 404, 'no receipt until confirmed');
  assert.equal((await T.get('/api/statement?year=2026&tenant_id=' + o.id)).buf.toString().includes('Other'), false, 'tenant cannot request another tenant statement');
  assert.equal((await L1.get(`/api/statement?tenant_id=${t.id}&year=2026`)).status, 200);

  // ----- password reset -----
  await ok(X.call('POST', '/forgot', { email: 'nobody@x.com' }));
  await ok(X.call('POST', '/forgot', { email: 't@x.com' }));
  await wait(200);
  const resetMail = mails().filter(m => m.to_addr === 't@x.com' && /Reset/.test(m.subject)).pop();
  const token = resetMail.body.match(/reset\/(\w+)/)[1];
  assert.equal(mails().filter(m => m.to_addr === 'nobody@x.com').length, 0, 'no email for unknown address');
  await ok(X.call('POST', '/reset/' + token, { password: 'brandnewpass1' }));
  await ok(X.call('POST', '/reset/' + token, { password: 'brandnewpass2' }), 404);
  await ok(T.call('GET', '/me/ledger'), 401); // old sessions were revoked
  await ok(T.call('POST', '/login', { email: 't@x.com', password: 'brandnewpass1' }));

  // ----- two-factor -----
  await ok(L1.call('POST', '/2fa/enable', { code: '123456' }), 400);
  const setup = await ok(L1.call('POST', '/2fa/setup'));
  assert.match(setup.qr, /<svg/);
  await ok(L1.call('POST', '/2fa/enable', { code: '000000' }), 400);
  const en = await ok(L1.call('POST', '/2fa/enable', { code: totp(setup.secret) }));
  assert.equal(en.recovery_codes.length, 8);
  const Y = who('Y');
  assert.equal((await ok(Y.call('POST', '/login', { email: 'l1@x.com', password: 'longpassword1' }))).totp_required, true);
  assert.equal((await Y.call('GET', '/session')).body.user, null, 'no session before the second factor');
  await ok(Y.call('POST', '/login', { email: 'l1@x.com', password: 'longpassword1', code: '000000' }), 401);
  await ok(Y.call('POST', '/login', { email: 'l1@x.com', password: 'longpassword1', code: totp(setup.secret, 1) }));
  const Z = who('Z');
  await ok(Z.call('POST', '/login', { email: 'l1@x.com', password: 'longpassword1', code: totp(setup.secret, 1) }), 401); // replay
  await ok(Z.call('POST', '/login', { email: 'l1@x.com', password: 'longpassword1', code: en.recovery_codes[0] }));
  await ok(who('Z2').call('POST', '/login', { email: 'l1@x.com', password: 'longpassword1', code: en.recovery_codes[0] }), 401); // single-use

  // ----- backups -----
  const L2b = L2;
  await ok(L2b.call('POST', '/backup/prepare', { password: 'wrong' }), 403);
  const prep = await ok(L2b.call('POST', '/backup/prepare', { password: 'wifepassword1' }));
  const tar = await L2b.get(prep.url);
  assert.equal(tar.status, 200); assert.equal(tar.type, 'application/x-tar');
  assert.ok(tar.buf.includes('rental.db') && tar.buf.includes('SQLite format 3'), 'tar contains a database snapshot');
  assert.equal((await L2b.get(prep.url)).status, 410, 'download link is single-use');
  await ok(T.call('POST', '/backup/prepare', { password: 'brandnewpass1' }), 403);

  // ----- deposits -----
  await ok(L2.call('POST', `/tenants/${t.id}/deposit`, { kind: 'received', amount: '1500' }));
  await ok(L2.call('POST', `/tenants/${t.id}/deposit`, { kind: 'deduction', amount: '2000' }), 400);
  await ok(L2.call('POST', `/tenants/${t.id}/deposit`, { kind: 'deduction', amount: '200', note: 'Carpet stain' }));
  assert.equal((await ok(T.call('GET', '/me/deposit'))).held_cents, 130000);
  assert.equal((await ok(O.call('GET', '/me/deposit'))).held_cents, 0);
  await ok(T.call('POST', `/tenants/${t.id}/deposit`, { kind: 'refund', amount: '10' }), 403);

  // ----- expenses & CSV safety -----
  await ok(L2.call('POST', '/expenses', { date: '2026-03-01', category: 'HOA dues', vendor: '=HYPERLINK("http://evil")', amount: '350' }));
  await ok(L2.call('POST', '/expenses', { date: '2026-03-05', category: 'repairs & maintenance', vendor: 'Plumber', amount: '120.50' }));
  await ok(T.call('GET', '/expenses'), 403);
  const csv = (await L2.get('/api/finance/expenses.csv?year=2026')).buf.toString();
  assert.ok(csv.includes("'=HYPERLINK"), 'formula neutralised'); assert.ok(csv.includes('350.00'));
  const sum = await ok(L2.call('GET', '/finance/summary?year=2026'));
  assert.equal(sum.expenses_cents, 47050);

  // ----- ticket photos & private notes -----
  await ok(T.raw(`/attachments?ticket_id=${tk.id}&filename=leak.exe`, PNG), 400);
  await ok(T.raw(`/attachments?ticket_id=${tk.id}&filename=leak.png`, Buffer.from('not an image')), 400);
  const ph = await ok(T.raw(`/attachments?ticket_id=${tk.id}&filename=leak.png`, PNG));
  assert.equal((await O.get(`/api/attachments/${ph.id}/file`)).status, 404, 'other tenants cannot view');
  assert.equal((await L1.get(`/api/attachments/${ph.id}/file`)).status, 200);
  assert.equal((await M.get(`/api/attachments/${ph.id}/file`)).status, 200, 'co-tenant can view');
  await ok(T.raw(`/attachments?expense_id=1&filename=r.png`, PNG), 404);
  await ok(L2.call('POST', `/tickets/${tk.id}/comments`, { body: 'secret plan', internal: true }));
  await ok(L2.call('POST', `/tickets/${tk.id}/comments`, { body: 'plumber coming' }));
  assert.equal((await ok(T.call('GET', `/tickets/${tk.id}`))).comments.length, 1, 'private note hidden from tenant');
  assert.equal((await ok(L2.call('GET', `/tickets/${tk.id}`))).comments.length, 2);
  await ok(T.call('POST', `/tickets/${tk.id}/comments`, { body: 'x', internal: true })); // tenant flag ignored
  assert.equal((await ok(L2.call('GET', `/tickets/${tk.id}`))).comments.at(-1).internal, 0);

  // ----- inspections -----
  const ins = await ok(L1.call('POST', '/inspections', { tenant_id: t.id, kind: 'move_in' }));
  await ok(T.call('GET', `/inspections/${ins.id}`), 404); // draft
  const det = await ok(L1.call('GET', `/inspections/${ins.id}`));
  assert.ok(det.items.length >= 15);
  await ok(L1.call('POST', `/inspections/${ins.id}/share`));
  assert.equal((await ok(M.call('GET', '/inspections'))).length, 1);
  assert.equal((await ok(O.call('GET', '/inspections'))).length, 0);
  await ok(T.call('POST', `/inspections/${ins.id}/ack`, { comment: 'Fine' }));
  assert.ok((await ok(L1.call('GET', `/inspections/${ins.id}`))).inspection.acknowledged_at);
  await ok(T.raw(`/attachments?item_id=${det.items[0].id}&filename=a.png`, PNG), 403);
  const ip = await ok(L1.raw(`/attachments?item_id=${det.items[0].id}&filename=a.png`, PNG));
  assert.equal((await T.get(`/api/attachments/${ip.id}/file`)).status, 200);
  assert.equal((await ok(L1.call('GET', `/inspections/${ins.id}`))).inspection.acknowledged_at, null, 'editing after sign-off clears acknowledgement');
  assert.equal((await O.get(`/api/attachments/${ip.id}/file`)).status, 404);
  assert.equal((await T.get(`/api/inspections/${ins.id}/report`)).status, 200);

  // ----- listing -----
  await ok(L1.call('PUT', '/listing', { title: 'Nice condo', description: 'Sunny', asking_rent: '$2,000' }));
  await ok(T.call('GET', '/listing'), 403);
  const l1 = await ok(L1.raw('/attachments?listing=1&filename=living.png&caption=Living%20room', PNG));
  const l2 = await ok(L1.raw('/attachments?listing=1&filename=kitchen.png', PNG));
  await ok(T.call('GET', '/attachments?listing=1'), 404);
  await ok(L1.call('POST', '/attachments/reorder', { ids: [l2.id, l1.id] }));
  assert.equal((await ok(L1.call('GET', '/listing'))).photos[0].id, l2.id, 'reordered');
  const photosTar = await L1.get('/api/listing/photos.tar');
  assert.equal(photosTar.status, 200); assert.ok(photosTar.buf.includes('captions.txt'));
  assert.match((await L1.get('/api/listing/sheet')).buf.toString(), /Nice condo/);
  assert.equal((await L1.get('/api/listing/sheet')).status, 200);
  assert.equal((await T.get('/api/listing/sheet')).status, 403);

  // ----- activity log -----
  const act = await ok(L2.call('GET', '/activity'));
  assert.ok(act.length >= 8 && act.some(a => /Invited landlord/.test(a.text)));
  await ok(T.call('GET', '/activity'), 403);

  // another landlord can reset a locked-out landlord
  const rs = await ok(L2.call('POST', '/landlords/1/reset'));
  assert.ok(rs.invite_token);
  await ok(L1.call('GET', '/tenants'), 401); // reset revoked the old sessions
  console.log('FEATURE TESTS PASSED');
} finally { srv.kill(); await wait(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
