// Reminder scheduler: each reminder fires once; lease/insurance only send the nearest threshold.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-rem-'));
process.env.DATA_DIR = dir; process.env.MAIL_TRANSPORT = 'json';
const { db } = await import('../db.js');
const { runReminders } = await import('../email.js');
const { todayStr } = await import('../billing.js');

const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return todayStr(d); };
db.prepare("INSERT INTO users(role,name,email,password_hash) VALUES('landlord','L','l@x.com','x')").run();
const mk = (name, email, extra = {}) => db.prepare(`INSERT INTO users(role,name,email,rent_cents,lease_end,insurance_expires,email_reminders) VALUES('tenant',?,?,150000,?,?,?)`)
  .run(name, email, extra.lease_end ?? null, extra.ins ?? null, extra.rem ?? 1).lastInsertRowid;
const charge = (t, desc, due) => db.prepare("INSERT INTO charges(tenant_id,type,description,amount_cents,due_date) VALUES(?,?,?,?,?)").run(t, 'other', desc, 10000, due);

const a = mk('Ann', 'ann@x.com', { lease_end: plus(20), ins: plus(5) });
charge(a, 'In two days', plus(2)); charge(a, 'Due today', plus(0)); charge(a, 'Three late', plus(-3)); charge(a, 'Ten late', plus(-10)); charge(a, 'Far away', plus(40));
const b = mk('Bob', 'bob@x.com', { rem: 0 }); charge(b, 'Bob overdue', plus(-3));

runReminders();
const subj = () => db.prepare('SELECT to_addr, subject FROM email_queue').all();
let s = subj();
const has = re => s.some(m => re.test(m.subject));
assert.ok(has(/Upcoming: In two days/) && has(/Due today: Due today/) && has(/Past due: Three late/) && has(/Still past due: Ten late/));
assert.ok(!has(/Far away/), 'no reminder far ahead');
assert.ok(!s.some(m => m.to_addr === 'bob@x.com'), 'opted-out tenant gets no rent reminders');
assert.equal(s.filter(m => /Lease ending/.test(m.subject)).length, 1, 'one lease reminder, not a burst');
assert.ok(has(/Lease ending in 30 days/));
assert.ok(s.some(m => m.to_addr === 'l@x.com' && /Lease ending/.test(m.subject)), 'landlord is told');
assert.ok(has(/insurance expires in 7 days/));
const count = s.length;
runReminders(); runReminders();
assert.equal(subj().length, count, 'second run sends nothing new');
console.log('REMINDER TESTS PASSED');
process.exit(0);
