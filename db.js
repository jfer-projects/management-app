import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(process.env.DB_FILE || path.join(dir, 'rental.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('landlord','tenant')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  unit TEXT,
  password_hash TEXT,
  invite_token TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  rent_cents INTEGER NOT NULL DEFAULT 0,
  due_day INTEGER NOT NULL DEFAULT 1,
  lease_start TEXT,
  lease_end TEXT,
  late_fee_cents INTEGER NOT NULL DEFAULT 0,
  grace_days INTEGER NOT NULL DEFAULT 5,
  auto_confirm INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  period TEXT,
  voided INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS charges_period ON charges(tenant_id, type, period) WHERE period IS NOT NULL;
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  note TEXT,
  paid_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER REFERENCES users(id),      -- NULL = property-wide, visible to every tenant
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  stored_name TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  visible_to_tenant INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_queue (
  id INTEGER PRIMARY KEY,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed | unsent (email not configured)
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT
);
CREATE TABLE IF NOT EXISTS reminders_sent (key TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  tenant_id INTEGER REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS deposit_entries (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('received','deduction','refund','interest')),
  amount_cents INTEGER NOT NULL,
  note TEXT,
  entry_date TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  expense_date TEXT NOT NULL,
  category TEXT NOT NULL,
  vendor TEXT,
  description TEXT,
  amount_cents INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('move_in','move_out')),
  inspect_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shared')),
  notes TEXT,
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  tenant_comment TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inspection_items (
  id INTEGER PRIMARY KEY,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  area TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('good','fair','poor','damaged','n/a')),
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
-- Photos/files attached to a ticket, inspection item, expense, or the property listing.
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES inspection_items(id) ON DELETE CASCADE,
  expense_id INTEGER REFERENCES expenses(id) ON DELETE CASCADE,
  listing INTEGER NOT NULL DEFAULT 0,
  caption TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  trade TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lease_history (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES users(id),
  old_end TEXT, new_end TEXT,
  old_rent_cents INTEGER, new_rent_cents INTEGER,
  effective_date TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function addColumn(table, col, def) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('users', 'primary_id', 'INTEGER');            // set on additional people sharing a lease
addColumn('users', 'totp_secret', 'TEXT');
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'totp_last', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'recovery_codes', 'TEXT');
addColumn('users', 'insurance_expires', 'TEXT');
addColumn('users', 'email_reminders', 'INTEGER NOT NULL DEFAULT 1');
addColumn('payments', 'paid_by', 'INTEGER');
addColumn('payments', 'reviewed_by', 'INTEGER');
addColumn('tickets', 'created_by', 'INTEGER');
addColumn('tickets', 'vendor_id', 'INTEGER');
addColumn('tickets', 'cost_cents', 'INTEGER');
addColumn('ticket_comments', 'internal', 'INTEGER NOT NULL DEFAULT 0');

export const DATA_PATH = dir;
export const DOCS_DIR = path.join(dir, 'docs');
fs.mkdirSync(DOCS_DIR, { recursive: true });

// Migration: link payments to Stripe Checkout sessions so webhooks are idempotent.
if (!db.prepare("SELECT 1 FROM pragma_table_info('payments') WHERE name='stripe_session_id'").get()) {
  db.exec('ALTER TABLE payments ADD COLUMN stripe_session_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe ON payments(stripe_session_id) WHERE stripe_session_id IS NOT NULL');

export const getSettings = () =>
  Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value ?? ''));
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
