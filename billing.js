import { db } from './db.js';

export const pad = n => String(n).padStart(2, '0');
export const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return todayStr(new Date(y, m - 1, d + n));
}

function dueDateFor(year, month, day) {
  const last = new Date(year, month, 0).getDate();
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}

/** Monthly rent due dates for a tenant over the given month offsets, honoring lease bounds. */
function rentSchedule(t, now, offsets) {
  const out = [];
  for (const offset of offsets) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const due = dueDateFor(d.getFullYear(), d.getMonth() + 1, t.due_day);
    if (t.lease_start && due < t.lease_start.slice(0, 7) + '-01') continue;
    if (t.lease_end && due > t.lease_end) continue;
    out.push({
      due, period: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
      label: d.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    });
  }
  return out;
}

/**
 * Applies confirmed payments to charges oldest-first (late fees and rent alike),
 * so a tenant's balance is simply charges minus confirmed payments.
 */
export function ledger(tenantId) {
  const charges = db.prepare('SELECT * FROM charges WHERE tenant_id=? AND voided=0 ORDER BY due_date, id').all(tenantId);
  const payments = db.prepare(`SELECT p.*, pb.name AS paid_by_name, rb.name AS reviewed_by_name FROM payments p
    LEFT JOIN users pb ON pb.id=p.paid_by LEFT JOIN users rb ON rb.id=p.reviewed_by
    WHERE p.tenant_id=? ORDER BY p.paid_date DESC, p.id DESC`).all(tenantId);
  const confirmed = payments.filter(p => p.status === 'confirmed').reduce((s, p) => s + p.amount_cents, 0);
  const pending = payments.filter(p => p.status === 'pending').reduce((s, p) => s + p.amount_cents, 0);
  const today = todayStr();

  let credit = confirmed;
  const rows = charges.map(c => {
    // Credits (negative charges) always reduce what's owed, not consume payments.
    if (c.amount_cents <= 0) return { ...c, paid_cents: 0, remaining_cents: c.amount_cents, status: 'credit' };
    const applied = Math.min(credit, c.amount_cents);
    credit -= applied;
    const remaining = c.amount_cents - applied;
    const status = remaining === 0 ? 'paid' : c.due_date < today ? 'overdue' : applied > 0 ? 'partial' : 'due';
    return { ...c, paid_cents: applied, remaining_cents: remaining, status };
  });

  // Rent that will be billed in future months but has no charge row yet (through lease end, max 12 months).
  const t = db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(tenantId);
  const existing = new Set(db.prepare("SELECT period FROM charges WHERE tenant_id=? AND type='rent' AND period IS NOT NULL")
    .all(tenantId).map(r => r.period));
  const scheduled = t && t.rent_cents > 0
    ? rentSchedule(t, new Date(), Array.from({ length: 13 }, (_, i) => i))
      .filter(r => !existing.has(r.period) && r.due > today)
      .map(r => ({ id: null, type: 'rent', description: `Rent – ${r.label}`, amount_cents: t.rent_cents, due_date: r.due, status: 'scheduled' }))
    : [];

  // Balance only counts charges already due; future rent shows under "upcoming" until its due date.
  const totalCharges = charges.filter(c => c.due_date <= today).reduce((s, c) => s + c.amount_cents, 0);
  return {
    scheduled,
    charges: rows.reverse(),
    payments,
    balance_cents: totalCharges - confirmed,
    pending_cents: pending,
    overdue_cents: rows.filter(r => r.status === 'overdue').reduce((s, r) => s + r.remaining_cents, 0),
  };
}

/** Idempotent: safe to call at startup and on a timer. */
export function runBilling(now = new Date()) {
  const tenants = db.prepare("SELECT * FROM users WHERE role='tenant' AND active=1 AND rent_cents>0").all();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO charges(tenant_id,type,description,amount_cents,due_date,period) VALUES(?,?,?,?,?,?)");
  const today = todayStr(now);

  for (const t of tenants) {
    for (const r of rentSchedule(t, now, [0, 1])) {
      insert.run(t.id, 'rent', `Rent – ${r.label}`, t.rent_cents, r.due, r.period);
    }

    if (t.late_fee_cents > 0) {
      for (const c of ledger(t.id).charges) {
        if (c.type !== 'rent' || c.status !== 'overdue') continue;
        if (addDays(c.due_date, t.grace_days) >= today) continue;
        insert.run(t.id, 'late_fee', `Late fee – ${c.description.replace('Rent – ', '')}`,
          t.late_fee_cents, today, c.period);
      }
    }
  }
}
