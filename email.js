import nodemailer from 'nodemailer';
import { db, getSettings } from './db.js';
import { ledger, todayStr } from './billing.js';
import { landlordEmails, householdEmails, money } from './lib.js';

// SMTP_URL e.g. smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com  (any SMTP provider works).
// MAIL_TRANSPORT=json is for tests: "sends" without a network.
const transport = process.env.MAIL_TRANSPORT === 'json' ? nodemailer.createTransport({ jsonTransport: true })
  : process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
export const emailConfigured = !!transport;
const FROM = process.env.MAIL_FROM || 'Rental Portal <no-reply@localhost>';

export const baseUrl = () =>
  (process.env.APP_URL || getSettings().app_url || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

/** Queue an email per recipient; the worker sends them so a slow/failing mail server never blocks a request. */
export function notify(to, subject, text) {
  const list = [...new Set([].concat(to).filter(Boolean).map(s => s.toLowerCase()))];
  const prop = getSettings().property_name || 'Rental Portal';
  const body = `${text}\n\n— ${prop}\n${baseUrl()}`;
  const ins = db.prepare('INSERT INTO email_queue(to_addr,subject,body) VALUES(?,?,?)');
  for (const addr of list) ins.run(addr, subject.slice(0, 200), body);
  if (list.length) setImmediate(sendPending);
}
export const link = hash => `${baseUrl()}/#${hash}`;

let sending = false;
export async function sendPending() {
  if (sending) return;
  sending = true;
  try {
    const rows = db.prepare("SELECT * FROM email_queue WHERE status='pending' ORDER BY id LIMIT 50").all();
    for (const m of rows) {
      if (!transport) { db.prepare("UPDATE email_queue SET status='unsent', error='Email is not set up (SMTP_URL missing)' WHERE id=?").run(m.id); continue; }
      try {
        await transport.sendMail({ from: FROM, to: m.to_addr, subject: m.subject, text: m.body });
        db.prepare("UPDATE email_queue SET status='sent', sent_at=CURRENT_TIMESTAMP, attempts=attempts+1, error=NULL WHERE id=?").run(m.id);
      } catch (e) {
        const failed = m.attempts + 1 >= 5;
        db.prepare('UPDATE email_queue SET status=?, attempts=attempts+1, error=? WHERE id=?')
          .run(failed ? 'failed' : 'pending', String(e.message).slice(0, 300), m.id);
      }
    }
  } finally { sending = false; }
}

// ---------- scheduled reminders (idempotent: each reminder is sent once) ----------
const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const daysUntil = (date, today) => dayNum(date) - dayNum(today);
const once = key => db.prepare('INSERT OR IGNORE INTO reminders_sent(key) VALUES(?)').run(key).changes === 1;

/** Sends only the smallest threshold crossed, marking larger ones done so a new lease doesn't trigger a burst. */
function thresholdOnce(prefix, days, thresholds) {
  if (days < 0) return null;
  const crossed = thresholds.filter(t => days <= t).sort((a, b) => a - b);
  if (!crossed.length) return null;
  let fire = null;
  for (const t of crossed.slice().reverse()) if (once(`${prefix}:${t}`)) fire = t;
  return fire;
}

export function runReminders(now = new Date()) {
  const today = todayStr(now);
  const s = getSettings();
  const lead = Math.max(0, parseInt(s.reminder_days ?? '3', 10));
  const tenants = db.prepare("SELECT * FROM users WHERE role='tenant' AND active=1 AND primary_id IS NULL").all();

  for (const t of tenants) {
    const to = householdEmails(t.id);

    if (t.email_reminders) {
      for (const c of ledger(t.id).charges) {
        if (c.remaining_cents <= 0 || c.status === 'credit') continue;
        const d = daysUntil(c.due_date, today);
        const what = `${c.description} (${money(c.remaining_cents)})`;
        if (d < 0 && d >= -6 && once(`late1:${c.id}`)) notify(to, `Past due: ${c.description}`, `This charge is past due: ${what}, due ${c.due_date}.\n\nPlease pay and report your payment here: ${link('/')}`);
        else if (d <= -7 && once(`late7:${c.id}`)) notify(to, `Still past due: ${c.description}`, `This charge is still unpaid: ${what}, due ${c.due_date}.\n\nPlease pay and report your payment here: ${link('/')}`);
        else if (d === 0 && once(`due:${c.id}`)) notify(to, `Due today: ${c.description}`, `Payment due today: ${what}.\n\nPay here: ${link('/')}`);
        else if (d > 0 && d <= lead && once(`pre:${c.id}`)) notify(to, `Upcoming: ${c.description}`, `Reminder: ${what} is due ${c.due_date} (in ${d} day${d === 1 ? '' : 's'}).\n\nPay here: ${link('/')}`);
      }
    }

    if (t.lease_end) {
      const fire = thresholdOnce(`lease:${t.id}:${t.lease_end}`, daysUntil(t.lease_end, today), [90, 60, 30]);
      if (fire) notify(landlordEmails(), `Lease ending in ${fire} days: ${t.name}`, `${t.name}'s lease ends ${t.lease_end}. Time to decide on renewal or listing the unit.\n\n${link('/tenants/' + t.id)}`);
    }
    if (t.insurance_expires) {
      const d = daysUntil(t.insurance_expires, today);
      if (d < 0) {
        if (once(`ins:${t.id}:${t.insurance_expires}:expired`)) notify([...landlordEmails(), ...to], `Renters insurance expired: ${t.name}`, `The renters insurance on file for ${t.name} expired ${t.insurance_expires}. Please upload the renewed policy under Documents.\n\n${link('/documents')}`);
      } else {
        const fire = thresholdOnce(`ins:${t.id}:${t.insurance_expires}`, d, [30, 7]);
        if (fire) notify([...landlordEmails(), ...to], `Renters insurance expires in ${fire} days: ${t.name}`, `Renters insurance for ${t.name} expires ${t.insurance_expires}. Please upload the renewed policy under Documents.\n\n${link('/documents')}`);
      }
    }
  }
}
