import { db, getSettings, setSetting } from './db.js';
import { todayStr } from './billing.js';
import { bad, wrap, str, cents, dateOk, emailOk, money, needUser, needLandlord, tenantOr404, householdEmails, logActivity } from './lib.js';
import { notify, link } from './email.js';

// Announcements, lease renewals / rent changes, vendors, and the tenant-facing "home guide".
export function mountExtras(app) {
  // ----- announcements -----
  app.get('/api/announcements', needUser, wrap((_req, res) => {
    res.json(db.prepare(`SELECT a.id,a.title,a.body,a.created_at,u.name AS by_name FROM announcements a
      LEFT JOIN users u ON u.id=a.created_by ORDER BY a.id DESC LIMIT 50`).all());
  }));

  app.post('/api/announcements', needUser, needLandlord, wrap((req, res) => {
    const title = str(req.body?.title, 150), body = str(req.body?.body, 4000);
    if (!title || !body) bad('Add a title and a message');
    const r = db.prepare('INSERT INTO announcements(title,body,created_by) VALUES(?,?,?)').run(title, body, req.user.id);
    if (req.body.email) {
      const tenants = db.prepare("SELECT id FROM users WHERE role='tenant' AND primary_id IS NULL AND active=1").all();
      notify(tenants.flatMap(t => householdEmails(t.id)), title, `${body}\n\n${link('/')}`);
    }
    logActivity(req.user.id, `Posted announcement "${title}"${req.body.email ? ' (emailed tenants)' : ''}`);
    res.json({ id: r.lastInsertRowid });
  }));

  app.delete('/api/announcements/:id', needUser, needLandlord, wrap((req, res) => {
    const r = db.prepare('DELETE FROM announcements WHERE id=?').run(req.params.id);
    if (!r.changes) bad('Announcement not found', 404);
    res.json({ ok: true });
  }));

  // ----- lease renewal / rent change -----
  app.get('/api/tenants/:id/lease-history', needUser, needLandlord, wrap((req, res) => {
    const t = tenantOr404(req.params.id);
    res.json(db.prepare(`SELECT h.*, u.name AS by_name FROM lease_history h LEFT JOIN users u ON u.id=h.created_by
      WHERE h.tenant_id=? ORDER BY h.id DESC`).all(t.id));
  }));

  app.post('/api/tenants/:id/renew', needUser, needLandlord, wrap((req, res) => {
    const t = tenantOr404(req.params.id);
    const b = req.body || {};
    if (!dateOk(b.new_end)) bad('Choose the new lease end date');
    if (t.lease_end && b.new_end <= t.lease_end && !b.rent) bad('The new end date must be after the current one');
    const newRent = b.rent ? cents(b.rent) : t.rent_cents;
    const effective = dateOk(b.effective_date) ? b.effective_date : (t.lease_end ? nextDay(t.lease_end) : todayStr());
    db.prepare('UPDATE users SET lease_end=?, rent_cents=? WHERE id=?').run(b.new_end, newRent, t.id);
    // Rent already billed for months on/after the effective date moves to the new amount.
    if (newRent !== t.rent_cents) {
      db.prepare("UPDATE charges SET amount_cents=? WHERE tenant_id=? AND type='rent' AND voided=0 AND due_date>=?").run(newRent, t.id, effective);
    }
    db.prepare('INSERT INTO lease_history(tenant_id,old_end,new_end,old_rent_cents,new_rent_cents,effective_date,note,created_by) VALUES(?,?,?,?,?,?,?,?)')
      .run(t.id, t.lease_end, b.new_end, t.rent_cents, newRent, effective, str(b.note, 300), req.user.id);
    logActivity(req.user.id, `Renewed ${t.name}'s lease to ${b.new_end}${newRent !== t.rent_cents ? ` and changed rent to ${money(newRent)}` : ''}`, t.id);
    if (b.email) {
      notify(householdEmails(t.id), 'Your lease renewal', `Your lease now runs until ${b.new_end}.${newRent !== t.rent_cents ? `\nMonthly rent: ${money(newRent)}, effective ${effective}.` : ''}${b.note ? '\n\n' + str(b.note, 300) : ''}\n\nDetails are under your account: ${link('/account')}`);
    }
    res.json({ ok: true });
  }));

  // ----- vendors -----
  app.get('/api/vendors', needUser, needLandlord, wrap((_req, res) => {
    res.json(db.prepare(`SELECT v.*, (SELECT COUNT(*) FROM tickets t WHERE t.vendor_id=v.id) AS jobs,
      (SELECT COALESCE(SUM(t.cost_cents),0) FROM tickets t WHERE t.vendor_id=v.id) AS spent_cents FROM vendors v ORDER BY v.name`).all());
  }));

  const vendorFields = b => {
    const v = { name: str(b?.name, 100), trade: str(b?.trade, 60), phone: str(b?.phone, 40), email: str(b?.email, 200), notes: str(b?.notes, 1000) };
    if (!v.name) bad('Vendor name is required');
    if (v.email && !emailOk(v.email)) bad('That email address looks wrong');
    return v;
  };
  app.post('/api/vendors', needUser, needLandlord, wrap((req, res) => {
    const v = vendorFields(req.body);
    const r = db.prepare('INSERT INTO vendors(name,trade,phone,email,notes) VALUES(?,?,?,?,?)').run(v.name, v.trade, v.phone, v.email, v.notes);
    res.json({ id: r.lastInsertRowid });
  }));
  app.put('/api/vendors/:id', needUser, needLandlord, wrap((req, res) => {
    const v = vendorFields(req.body);
    const r = db.prepare('UPDATE vendors SET name=?,trade=?,phone=?,email=?,notes=? WHERE id=?').run(v.name, v.trade, v.phone, v.email, v.notes, req.params.id);
    if (!r.changes) bad('Vendor not found', 404);
    res.json({ ok: true });
  }));
  app.delete('/api/vendors/:id', needUser, needLandlord, wrap((req, res) => {
    db.prepare('UPDATE tickets SET vendor_id=NULL WHERE vendor_id=?').run(req.params.id);
    db.prepare('DELETE FROM vendors WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  }));

  // Assign a vendor and record the cost of a repair (landlord-only; tenants never see either).
  app.put('/api/tickets/:id/work', needUser, needLandlord, wrap((req, res) => {
    const t = db.prepare('SELECT id FROM tickets WHERE id=?').get(req.params.id) || bad('Ticket not found', 404);
    const vendorId = req.body?.vendor_id ? Number(req.body.vendor_id) : null;
    if (vendorId && !db.prepare('SELECT 1 FROM vendors WHERE id=?').get(vendorId)) bad('Vendor not found', 404);
    const cost = req.body?.cost === '' || req.body?.cost == null ? null : cents(req.body.cost);
    db.prepare('UPDATE tickets SET vendor_id=?, cost_cents=? WHERE id=?').run(vendorId, cost, t.id);
    res.json({ ok: true });
  }));

  // ----- home guide (tenant-facing house info) -----
  const GUIDE_FIELDS = ['welcome', 'trash', 'parking', 'quiet_hours', 'laundry', 'internet', 'emergency', 'utilities', 'appliances', 'other'];
  const readGuide = () => { try { return JSON.parse(getSettings().home_guide || '{}'); } catch { return {}; } };
  app.get('/api/home-guide', needUser, wrap((_req, res) => res.json(readGuide())));
  app.put('/api/home-guide', needUser, needLandlord, wrap((req, res) => {
    const out = {};
    for (const k of GUIDE_FIELDS) out[k] = str(req.body?.[k], 3000);
    setSetting('home_guide', JSON.stringify(out));
    logActivity(req.user.id, 'Updated the tenant home guide');
    res.json(out);
  }));

  // Small counts for the sidebar badges.
  app.get('/api/counts', needUser, needLandlord, wrap((_req, res) => {
    res.json({
      pending_payments: db.prepare("SELECT COUNT(*) n FROM payments WHERE status='pending'").get().n,
      open_tickets: db.prepare("SELECT COUNT(*) n FROM tickets WHERE status<>'resolved'").get().n,
    });
  }));
}

function nextDay(d) {
  const [y, m, day] = d.split('-').map(Number);
  return todayStr(new Date(y, m - 1, day + 1));
}
