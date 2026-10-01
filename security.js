import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { db, getSettings, setSetting, DATA_PATH, DOCS_DIR } from './db.js';
import { todayStr } from './billing.js';
import { bad, wrap, sha, str, needUser, needLandlord, throttle, checkPassword, hashPassword, verifyPassword, sendTar, logActivity, HttpError } from './lib.js';
import { notify, link } from './email.js';

// ---------- TOTP (RFC 6238), no external dependency ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = buf => { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const b32decode = s => { let bits = ''; for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };

function hotp(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
/** Returns the matched time-step (so it can't be replayed) or 0. */
function matchTotp(secret, code, last = 0, now = Date.now()) {
  const step = Math.floor(now / 30000);
  for (const w of [0, -1, 1]) {
    const c = step + w;
    if (c > last && crypto.timingSafeEqual(Buffer.from(hotp(secret, c)), Buffer.from(code))) return c;
  }
  return 0;
}

/** Checks an authenticator code or a one-time recovery code. Consumes what it uses. */
export function verifySecondFactor(user, rawCode) {
  const code = String(rawCode || '').replace(/[\s-]/g, '').toLowerCase();
  if (/^\d{6}$/.test(code)) {
    const step = matchTotp(user.totp_secret, code, user.totp_last);
    if (!step) return false;
    db.prepare('UPDATE users SET totp_last=? WHERE id=?').run(step, user.id);
    return true;
  }
  const hashes = JSON.parse(user.recovery_codes || '[]');
  const h = sha(code);
  if (code.length === 10 && hashes.includes(h)) {
    db.prepare('UPDATE users SET recovery_codes=? WHERE id=?').run(JSON.stringify(hashes.filter(x => x !== h)), user.id);
    return true;
  }
  return false;
}

export function mountSecurity(app) {
  // ----- password reset by email -----
  app.post('/api/forgot', wrap((req, res) => {
    throttle(`${req.ip}|forgot`, 8);
    const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1 AND password_hash IS NOT NULL').get(str(req.body?.email, 200));
    if (u) {
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('DELETE FROM password_resets WHERE user_id=?').run(u.id);
      db.prepare('INSERT INTO password_resets(token_hash,user_id,expires) VALUES(?,?,?)').run(sha(token), u.id, Date.now() + 3600_000);
      notify(u.email, 'Reset your password', `Someone (hopefully you) asked to reset your password. This link works for one hour:\n\n${link('/reset/' + token)}\n\nIf this wasn't you, ignore this email.`);
    }
    res.json({ ok: true }); // same answer either way, so emails can't be enumerated
  }));

  const resetRow = token => db.prepare(`SELECT u.id,u.name,u.email FROM password_resets r JOIN users u ON u.id=r.user_id
    WHERE r.token_hash=? AND r.expires>? AND u.active=1`).get(sha(token), Date.now());

  app.get('/api/reset/:token', wrap((req, res) => res.json(resetRow(req.params.token) || bad('This reset link is invalid or has expired', 404))));
  app.post('/api/reset/:token', wrap((req, res) => {
    throttle(`${req.ip}|reset`);
    const u = resetRow(req.params.token) || bad('This reset link is invalid or has expired', 404);
    checkPassword(req.body?.password);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(req.body.password), u.id);
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    res.json({ ok: true });
  }));

  // ----- two-factor (authenticator app) -----
  app.post('/api/2fa/setup', needUser, (req, res, next) => {
    if (req.user.totp_enabled) return next(new HttpError(400, 'Two-factor is already on'));
    const secret = b32encode(crypto.randomBytes(20));
    db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(secret, req.user.id);
    const issuer = encodeURIComponent(getSettings().property_name || 'Rental Portal');
    const uri = `otpauth://totp/${issuer}:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=${issuer}`;
    QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 }).then(qr => res.json({ secret, uri, qr })).catch(next);
  });

  app.post('/api/2fa/enable', needUser, wrap((req, res) => {
    throttle(`${req.ip}|2fa|${req.user.id}`);
    const u = req.user;
    if (u.totp_enabled || !u.totp_secret) bad('Start setup first');
    const code = String(req.body?.code || '').replace(/\s/g, '');
    const step = /^\d{6}$/.test(code) ? matchTotp(u.totp_secret, code) : 0;
    if (!step) bad('That code is not right. Check your phone\'s clock and try the newest code.');
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
    db.prepare('UPDATE users SET totp_enabled=1, totp_last=?, recovery_codes=? WHERE id=?')
      .run(step, JSON.stringify(codes.map(sha)), u.id);
    if (u.role === 'landlord') logActivity(u.id, 'Turned on two-factor sign-in');
    res.json({ recovery_codes: codes.map(c => `${c.slice(0, 5)}-${c.slice(5)}`) });
  }));

  app.post('/api/2fa/disable', needUser, wrap((req, res) => {
    throttle(`${req.ip}|2fa|${req.user.id}`);
    const u = req.user;
    if (!u.totp_enabled) bad('Two-factor is not on');
    if (!verifyPassword(String(req.body?.password || ''), u.password_hash)) bad('Incorrect password', 403);
    if (!verifySecondFactor(u, req.body?.code)) bad('Incorrect code', 403);
    db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL, recovery_codes=NULL, totp_last=0 WHERE id=?').run(u.id);
    if (u.role === 'landlord') logActivity(u.id, 'Turned off two-factor sign-in');
    res.json({ ok: true });
  }));

  // ----- backups -----
  app.get('/api/backup/status', needUser, needLandlord, wrap((_req, res) => {
    const dir = path.join(DATA_PATH, 'backups');
    res.json({
      last_download: getSettings().last_backup_download || null,
      snapshots: fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^rental-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse() : [],
      files: fs.readdirSync(DOCS_DIR).length,
    });
  }));

  const tokens = new Map();
  app.post('/api/backup/prepare', needUser, needLandlord, wrap((req, res) => {
    throttle(`${req.ip}|backup`, 5);
    if (!verifyPassword(String(req.body?.password || ''), req.user.password_hash)) bad('Incorrect password', 403);
    const token = crypto.randomBytes(16).toString('hex');
    tokens.set(token, { user: req.user.id, expires: Date.now() + 60_000 });
    res.json({ url: `/api/backup/download/${token}` });
  }));

  app.get('/api/backup/download/:token', needUser, needLandlord, wrap((req, res) => {
    const t = tokens.get(req.params.token);
    tokens.delete(req.params.token);
    if (!t || t.expires < Date.now() || t.user !== req.user.id) bad('Download link expired. Start again.', 410);
    const tmp = path.join(DATA_PATH, 'backups', `tmp-${crypto.randomBytes(6).toString('hex')}.db`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const files = fs.readdirSync(DOCS_DIR);
    try {
      sendTar(res, `rental-backup-${todayStr()}.tar`, [
        { name: 'rental.db', file: tmp },
        { name: 'README.txt', data: Buffer.from('rental.db = full database snapshot. docs/ = uploaded files (names match the database).\nRestore: put rental.db and the docs folder into the app DATA_DIR (as rental.db and docs/) while the app is stopped.\n') },
        ...files.map(f => ({ name: `docs/${f}`, file: path.join(DOCS_DIR, f) })),
      ]);
    } finally { fs.rmSync(tmp, { force: true }); }
    setSetting('last_backup_download', new Date().toISOString());
    logActivity(req.user.id, 'Downloaded a full backup');
  }));
}

/** Daily local snapshot of the database (guards against mistakes/corruption; downloads guard against disk loss). */
export function snapshot() {
  const dir = path.join(DATA_PATH, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rental-${todayStr()}.db`);
  if (!fs.existsSync(f)) db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter(n => /^rental-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort().slice(0, -14);
  for (const n of old) fs.rmSync(path.join(dir, n), { force: true });
  for (const n of fs.readdirSync(dir)) if (n.startsWith('tmp-')) fs.rmSync(path.join(dir, n), { force: true });
}
