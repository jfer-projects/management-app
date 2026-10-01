import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, DOCS_DIR } from './db.js';

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
export const wrap = fn => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
export const sha = s => crypto.createHash('sha256').update(s).digest('hex');
export const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const dateOk = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
export const emailOk = v => /^\S+@\S+\.\S+$/.test(v);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function cents(v, { allowNegative = false } = {}) {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n) || n > 100_000_000) bad('Invalid amount');
  if (n === 0 || (!allowNegative && n < 0)) bad('Amount must be greater than zero');
  return n;
}

// ---------- passwords ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) bad('Password must be at least 8 characters');
  if (pw.length > 200) bad('Password too long');
}
export const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

// ---------- throttling ----------
const attempts = new Map();
export function throttle(key, max = 10) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < 15 * 60_000);
  if (list.length >= max) bad('Too many attempts. Try again in a few minutes.', 429);
  list.push(now);
  attempts.set(key, list);
}

// ---------- auth middleware ----------
export const needUser = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in')));
export const needLandlord = (req, _res, next) =>
  req.user?.role === 'landlord' ? next() : next(new HttpError(403, 'Landlord access required'));

/** Tenants sharing a lease all act on the lease holder's account (ledger, tickets, documents). */
export const acctId = u => u.primary_id || u.id;
export const accountRow = u => (u.primary_id ? db.prepare('SELECT * FROM users WHERE id=?').get(u.primary_id) : u);
export const tenantOr404 = id => db.prepare("SELECT * FROM users WHERE id=? AND role='tenant' AND primary_id IS NULL").get(id) || bad('Tenant not found', 404);

export const landlordEmails = () => db.prepare("SELECT email FROM users WHERE role='landlord' AND active=1 AND invite_token IS NULL").all().map(r => r.email);
export const householdEmails = id => db.prepare("SELECT email FROM users WHERE active=1 AND (id=? OR primary_id=?)").all(id, id).map(r => r.email);

export function logActivity(userId, text, tenantId = null) {
  db.prepare('INSERT INTO activity(user_id,tenant_id,text) VALUES(?,?,?)').run(userId, tenantId, text.slice(0, 300));
}

// ---------- uploads ----------
export const FILE_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const MAGIC = {
  pdf: [0x25, 0x50, 0x44, 0x46], png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff],
  docx: [0x50, 0x4b], webp: [0x52, 0x49, 0x46, 0x46],
};

/** Validates an uploaded body against an allowed extension list and writes it to disk. Returns {stored, ext, size}. */
export function saveUpload(req, allowed, label) {
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) bad('No file received (max 10 MB)');
  const filename = str(req.query.filename, 200);
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!allowed.includes(ext)) bad(`Allowed file types: ${label}`);
  const magic = MAGIC[ext];
  if (magic && !magic.every((b, i) => body[i] === b)) bad('File contents do not match its type');
  if (ext === 'webp' && body.subarray(8, 12).toString() !== 'WEBP') bad('File contents do not match its type');
  const stored = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(DOCS_DIR, stored), body);
  return { stored, ext, size: body.length, filename };
}

export function sendStored(res, stored, ext, name, { inline = false } = {}) {
  const file = path.join(DOCS_DIR, stored);
  if (!fs.existsSync(file)) bad('File is missing from storage', 404);
  const safe = (name.replace(/[^\w\- .]+/g, '_') || 'file') + '.' + ext;
  res.set({
    'Content-Type': FILE_TYPES[ext], 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=300',
  });
  res.sendFile(file);
}

export const removeStored = stored => fs.rmSync(path.join(DOCS_DIR, stored), { force: true });

/** Streams a minimal tar archive. entries: [{ name, file? , data? }] */
export function sendTar(res, filename, entries) {
  res.set({ 'Content-Type': 'application/x-tar', 'Content-Disposition': `attachment; filename="${filename}"` });
  const header = (name, size) => {
    const b = Buffer.alloc(512);
    b.write(name.slice(0, 99), 0); b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116);
    b.write(size.toString(8).padStart(11, '0') + '\0', 124);
    b.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    b.write('        ', 148); b.write('0', 156); b.write('ustar\0', 257); b.write('00', 263);
    let sum = 0; for (const x of b) sum += x;
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return b;
  };
  for (const e of entries) {
    const data = e.data ?? fs.readFileSync(e.file);
    res.write(header(e.name, data.length));
    res.write(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) res.write(Buffer.alloc(pad));
  }
  res.end(Buffer.alloc(1024));
}

export const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralize spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
