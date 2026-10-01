import { db, getSettings } from './db.js';
import { ledger, todayStr } from './billing.js';
import { bad, wrap, str, cents, dateOk, esc, money, csvCell, needUser, needLandlord, tenantOr404, acctId, logActivity, removeStored } from './lib.js';

export const EXPENSE_CATEGORIES = ['mortgage interest', 'HOA dues', 'property tax', 'insurance', 'repairs & maintenance',
  'utilities', 'supplies', 'professional fees', 'advertising', 'travel', 'other'];

const sumKinds = rows => rows.reduce((s, r) => s + (r.kind === 'received' || r.kind === 'interest' ? r.amount_cents : -r.amount_cents), 0);

function depositInfo(tenantId) {
  const entries = db.prepare(`SELECT d.*, u.name AS by_name FROM deposit_entries d LEFT JOIN users u ON u.id=d.created_by
    WHERE d.tenant_id=? ORDER BY d.entry_date, d.id`).all(tenantId);
  const t = db.prepare('SELECT lease_end FROM users WHERE id=?').get(tenantId);
  const held = sumKinds(entries);
  let return_due_by = null;
  if (held > 0 && t?.lease_end) {
    const days = parseInt(getSettings().deposit_return_days || '30', 10);
    const d = new Date(t.lease_end + 'T00:00:00'); d.setDate(d.getDate() + days);
    return_due_by = todayStr(d);
  }
  return { entries, held_cents: held, return_due_by };
}

const PAGE_CSS = `body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:30px auto;padding:0 20px;color:#111}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:24px 0 8px}table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #ddd}th{font-size:12px;text-transform:uppercase;color:#555}
.r{text-align:right}.mute{color:#666}.box{border:1px solid #ccc;border-radius:8px;padding:14px;margin:14px 0}
button{padding:8px 14px;font:inherit;cursor:pointer}@media print{.noprint{display:none}body{margin:0}}`;
export const printPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>
<p class="noprint"><button id="print">Print / save as PDF</button></p>${body}<script src="/print.js"></script></body></html>`;

export function mountFinance(app) {
  // ----- security deposits -----
  app.get('/api/tenants/:id/deposit', needUser, needLandlord, wrap((req, res) => res.json(depositInfo(tenantOr404(req.params.id).id))));
  app.get('/api/me/deposit', needUser, wrap((req, res) => res.json(depositInfo(acctId(req.user)))));

  app.post('/api/tenants/:id/deposit', needUser, needLandlord, wrap((req, res) => {
    const t = tenantOr404(req.params.id);
    const b = req.body || {};
    if (!['received', 'deduction', 'refund', 'interest'].includes(b.kind)) bad('Choose a type');
    const amount = cents(b.amount);
    if (b.kind !== 'received' && b.kind !== 'interest' && amount > depositInfo(t.id).held_cents) bad('That is more than the deposit currently held');
    db.prepare('INSERT INTO deposit_entries(tenant_id,kind,amount_cents,note,entry_date,created_by) VALUES(?,?,?,?,?,?)')
      .run(t.id, b.kind, amount, str(b.note, 300), dateOk(b.date) ? b.date : todayStr(), req.user.id);
    logActivity(req.user.id, `Deposit ${b.kind}: ${money(amount)} for ${t.name}`, t.id);
    res.json({ ok: true });
  }));

  app.delete('/api/deposit/:id', needUser, needLandlord, wrap((req, res) => {
    const d = db.prepare('SELECT * FROM deposit_entries WHERE id=?').get(req.params.id) || bad('Entry not found', 404);
    db.prepare('DELETE FROM deposit_entries WHERE id=?').run(d.id);
    logActivity(req.user.id, `Removed a deposit entry (${d.kind} ${money(d.amount_cents)})`, d.tenant_id);
    res.json({ ok: true });
  }));

  // ----- expenses -----
  const year = req => (/^\d{4}$/.test(req.query.year) ? req.query.year : String(new Date().getFullYear()));

  app.get('/api/expenses', needUser, needLandlord, wrap((req, res) => {
    const y = year(req);
    res.json({
      categories: EXPENSE_CATEGORIES,
      expenses: db.prepare(`SELECT e.*, u.name AS by_name, (SELECT COUNT(*) FROM attachments a WHERE a.expense_id=e.id) AS receipts
        FROM expenses e LEFT JOIN users u ON u.id=e.created_by WHERE substr(e.expense_date,1,4)=? ORDER BY e.expense_date DESC, e.id DESC`).all(y),
    });
  }));

  app.post('/api/expenses', needUser, needLandlord, wrap((req, res) => {
    const b = req.body || {};
    const category = EXPENSE_CATEGORIES.includes(b.category) ? b.category : 'other';
    const amount = cents(b.amount);
    const r = db.prepare('INSERT INTO expenses(expense_date,category,vendor,description,amount_cents,created_by) VALUES(?,?,?,?,?,?)')
      .run(dateOk(b.date) ? b.date : todayStr(), category, str(b.vendor, 100), str(b.description, 300), amount, req.user.id);
    logActivity(req.user.id, `Added expense: ${category} ${money(amount)}`);
    res.json({ id: r.lastInsertRowid });
  }));

  app.delete('/api/expenses/:id', needUser, needLandlord, wrap((req, res) => {
    const e = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id) || bad('Expense not found', 404);
    for (const a of db.prepare('SELECT stored_name FROM attachments WHERE expense_id=?').all(e.id)) removeStored(a.stored_name);
    db.prepare('DELETE FROM attachments WHERE expense_id=?').run(e.id);
    db.prepare('DELETE FROM expenses WHERE id=?').run(e.id);
    logActivity(req.user.id, `Deleted expense: ${e.category} ${money(e.amount_cents)}`);
    res.json({ ok: true });
  }));

  app.get('/api/finance/summary', needUser, needLandlord, wrap((req, res) => {
    const y = year(req);
    const income = db.prepare(`SELECT substr(paid_date,6,2) AS m, SUM(amount_cents) AS c FROM payments
      WHERE status='confirmed' AND substr(paid_date,1,4)=? GROUP BY m ORDER BY m`).all(y);
    const exp = db.prepare('SELECT category, SUM(amount_cents) AS c FROM expenses WHERE substr(expense_date,1,4)=? GROUP BY category ORDER BY c DESC').all(y);
    const incomeTotal = income.reduce((s, r) => s + r.c, 0), expTotal = exp.reduce((s, r) => s + r.c, 0);
    res.json({ year: y, income_by_month: income, expenses_by_category: exp, income_cents: incomeTotal, expenses_cents: expTotal, net_cents: incomeTotal - expTotal });
  }));

  const csv = (res, name, header, rows) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    res.send([header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  };
  app.get('/api/finance/expenses.csv', needUser, needLandlord, wrap((req, res) => {
    const y = year(req);
    csv(res, `expenses-${y}.csv`, ['Date', 'Category', 'Vendor', 'Description', 'Amount'],
      db.prepare('SELECT * FROM expenses WHERE substr(expense_date,1,4)=? ORDER BY expense_date').all(y)
        .map(e => [e.expense_date, e.category, e.vendor, e.description, (e.amount_cents / 100).toFixed(2)]));
  }));
  app.get('/api/finance/income.csv', needUser, needLandlord, wrap((req, res) => {
    const y = year(req);
    csv(res, `income-${y}.csv`, ['Date', 'Tenant', 'Method', 'Reference', 'Amount'],
      db.prepare(`SELECT p.*, u.name AS tenant_name FROM payments p JOIN users u ON u.id=p.tenant_id
        WHERE p.status='confirmed' AND substr(p.paid_date,1,4)=? ORDER BY p.paid_date`).all(y)
        .map(p => [p.paid_date, p.tenant_name, p.method, p.reference, (p.amount_cents / 100).toFixed(2)]));
  }));

  // ----- printable receipt & statement -----
  app.get('/api/payments/:id/receipt', needUser, wrap((req, res) => {
    const p = db.prepare(`SELECT p.*, t.name AS tenant_name, t.unit, pb.name AS paid_by_name, rb.name AS reviewer
      FROM payments p JOIN users t ON t.id=p.tenant_id LEFT JOIN users pb ON pb.id=p.paid_by LEFT JOIN users rb ON rb.id=p.reviewed_by WHERE p.id=?`).get(req.params.id);
    if (!p || p.status !== 'confirmed' || (req.user.role === 'tenant' && p.tenant_id !== acctId(req.user))) bad('Receipt not available', 404);
    const s = getSettings();
    res.type('html').send(printPage(`Receipt #${p.id}`, `
      <h1>Payment receipt</h1><p class="mute">${esc(s.property_name || '')}${s.property_address ? ' · ' + esc(s.property_address) : ''}</p>
      <div class="box"><table>
        <tr><th>Receipt #</th><td>${p.id}</td></tr><tr><th>Date received</th><td>${esc(p.paid_date)}</td></tr>
        <tr><th>Received from</th><td>${esc(p.paid_by_name || p.tenant_name)}${p.unit ? ' (' + esc(p.unit) + ')' : ''}</td></tr>
        <tr><th>Amount</th><td><b>${money(p.amount_cents)}</b></td></tr><tr><th>Method</th><td>${esc(p.method)}</td></tr>
        ${p.reference ? `<tr><th>Reference</th><td>${esc(p.reference)}</td></tr>` : ''}
        ${p.reviewer ? `<tr><th>Confirmed by</th><td>${esc(p.reviewer)}</td></tr>` : ''}</table></div>
      <p class="mute">Thank you for your payment.</p>`));
  }));

  app.get('/api/statement', needUser, wrap((req, res) => {
    const id = req.user.role === 'landlord' ? tenantOr404(req.query.tenant_id).id : acctId(req.user);
    const t = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    const y = year(req);
    const l = ledger(id);
    const ev = [
      ...l.charges.map(c => ({ date: c.due_date, text: c.description, amt: c.amount_cents })),
      ...l.payments.filter(p => p.status === 'confirmed').map(p => ({ date: p.paid_date, text: `Payment (${p.method}${p.reference ? ', ' + p.reference : ''})`, amt: -p.amount_cents })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    let bal = ev.filter(e => e.date.slice(0, 4) < y).reduce((s, e) => s + e.amt, 0);
    const opening = bal;
    const rows = ev.filter(e => e.date.slice(0, 4) === y).map(e => { bal += e.amt; return `<tr><td>${esc(e.date)}</td><td>${esc(e.text)}</td>
      <td class="r">${e.amt > 0 ? money(e.amt) : ''}</td><td class="r">${e.amt < 0 ? money(-e.amt) : ''}</td><td class="r">${money(bal)}</td></tr>`; }).join('');
    const s = getSettings();
    res.type('html').send(printPage(`Statement ${y}`, `
      <h1>Account statement – ${esc(y)}</h1><p class="mute">${esc(s.property_name || '')}${s.property_address ? ' · ' + esc(s.property_address) : ''}</p>
      <p><b>${esc(t.name)}</b>${t.unit ? ' · ' + esc(t.unit) : ''}<br>Generated ${esc(todayStr())}</p>
      <table><thead><tr><th>Date</th><th>Description</th><th class="r">Charges</th><th class="r">Payments</th><th class="r">Balance</th></tr></thead>
      <tbody><tr><td></td><td class="mute">Balance brought forward</td><td></td><td></td><td class="r">${money(opening)}</td></tr>${rows}</tbody></table>
      <p class="r"><b>Balance at end of ${esc(y)} activity: ${money(bal)}</b></p>`));
  }));
}
