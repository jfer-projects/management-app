import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { db, getSettings, setSetting, DOCS_DIR } from './db.js';
import { ledger, runBilling, todayStr } from './billing.js';
import { mountWebhook, createCheckout, stripeEnabled } from './stripe.js';
import {
  HttpError, bad, wrap, sha, str, cents, dateOk, emailOk, money, hashPassword, verifyPassword, checkPassword, DUMMY_HASH, throttle,
  needUser, needLandlord, acctId, accountRow, tenantOr404, landlordEmails, householdEmails, logActivity, FILE_TYPES, saveUpload, sendStored, removeStored,
} from './lib.js';
import { notify, link, emailConfigured, sendPending, runReminders } from './email.js';
import { mountSecurity, verifySecondFactor, snapshot } from './security.js';
import { mountFinance } from './finance.js';
import { mountMedia } from './media.js';
import { mountExtras } from './extras.js';

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 14;
const PAY_METHODS = ['cashapp', 'venmo', 'zelle', 'wire', 'check', 'cash', 'other'];
const TICKET_STATUS = ['open', 'in_progress', 'resolved'];
const MAX_HOUSEHOLD = 4; // people with logins on one lease

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
});
mountWebhook(app); // raw body required, so this goes before express.json()
// Uploads are sent as raw bytes (metadata in the query string).
app.use(['/api/documents', '/api/attachments'], express.raw({ type: 'application/octet-stream', limit: '10mb' }));
app.use(express.json({ limit: '100kb' }));

// CSRF defense in depth (on top of SameSite=Lax cookies): state-changing requests must come from our own origin.
app.use('/api', (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.get('host')) return next(new HttpError(403, 'Cross-origin request blocked'));
  const ct = req.get('content-type');
  if (ct && !/^application\/(json|octet-stream)\b/i.test(ct)) return next(new HttpError(415, 'JSON required'));
  next();
});

// ---------- users & sessions ----------
const publicUser = u => u && ({
  id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, unit: u.unit,
  rent_cents: u.rent_cents, due_day: u.due_day, lease_start: u.lease_start, lease_end: u.lease_end,
  late_fee_cents: u.late_fee_cents, grace_days: u.grace_days, auto_confirm: !!u.auto_confirm,
  insurance_expires: u.insurance_expires, email_reminders: !!u.email_reminders,
  active: !!u.active, pending_invite: !!u.invite_token, primary_id: u.primary_id, totp_enabled: !!u.totp_enabled,
});
/** Extra people on a lease see the lease holder's terms. */
const sessionUser = u => (u?.primary_id ? { ...publicUser(u), ...leaseTerms(accountRow(u)) } : publicUser(u));
const leaseTerms = a => ({ unit: a.unit, rent_cents: a.rent_cents, due_day: a.due_day, lease_start: a.lease_start, lease_end: a.lease_end,
  late_fee_cents: a.late_fee_cents, grace_days: a.grace_days, auto_confirm: !!a.auto_confirm, insurance_expires: a.insurance_expires });

function startSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)')
    .run(sha(token), userId, Date.now() + SESSION_DAYS * 86400_000);
  res.cookie('sid', token, {
    httpOnly: true, sameSite: 'lax', secure: req.secure || process.env.NODE_ENV === 'production', maxAge: SESSION_DAYS * 86400_000, path: '/',
  });
}

function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

app.use('/api', (req, _res, next) => {
  const token = readCookie(req, 'sid');
  if (token) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires>? AND u.active=1`).get(sha(token), Date.now());
    if (row) req.user = row;
  }
  next();
});

// ---------- auth ----------
app.get('/api/session', wrap((req, res) => {
  const hasLandlord = !!db.prepare("SELECT 1 FROM users WHERE role='landlord'").get();
  res.json({
    user: sessionUser(req.user) || null, needsSetup: !hasLandlord, setupCodeRequired: !!process.env.SETUP_CODE,
    settings: req.user ? { ...getSettings(), stripe_enabled: stripeEnabled, email_configured: emailConfigured } : { property_name: getSettings().property_name || '' },
  });
}));

app.post('/api/setup', wrap((req, res) => {
  if (db.prepare("SELECT 1 FROM users WHERE role='landlord'").get()) bad('Setup already completed', 403);
  const { name, email, password, property_name, setup_code } = req.body || {};
  if (process.env.SETUP_CODE && setup_code !== process.env.SETUP_CODE) bad('Incorrect setup code', 403);
  throttle(`${req.ip}|setup`);
  if (!str(name) || !emailOk(str(email))) bad('Name and a valid email are required');
  checkPassword(password);
  const r = db.prepare("INSERT INTO users(role,name,email,password_hash) VALUES('landlord',?,?,?)")
    .run(str(name, 100), str(email, 200), hashPassword(password));
  setSetting('property_name', str(property_name, 100) || 'My Condo');
  startSession(res, req, r.lastInsertRowid);
  res.json({ ok: true });
}));

app.post('/api/login', wrap((req, res) => {
  const { email, password, code } = req.body || {};
  throttle(`${req.ip}|${str(email).toLowerCase()}`);
  throttle(`${req.ip}|any`, 30);
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(str(email, 200));
  // Always run a hash comparison so response time doesn't reveal whether the email exists.
  const ok = verifyPassword(String(password || ''), u?.password_hash || DUMMY_HASH);
  if (!u || !ok) bad('Incorrect email or password', 401);
  if (u.totp_enabled) {
    if (!code) return res.json({ totp_required: true });
    if (!verifySecondFactor(u, code)) bad('Incorrect code', 401);
  }
  startSession(res, req, u.id);
  res.json({ ok: true });
}));

app.post('/api/logout', wrap((req, res) => {
  const token = readCookie(req, 'sid');
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/invite/:token', wrap((req, res) => {
  const u = db.prepare('SELECT name,email FROM users WHERE invite_token=? AND active=1').get(req.params.token);
  if (!u) bad('This invite link is invalid or already used', 404);
  res.json(u);
}));

app.post('/api/invite/:token', wrap((req, res) => {
  throttle(`${req.ip}|invite`);
  const u = db.prepare('SELECT * FROM users WHERE invite_token=? AND active=1').get(req.params.token);
  if (!u) bad('This invite link is invalid or already used', 404);
  checkPassword(req.body?.password);
  db.prepare('UPDATE users SET password_hash=?, invite_token=NULL WHERE id=?').run(hashPassword(req.body.password), u.id);
  startSession(res, req, u.id);
  res.json({ ok: true });
}));

app.post('/api/password', needUser, wrap((req, res) => {
  const { current, password } = req.body || {};
  throttle(`${req.ip}|pw|${req.user.id}`);
  if (!verifyPassword(String(current || ''), req.user.password_hash)) bad('Current password is incorrect', 403);
  checkPassword(password);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), req.user.id);
  const keep = sha(readCookie(req, 'sid'));
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(req.user.id, keep);
  res.json({ ok: true });
}));

mountSecurity(app);

// ---------- settings, email status, activity ----------
const SETTING_KEYS = ['property_name', 'property_address', 'contact_info', 'cashapp_tag', 'venmo_handle',
  'zelle_contact', 'wire_instructions', 'payment_notes', 'app_url', 'reminder_days', 'deposit_return_days'];

app.put('/api/settings', needUser, needLandlord, wrap((req, res) => {
  for (const k of SETTING_KEYS) if (k in (req.body || {})) setSetting(k, str(req.body[k], 1000));
  logActivity(req.user.id, 'Updated settings');
  res.json({ ...getSettings(), stripe_enabled: stripeEnabled, email_configured: emailConfigured });
}));

app.get('/api/email/status', needUser, needLandlord, wrap((_req, res) => {
  res.json({ configured: emailConfigured, recent: db.prepare('SELECT id,to_addr,subject,status,error,created_at FROM email_queue ORDER BY id DESC LIMIT 25').all() });
}));
app.post('/api/email/test', needUser, needLandlord, wrap((req, res) => {
  notify(req.user.email, 'Test email', 'If you can read this, email notifications are working.');
  res.json({ ok: true });
}));

app.get('/api/activity', needUser, needLandlord, wrap((_req, res) => {
  res.json(db.prepare(`SELECT a.id, a.text, a.created_at, u.name AS user_name, t.name AS tenant_name FROM activity a
    LEFT JOIN users u ON u.id=a.user_id LEFT JOIN users t ON t.id=a.tenant_id ORDER BY a.id DESC LIMIT 100`).all());
}));

// ---------- landlords (you + your spouse) ----------
const landlordRow = id => db.prepare("SELECT * FROM users WHERE id=? AND role='landlord'").get(id) || bad('Landlord not found', 404);
app.get('/api/landlords', needUser, needLandlord, wrap((_req, res) => {
  res.json(db.prepare("SELECT id,name,email,active,totp_enabled,invite_token IS NOT NULL AS pending_invite FROM users WHERE role='landlord' ORDER BY id").all());
}));
app.post('/api/landlords', needUser, needLandlord, wrap((req, res) => {
  const name = str(req.body?.name, 100), email = str(req.body?.email, 200);
  if (!name || !emailOk(email)) bad('Name and a valid email are required');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) bad('A user with that email already exists');
  const token = crypto.randomBytes(24).toString('hex');
  const r = db.prepare("INSERT INTO users(role,name,email,invite_token) VALUES('landlord',?,?,?)").run(name, email, token);
  notify(email, `${req.user.name} invited you to manage ${getSettings().property_name || 'the property'}`, `Set your password here:\n\n${link('/invite/' + token)}`);
  logActivity(req.user.id, `Invited landlord ${name}`);
  res.json({ id: r.lastInsertRowid, invite_token: token });
}));
// Lockout recovery: another landlord issues a new invite link and clears 2FA.
app.post('/api/landlords/:id/reset', needUser, needLandlord, wrap((req, res) => {
  const l = landlordRow(req.params.id);
  if (l.id === req.user.id) bad('Use "Forgot password" for your own account');
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE users SET invite_token=?, password_hash=NULL, totp_enabled=0, totp_secret=NULL, recovery_codes=NULL WHERE id=?').run(token, l.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(l.id);
  logActivity(req.user.id, `Reset sign-in for landlord ${l.name}`);
  res.json({ invite_token: token });
}));
app.delete('/api/landlords/:id', needUser, needLandlord, wrap((req, res) => {
  const l = landlordRow(req.params.id);
  if (l.id === req.user.id) bad('You cannot deactivate yourself');
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(l.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(l.id);
  logActivity(req.user.id, `Deactivated landlord ${l.name}`);
  res.json({ ok: true });
}));

// ---------- tenants (landlord) ----------
const tenantFields = b => {
  const out = {
    name: str(b.name, 100), email: str(b.email, 200), phone: str(b.phone, 40), unit: str(b.unit, 40),
    rent_cents: b.rent ? cents(b.rent) : 0,
    due_day: Math.min(28, Math.max(1, parseInt(b.due_day, 10) || 1)),
    lease_start: dateOk(b.lease_start) ? b.lease_start : null,
    lease_end: dateOk(b.lease_end) ? b.lease_end : null,
    late_fee_cents: b.late_fee ? cents(b.late_fee) : 0,
    grace_days: Math.min(60, Math.max(0, parseInt(b.grace_days, 10) || 0)),
    auto_confirm: b.auto_confirm ? 1 : 0,
    insurance_expires: dateOk(b.insurance_expires) ? b.insurance_expires : null,
    email_reminders: b.email_reminders === false ? 0 : 1,
  };
  if (!out.name || !emailOk(out.email)) bad('Name and a valid email are required');
  return out;
};

const summarize = t => {
  const l = ledger(t.id);
  const members = db.prepare('SELECT name FROM users WHERE primary_id=? AND active=1').all(t.id).map(m => m.name);
  return { ...publicUser(t), members, balance_cents: l.balance_cents, overdue_cents: l.overdue_cents, pending_cents: l.pending_cents };
};

app.get('/api/tenants', needUser, needLandlord, wrap((_req, res) => {
  res.json(db.prepare("SELECT * FROM users WHERE role='tenant' AND primary_id IS NULL ORDER BY active DESC, name").all().map(summarize));
}));

const inviteMail = (name, email, token) => notify(email, `You're invited to the ${getSettings().property_name || 'tenant'} portal`,
  `Hi ${name.split(' ')[0]},\n\nYour landlords set up an online portal where you can see charges, pay rent, request repairs and find documents. Create your password here:\n\n${link('/invite/' + token)}`);

app.post('/api/tenants', needUser, needLandlord, wrap((req, res) => {
  const f = tenantFields(req.body || {});
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(f.email)) bad('A user with that email already exists');
  const token = crypto.randomBytes(24).toString('hex');
  const r = db.prepare(`INSERT INTO users(role,name,email,phone,unit,rent_cents,due_day,lease_start,lease_end,late_fee_cents,grace_days,auto_confirm,insurance_expires,email_reminders,invite_token)
    VALUES('tenant',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.name, f.email, f.phone, f.unit, f.rent_cents, f.due_day,
    f.lease_start, f.lease_end, f.late_fee_cents, f.grace_days, f.auto_confirm, f.insurance_expires, f.email_reminders, token);
  runBilling();
  inviteMail(f.name, f.email, token);
  logActivity(req.user.id, `Added tenant ${f.name}`, r.lastInsertRowid);
  res.json({ id: r.lastInsertRowid, invite_token: token });
}));

const members = id => db.prepare('SELECT id,name,email,phone,active,invite_token IS NOT NULL AS pending_invite FROM users WHERE primary_id=? ORDER BY id').all(id);

app.get('/api/tenants/:id', needUser, needLandlord, wrap((req, res) => {
  const t = tenantOr404(req.params.id);
  res.json({ tenant: summarize(t), invite_token: t.invite_token, members: members(t.id), ...ledger(t.id) });
}));

app.put('/api/tenants/:id', needUser, needLandlord, wrap((req, res) => {
  const t = tenantOr404(req.params.id);
  const f = tenantFields(req.body || {});
  if (db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(f.email, t.id)) bad('A user with that email already exists');
  const active = req.body.active === false ? 0 : 1;
  db.prepare(`UPDATE users SET name=?,email=?,phone=?,unit=?,rent_cents=?,due_day=?,lease_start=?,lease_end=?,late_fee_cents=?,grace_days=?,auto_confirm=?,insurance_expires=?,email_reminders=?,active=? WHERE id=?`)
    .run(f.name, f.email, f.phone, f.unit, f.rent_cents, f.due_day, f.lease_start, f.lease_end,
      f.late_fee_cents, f.grace_days, f.auto_confirm, f.insurance_expires, f.email_reminders, active, t.id);
  if (!active) {
    db.prepare('UPDATE users SET active=0 WHERE primary_id=?').run(t.id);
    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id=? OR primary_id=?)').run(t.id, t.id);
  }
  runBilling();
  logActivity(req.user.id, `Updated ${f.name}'s lease terms${active ? '' : ' and deactivated the account'}`, t.id);
  res.json({ ok: true });
}));

// Reset someone's sign-in (primary tenant or a person on the lease): new invite link, password and 2FA cleared.
app.post('/api/tenants/:id/invite', needUser, needLandlord, wrap((req, res) => {
  const t = db.prepare("SELECT * FROM users WHERE id=? AND role='tenant'").get(req.params.id) || bad('Tenant not found', 404);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE users SET invite_token=?, password_hash=NULL, totp_enabled=0, totp_secret=NULL, recovery_codes=NULL WHERE id=?').run(token, t.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.id);
  inviteMail(t.name, t.email, token);
  logActivity(req.user.id, `Reset sign-in for ${t.name}`, acctId(t));
  res.json({ invite_token: token });
}));

app.post('/api/tenants/:id/members', needUser, needLandlord, wrap((req, res) => {
  const t = tenantOr404(req.params.id);
  const name = str(req.body?.name, 100), email = str(req.body?.email, 200);
  if (!name || !emailOk(email)) bad('Name and a valid email are required');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) bad('A user with that email already exists');
  if (members(t.id).filter(m => m.active).length + 1 >= MAX_HOUSEHOLD) bad(`A lease can have up to ${MAX_HOUSEHOLD} people with logins`);
  const token = crypto.randomBytes(24).toString('hex');
  const r = db.prepare("INSERT INTO users(role,name,email,phone,primary_id,invite_token) VALUES('tenant',?,?,?,?,?)").run(name, email, str(req.body?.phone, 40), t.id, token);
  inviteMail(name, email, token);
  logActivity(req.user.id, `Added ${name} to ${t.name}'s lease`, t.id);
  res.json({ id: r.lastInsertRowid, invite_token: token });
}));

app.delete('/api/members/:id', needUser, needLandlord, wrap((req, res) => {
  const m = db.prepare("SELECT * FROM users WHERE id=? AND role='tenant' AND primary_id IS NOT NULL").get(req.params.id) || bad('Person not found', 404);
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(m.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(m.id);
  logActivity(req.user.id, `Removed ${m.name} from the lease`, m.primary_id);
  res.json({ ok: true });
}));

// ---------- charges (landlord) ----------
app.post('/api/tenants/:id/charges', needUser, needLandlord, wrap((req, res) => {
  const t = tenantOr404(req.params.id);
  const { description, amount, due_date, type } = req.body || {};
  if (!str(description)) bad('Description is required');
  const due = dateOk(due_date) ? due_date : todayStr();
  const amt = cents(amount, { allowNegative: true });
  const r = db.prepare('INSERT INTO charges(tenant_id,type,description,amount_cents,due_date) VALUES(?,?,?,?,?)')
    .run(t.id, str(type, 30) || 'other', str(description, 200), amt, due);
  logActivity(req.user.id, `Added ${amt < 0 ? 'credit' : 'charge'} "${str(description, 80)}" ${money(amt)} for ${t.name}`, t.id);
  res.json({ id: r.lastInsertRowid });
}));

app.delete('/api/charges/:id', needUser, needLandlord, wrap((req, res) => {
  const c = db.prepare('SELECT * FROM charges WHERE id=? AND voided=0').get(req.params.id) || bad('Charge not found', 404);
  db.prepare('UPDATE charges SET voided=1 WHERE id=?').run(c.id);
  logActivity(req.user.id, `Voided charge "${c.description}" ${money(c.amount_cents)}`, c.tenant_id);
  res.json({ ok: true });
}));

// ---------- payments ----------
const paymentRows = () => db.prepare(`SELECT p.*, u.name AS tenant_name, pb.name AS paid_by_name, rb.name AS reviewed_by_name FROM payments p
  JOIN users u ON u.id=p.tenant_id LEFT JOIN users pb ON pb.id=p.paid_by LEFT JOIN users rb ON rb.id=p.reviewed_by
  ORDER BY (p.status='pending') DESC, p.paid_date DESC, p.id DESC LIMIT 500`);

app.get('/api/payments', needUser, needLandlord, wrap((_req, res) => res.json(paymentRows().all())));

// Tenant reports a payment they've sent; landlord records one received (auto-confirmed).
app.post('/api/payments', needUser, wrap((req, res) => {
  const b = req.body || {};
  const landlord = req.user.role === 'landlord';
  const acct = landlord ? tenantOr404(b.tenant_id) : accountRow(req.user);
  // 'ach' is reserved for payments confirmed by Stripe's webhook, never self-reported.
  const method = PAY_METHODS.includes(b.method) ? b.method : bad('Choose a payment method');
  const auto = landlord || acct.auto_confirm;
  const amount = cents(b.amount);
  const r = db.prepare(`INSERT INTO payments(tenant_id,amount_cents,method,reference,note,paid_date,status,reviewed_at,paid_by,reviewed_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(acct.id, amount, method, str(b.reference, 100), str(b.note, 300),
    dateOk(b.paid_date) ? b.paid_date : todayStr(), auto ? 'confirmed' : 'pending', auto ? new Date().toISOString() : null,
    landlord ? null : req.user.id, landlord ? req.user.id : null);
  if (landlord) logActivity(req.user.id, `Recorded ${method} payment ${money(amount)} from ${acct.name}`, acct.id);
  else if (!auto) notify(landlordEmails(), `Payment reported: ${req.user.name} ${money(amount)}`, `${req.user.name} says they paid ${money(amount)} by ${method}${b.reference ? ' (ref ' + str(b.reference, 100) + ')' : ''}. Check that it arrived, then confirm it here:\n\n${link('/payments')}`);
  res.json({ id: r.lastInsertRowid, status: auto ? 'confirmed' : 'pending' });
}));

app.post('/api/stripe/checkout', needUser, (req, res, next) => {
  createCheckout(req, res, bad, cents).catch(e => {
    if (e instanceof HttpError) return next(e);
    console.error('Stripe error:', e.message);
    next(new HttpError(502, 'Could not start the bank payment. Please try again.'));
  });
});

app.post('/api/payments/:id/review', needUser, needLandlord, wrap((req, res) => {
  const status = req.body?.status;
  if (!['confirmed', 'rejected'].includes(status)) bad('Invalid status');
  const p = db.prepare('SELECT p.*, u.name AS tenant_name FROM payments p JOIN users u ON u.id=p.tenant_id WHERE p.id=?').get(req.params.id) || bad('Payment not found', 404);
  db.prepare('UPDATE payments SET status=?, reviewed_at=?, reviewed_by=?, note=COALESCE(NULLIF(?,\'\'), note) WHERE id=?')
    .run(status, new Date().toISOString(), req.user.id, str(req.body.note, 300), p.id);
  logActivity(req.user.id, `${status === 'confirmed' ? 'Confirmed' : 'Rejected'} ${money(p.amount_cents)} payment from ${p.tenant_name}`, p.tenant_id);
  notify(householdEmails(p.tenant_id), status === 'confirmed' ? `Payment confirmed: ${money(p.amount_cents)}` : `Payment not received: ${money(p.amount_cents)}`,
    status === 'confirmed' ? `Your landlords confirmed your ${money(p.amount_cents)} payment. Thank you! A receipt is under Charges & payments.\n\n${link('/ledger')}`
      : `We could not match the ${money(p.amount_cents)} payment you reported. Please check the details or contact your landlords.\n\n${link('/ledger')}`);
  res.json({ ok: true });
}));

// ---------- tenant self-service ----------
app.get('/api/me/ledger', needUser, wrap((req, res) => {
  if (req.user.role !== 'tenant') bad('Tenant accounts only', 403);
  const id = acctId(req.user);
  res.json({
    tenant: publicUser(accountRow(req.user)),
    household: db.prepare('SELECT id,name FROM users WHERE active=1 AND (id=? OR primary_id=?) ORDER BY primary_id IS NOT NULL, id').all(id, id),
    ...ledger(id),
  });
}));

// Tenants may update their own contact details and reminder preference.
app.put('/api/me', needUser, wrap((req, res) => {
  const b = req.body || {};
  db.prepare('UPDATE users SET phone=?, email_reminders=? WHERE id=?').run(str(b.phone, 40), b.email_reminders === false ? 0 : 1, req.user.id);
  res.json({ ok: true });
}));

// ---------- documents ----------
const DOC_TYPES = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'docx'];
const DOC_CATEGORIES = ['lease', 'addendum', 'notice', 'insurance', 'receipt', 'inspection', 'other'];

const docSelect = `SELECT d.id, d.tenant_id, d.name, d.category, d.ext, d.size, d.visible_to_tenant, d.uploaded_by, d.created_at,
  t.name AS tenant_name, u.name AS uploader_name, u.role AS uploader_role
  FROM documents d LEFT JOIN users t ON t.id=d.tenant_id JOIN users u ON u.id=d.uploaded_by`;

function canSeeDoc(user, d) {
  if (user.role === 'landlord') return true;
  return d.uploaded_by === user.id || (d.visible_to_tenant && (d.tenant_id === null || d.tenant_id === acctId(user)));
}

app.get('/api/documents', needUser, wrap((req, res) => {
  const rows = db.prepare(`${docSelect} ORDER BY d.created_at DESC, d.id DESC`).all()
    .filter(d => canSeeDoc(req.user, d))
    .filter(d => !req.query.tenant_id || String(d.tenant_id) === String(req.query.tenant_id));
  res.json(rows);
}));

app.post('/api/documents', needUser, wrap((req, res) => {
  const landlord = req.user.role === 'landlord';
  const f = saveUpload(req, DOC_TYPES, 'PDF, PNG, JPG, DOCX, TXT');
  let tenantId = null;
  if (landlord) {
    if (req.query.tenant_id && req.query.tenant_id !== 'all') tenantId = tenantOr404(req.query.tenant_id).id;
  } else tenantId = acctId(req.user); // tenants can only add to their own lease's file
  const category = landlord ? (DOC_CATEGORIES.includes(req.query.category) ? req.query.category : 'other')
    : (req.query.category === 'insurance' ? 'insurance' : 'other');
  const name = str(req.query.name, 150) || f.filename.replace(/\.[^.]+$/, '');
  const visible = !landlord || req.query.visible !== '0' ? 1 : 0;
  const r = db.prepare(`INSERT INTO documents(tenant_id,name,category,stored_name,ext,size,uploaded_by,visible_to_tenant)
    VALUES(?,?,?,?,?,?,?,?)`).run(tenantId, name, category, f.stored, f.ext, f.size, req.user.id, visible);
  logActivity(req.user.id, `${landlord ? 'Uploaded' : 'Tenant uploaded'} document "${name}"`, tenantId);
  if (!landlord) notify(landlordEmails(), `New document from ${req.user.name}`, `${req.user.name} uploaded "${name}".\n\n${link('/documents')}`);
  res.json({ id: r.lastInsertRowid });
}));

function docOr404(req) {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d || !canSeeDoc(req.user, d)) bad('Document not found', 404);
  return d;
}

app.get('/api/documents/:id/download', needUser, wrap((req, res) => {
  const d = docOr404(req);
  sendStored(res, d.stored_name, d.ext, d.name);
}));

app.delete('/api/documents/:id', needUser, wrap((req, res) => {
  const d = docOr404(req);
  if (req.user.role === 'tenant' && d.uploaded_by !== req.user.id) bad('Only the landlord can delete this', 403);
  db.prepare('DELETE FROM documents WHERE id=?').run(d.id);
  removeStored(d.stored_name);
  logActivity(req.user.id, `Deleted document "${d.name}"`, d.tenant_id);
  res.json({ ok: true });
}));

// ---------- tickets ----------
const ticketSelect = `SELECT t.*, u.name AS tenant_name, u.unit AS unit, cb.name AS created_by_name, v.name AS vendor_name,
  (SELECT COUNT(*) FROM ticket_comments c WHERE c.ticket_id=t.id AND (c.internal=0 OR ?)) AS comment_count
  FROM tickets t JOIN users u ON u.id=t.tenant_id LEFT JOIN users cb ON cb.id=t.created_by LEFT JOIN vendors v ON v.id=t.vendor_id`;
// Which vendor handled a job and what it cost is landlord-only.
const forViewer = (user, t) => (user.role === 'landlord' ? t : { ...t, vendor_id: undefined, vendor_name: undefined, cost_cents: undefined });

function ticketOr404(req) {
  const t = db.prepare(`${ticketSelect} WHERE t.id=?`).get(req.user.role === 'landlord' ? 1 : 0, req.params.id);
  if (!t || (req.user.role === 'tenant' && t.tenant_id !== acctId(req.user))) bad('Ticket not found', 404);
  return t;
}

app.get('/api/tickets', needUser, wrap((req, res) => {
  const L = req.user.role === 'landlord';
  const rows = L
    ? db.prepare(`${ticketSelect} ORDER BY (t.status='resolved'), t.updated_at DESC`).all(1)
    : db.prepare(`${ticketSelect} WHERE t.tenant_id=? ORDER BY (t.status='resolved'), t.updated_at DESC`).all(0, acctId(req.user));
  res.json(rows.map(t => forViewer(req.user, t)));
}));

app.post('/api/tickets', needUser, wrap((req, res) => {
  if (req.user.role !== 'tenant') bad('Only tenants can open tickets', 403);
  const b = req.body || {};
  if (!str(b.title) || !str(b.description, 4000)) bad('Title and description are required');
  const priority = ['low', 'normal', 'urgent'].includes(b.priority) ? b.priority : 'normal';
  const r = db.prepare('INSERT INTO tickets(tenant_id,created_by,title,description,category,priority) VALUES(?,?,?,?,?,?)')
    .run(acctId(req.user), req.user.id, str(b.title, 150), str(b.description, 4000),
      ['plumbing', 'electrical', 'appliance', 'hvac', 'noise', 'other'].includes(b.category) ? b.category : 'other', priority);
  notify(landlordEmails(), `${priority === 'urgent' ? 'URGENT: ' : ''}New request: ${str(b.title, 100)}`, `${req.user.name} opened a ticket:\n\n${str(b.description, 600)}\n\n${link('/tickets/' + r.lastInsertRowid)}`);
  res.json({ id: r.lastInsertRowid });
}));

app.get('/api/tickets/:id', needUser, wrap((req, res) => {
  const ticket = ticketOr404(req);
  const L = req.user.role === 'landlord';
  const comments = db.prepare(`SELECT c.*, u.name, u.role FROM ticket_comments c JOIN users u ON u.id=c.user_id
    WHERE c.ticket_id=? ${L ? '' : 'AND c.internal=0'} ORDER BY c.id`).all(ticket.id);
  res.json({ ticket: forViewer(req.user, ticket), comments });
}));

app.post('/api/tickets/:id/comments', needUser, wrap((req, res) => {
  const t = ticketOr404(req);
  const L = req.user.role === 'landlord';
  const body = str(req.body?.body, 4000);
  if (!body) bad('Comment cannot be empty');
  const internal = L && req.body.internal ? 1 : 0; // private landlord notes never reach tenants
  db.prepare('INSERT INTO ticket_comments(ticket_id,user_id,body,internal) VALUES(?,?,?,?)').run(t.id, req.user.id, body, internal);
  // A tenant reply reopens a resolved ticket.
  db.prepare("UPDATE tickets SET updated_at=CURRENT_TIMESTAMP, status=CASE WHEN status='resolved' AND ?='tenant' THEN 'open' ELSE status END WHERE id=?").run(req.user.role, t.id);
  if (!L) notify(landlordEmails(), `Reply on: ${t.title}`, `${req.user.name} wrote:\n\n${body.slice(0, 600)}\n\n${link('/tickets/' + t.id)}`);
  else if (!internal) notify(householdEmails(t.tenant_id), `Update on your request: ${t.title}`, `${req.user.name} wrote:\n\n${body.slice(0, 600)}\n\n${link('/tickets/' + t.id)}`);
  res.json({ ok: true });
}));

app.put('/api/tickets/:id/status', needUser, wrap((req, res) => {
  const t = ticketOr404(req);
  const status = req.body?.status;
  if (!TICKET_STATUS.includes(status)) bad('Invalid status');
  // Tenants may only mark their own ticket resolved/reopened.
  if (req.user.role === 'tenant' && status === 'in_progress') bad('Only the landlord can do that', 403);
  db.prepare('UPDATE tickets SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, t.id);
  if (req.user.role === 'landlord' && status !== t.status) notify(householdEmails(t.tenant_id), `Request ${status.replace('_', ' ')}: ${t.title}`, `Your request "${t.title}" is now ${status.replace('_', ' ')}.\n\n${link('/tickets/' + t.id)}`);
  res.json({ ok: true });
}));

// ---------- landlord dashboard ----------
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

app.get('/api/dashboard', needUser, needLandlord, wrap((_req, res) => {
  const rows = db.prepare("SELECT * FROM users WHERE role='tenant' AND primary_id IS NULL AND active=1").all();
  const tenants = rows.map(summarize);
  const today = todayStr();
  const attention = [];
  for (const t of rows) {
    if (t.lease_end) { const d = dayDiff(t.lease_end, today); if (d >= 0 && d <= 90) attention.push({ kind: 'lease', tenant_id: t.id, name: t.name, date: t.lease_end, days: d }); }
    if (t.insurance_expires) { const d = dayDiff(t.insurance_expires, today); if (d <= 30) attention.push({ kind: 'insurance', tenant_id: t.id, name: t.name, date: t.insurance_expires, days: d }); }
  }
  const lastBackup = getSettings().last_backup_download;
  if (!lastBackup || Date.now() - Date.parse(lastBackup) > 30 * 86400_000) attention.push({ kind: 'backup', date: lastBackup || null });
  if (!emailConfigured) attention.push({ kind: 'email' });
  res.json({
    outstanding_cents: tenants.reduce((s, t) => s + Math.max(0, t.balance_cents), 0),
    overdue_cents: tenants.reduce((s, t) => s + t.overdue_cents, 0),
    pending_payments: db.prepare("SELECT COUNT(*) n FROM payments WHERE status='pending'").get().n,
    open_tickets: db.prepare("SELECT COUNT(*) n FROM tickets WHERE status<>'resolved'").get().n,
    collected_this_month_cents: db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE status='confirmed' AND paid_date>=?")
      .get(todayStr().slice(0, 8) + '01').s,
    attention, tenants,
  });
}));

mountFinance(app);
mountMedia(app);
mountExtras(app);

// ---------- static + errors ----------
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, 'public')));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  // A failed file download must never be cached or look like the file it was meant to be.
  res.set('Cache-Control', 'no-store');
  res.removeHeader('Content-Disposition');
  res.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File is too large (max 10 MB)' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

function housekeeping() {
  for (const job of [runBilling, runReminders, snapshot, () => {
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    db.prepare('DELETE FROM password_resets WHERE expires<?').run(Date.now());
  }, sendPending]) {
    try { job(); } catch (e) { console.error('Background job failed:', e.message); }
  }
}
housekeeping();
setInterval(housekeeping, 3600_000).unref();
setInterval(() => sendPending().catch(() => {}), 60_000).unref();

export default app;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => console.log(`Rental app running on http://localhost:${PORT}`));
}
