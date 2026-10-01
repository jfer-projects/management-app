import { db, getSettings, setSetting, DOCS_DIR } from './db.js';
import { todayStr } from './billing.js';
import { bad, wrap, str, dateOk, esc, money, needUser, needLandlord, tenantOr404, acctId, saveUpload, sendStored, removeStored, sendTar, logActivity, householdEmails, landlordEmails } from './lib.js';
import { notify, link } from './email.js';
import { printPage } from './finance.js';
import path from 'node:path';

const IMG = ['jpg', 'jpeg', 'png', 'webp'];
const LIMITS = { ticket: 10, item: 8, expense: 5, listing: 60 };

// ---------- access rules ----------
function ticketFor(user, id) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  if (!t || (user.role === 'tenant' && t.tenant_id !== acctId(user))) bad('Not found', 404);
  return t;
}
function itemFor(user, id) {
  const r = db.prepare('SELECT i.*, n.tenant_id, n.status AS istatus FROM inspection_items i JOIN inspections n ON n.id=i.inspection_id WHERE i.id=?').get(id);
  if (!r || (user.role === 'tenant' && (r.tenant_id !== acctId(user) || r.istatus !== 'shared'))) bad('Not found', 404);
  return r;
}
/** Which thing is an attachment (or an upload) attached to, and may this user see it? */
function target(user, q) {
  if (q.ticket_id) { ticketFor(user, q.ticket_id); return { kind: 'ticket', col: 'ticket_id', id: Number(q.ticket_id), landlordOnly: false }; }
  if (q.item_id) { const i = itemFor(user, q.item_id); return { kind: 'item', col: 'item_id', id: i.id, landlordOnly: true, inspection: i.inspection_id }; }
  if (q.expense_id) { if (user.role !== 'landlord') bad('Not found', 404); return { kind: 'expense', col: 'expense_id', id: Number(q.expense_id), landlordOnly: true }; }
  if (q.listing) { if (user.role !== 'landlord') bad('Not found', 404); return { kind: 'listing', col: 'listing', id: 1, landlordOnly: true }; }
  return bad('Missing target');
}
const targetOf = a => (a.ticket_id ? { ticket_id: a.ticket_id } : a.item_id ? { item_id: a.item_id } : a.expense_id ? { expense_id: a.expense_id } : { listing: 1 });

const unshare = inspectionId => db.prepare('UPDATE inspections SET acknowledged_by=NULL, acknowledged_at=NULL WHERE id=?').run(inspectionId);

// ---------- default inspection checklist ----------
const DEFAULT_AREAS = ['Entry / front door', 'Living room', 'Kitchen – cabinets & counters', 'Kitchen – appliances', 'Dining area', 'Bathroom – fixtures & tub/shower',
  'Bathroom – floor & walls', 'Bedroom', 'Closets', 'Windows & screens', 'Walls & paint', 'Floors / carpet', 'Heating / A/C', 'Balcony / patio',
  'Smoke & CO detectors', 'Keys, fobs & remotes', 'Meter readings (note numbers)'];

export function mountMedia(app) {
  // ----- attachments -----
  app.get('/api/attachments', needUser, wrap((req, res) => {
    const t = target(req.user, req.query);
    res.json(db.prepare(`SELECT id,name,caption,ext,size,sort,uploaded_by,created_at FROM attachments WHERE ${t.col}=? ${t.kind === 'listing' ? 'AND listing=1' : ''} ORDER BY sort, id`).all(t.kind === 'listing' ? 1 : t.id));
  }));

  app.post('/api/attachments', needUser, wrap((req, res) => {
    const t = target(req.user, req.query);
    if (t.landlordOnly && req.user.role !== 'landlord') bad('Landlord access required', 403);
    const count = db.prepare(`SELECT COUNT(*) n FROM attachments WHERE ${t.col}=?`).get(t.kind === 'listing' ? 1 : t.id).n;
    if (count >= LIMITS[t.kind]) bad(`Limit of ${LIMITS[t.kind]} files reached`);
    const f = saveUpload(req, t.kind === 'expense' ? [...IMG, 'pdf'] : IMG, t.kind === 'expense' ? 'JPG, PNG, WEBP, PDF' : 'JPG, PNG, WEBP');
    const cols = { ticket_id: null, item_id: null, expense_id: null, listing: 0 };
    cols[t.col] = t.kind === 'listing' ? 1 : t.id;
    const r = db.prepare(`INSERT INTO attachments(ticket_id,item_id,expense_id,listing,caption,sort,name,stored_name,ext,size,uploaded_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(cols.ticket_id, cols.item_id, cols.expense_id, cols.listing, str(req.query.caption, 200),
      count, f.filename.replace(/\.[^.]+$/, '').slice(0, 100), f.stored, f.ext, f.size, req.user.id);
    if (t.kind === 'item') unshare(t.inspection);
    res.json({ id: r.lastInsertRowid });
  }));

  const attachmentFor = req => {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id) || bad('Not found', 404);
    target(req.user, targetOf(a)); // throws unless this user may see the parent
    return a;
  };

  app.get('/api/attachments/:id/file', needUser, wrap((req, res) => {
    const a = attachmentFor(req);
    sendStored(res, a.stored_name, a.ext, a.name, { inline: IMG.includes(a.ext) });
  }));

  app.put('/api/attachments/:id', needUser, needLandlord, wrap((req, res) => {
    const a = attachmentFor(req);
    db.prepare('UPDATE attachments SET caption=? WHERE id=?').run(str(req.body?.caption, 200), a.id);
    res.json({ ok: true });
  }));

  app.post('/api/attachments/reorder', needUser, needLandlord, wrap((req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : bad('ids required');
    const up = db.prepare('UPDATE attachments SET sort=? WHERE id=? AND listing=1');
    ids.forEach((id, i) => up.run(i, id));
    res.json({ ok: true });
  }));

  app.delete('/api/attachments/:id', needUser, wrap((req, res) => {
    const a = attachmentFor(req);
    if (req.user.role === 'tenant' && a.uploaded_by !== req.user.id) bad('Only the landlord can delete this', 403);
    db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
    removeStored(a.stored_name);
    if (a.item_id) unshare(db.prepare('SELECT inspection_id FROM inspection_items WHERE id=?').get(a.item_id).inspection_id);
    res.json({ ok: true });
  }));

  // ----- property listing -----
  const LISTING_FIELDS = ['title', 'headline', 'description', 'address', 'neighborhood', 'bedrooms', 'bathrooms', 'sqft', 'floor', 'asking_rent', 'deposit',
    'available_date', 'lease_term', 'pets', 'parking', 'laundry', 'utilities', 'amenities', 'hoa_notes', 'contact'];
  const readListing = () => { try { return JSON.parse(getSettings().listing || '{}'); } catch { return {}; } };
  const listingPhotos = () => db.prepare('SELECT id,name,caption,ext,size,sort FROM attachments WHERE listing=1 ORDER BY sort, id').all();

  app.get('/api/listing', needUser, needLandlord, wrap((_req, res) => res.json({ listing: readListing(), photos: listingPhotos() })));
  app.put('/api/listing', needUser, needLandlord, wrap((req, res) => {
    const out = {};
    for (const k of LISTING_FIELDS) out[k] = str(req.body?.[k], k === 'description' || k === 'amenities' ? 5000 : 300);
    setSetting('listing', JSON.stringify(out));
    logActivity(req.user.id, 'Updated the property listing details');
    res.json({ listing: out });
  }));

  app.get('/api/listing/photos.tar', needUser, needLandlord, wrap((_req, res) => {
    const photos = listingPhotos();
    if (!photos.length) bad('No photos yet');
    const rows = db.prepare('SELECT * FROM attachments WHERE listing=1 ORDER BY sort, id').all();
    sendTar(res, 'listing-photos.tar', [
      ...rows.map((a, i) => ({ name: `${String(i + 1).padStart(2, '0')}-${(a.caption || a.name).replace(/[^\w\- ]+/g, '').trim().slice(0, 50) || 'photo'}.${a.ext}`, file: path.join(DOCS_DIR, a.stored_name) })),
      { name: 'captions.txt', data: Buffer.from(rows.map((a, i) => `${i + 1}. ${a.caption || a.name}`).join('\n') + '\n') },
    ]);
  }));

  app.get('/api/listing/sheet', needUser, needLandlord, wrap((_req, res) => {
    const l = readListing(), s = getSettings(), photos = listingPhotos();
    const facts = [['Bedrooms', l.bedrooms], ['Bathrooms', l.bathrooms], ['Size', l.sqft && l.sqft + ' sq ft'], ['Floor', l.floor], ['Available', l.available_date],
      ['Lease term', l.lease_term], ['Security deposit', l.deposit], ['Pets', l.pets], ['Parking', l.parking], ['Laundry', l.laundry], ['Utilities', l.utilities], ['HOA / building', l.hoa_notes]].filter(f => f[1]);
    res.type('html').send(printPage('Listing sheet', `
      <h1>${esc(l.title || s.property_name || 'Apartment for rent')}</h1>
      <p class="mute">${esc(l.address || s.property_address || '')}${l.neighborhood ? ' · ' + esc(l.neighborhood) : ''}</p>
      ${l.asking_rent ? `<h2>${esc(l.asking_rent)} / month</h2>` : ''}${l.headline ? `<p><b>${esc(l.headline)}</b></p>` : ''}
      <div class="box"><table>${facts.map(f => `<tr><th>${esc(f[0])}</th><td>${esc(f[1])}</td></tr>`).join('')}</table></div>
      ${l.description ? `<h2>About</h2><p style="white-space:pre-wrap">${esc(l.description)}</p>` : ''}
      ${l.amenities ? `<h2>Amenities</h2><ul>${l.amenities.split('\n').filter(x => x.trim()).map(x => `<li>${esc(x.trim())}</li>`).join('')}</ul>` : ''}
      ${l.contact ? `<h2>Contact</h2><p style="white-space:pre-wrap">${esc(l.contact)}</p>` : ''}
      ${photos.map(p => `<p><img src="/api/attachments/${p.id}/file" alt="${esc(p.caption || p.name)}" style="max-width:100%;border-radius:6px"><br><span class="mute">${esc(p.caption)}</span></p>`).join('')}`));
  }));

  // ----- inspections (move-in / move-out) -----
  const inspectionFor = (user, id) => {
    const n = db.prepare(`SELECT n.*, t.name AS tenant_name, t.unit, ab.name AS ack_name FROM inspections n JOIN users t ON t.id=n.tenant_id
      LEFT JOIN users ab ON ab.id=n.acknowledged_by WHERE n.id=?`).get(id);
    if (!n || (user.role === 'tenant' && (n.tenant_id !== acctId(user) || n.status !== 'shared'))) bad('Inspection not found', 404);
    return n;
  };
  const itemsOf = id => db.prepare('SELECT * FROM inspection_items WHERE inspection_id=? ORDER BY sort, id').all(id).map(i => ({
    ...i, photos: db.prepare('SELECT id,name,caption FROM attachments WHERE item_id=? ORDER BY sort,id').all(i.id),
  }));

  app.get('/api/inspections', needUser, wrap((req, res) => {
    const rows = req.user.role === 'landlord'
      ? db.prepare(`SELECT n.*, t.name AS tenant_name FROM inspections n JOIN users t ON t.id=n.tenant_id ${req.query.tenant_id ? 'WHERE n.tenant_id=?' : ''} ORDER BY n.inspect_date DESC, n.id DESC`).all(...(req.query.tenant_id ? [req.query.tenant_id] : []))
      : db.prepare("SELECT n.*, t.name AS tenant_name FROM inspections n JOIN users t ON t.id=n.tenant_id WHERE n.tenant_id=? AND n.status='shared' ORDER BY n.inspect_date DESC").all(acctId(req.user));
    res.json(rows);
  }));

  app.post('/api/inspections', needUser, needLandlord, wrap((req, res) => {
    const t = tenantOr404(req.body?.tenant_id);
    const kind = req.body?.kind === 'move_out' ? 'move_out' : 'move_in';
    const r = db.prepare('INSERT INTO inspections(tenant_id,kind,inspect_date,created_by) VALUES(?,?,?,?)')
      .run(t.id, kind, dateOk(req.body?.date) ? req.body.date : todayStr(), req.user.id);
    const ins = db.prepare('INSERT INTO inspection_items(inspection_id,area,sort) VALUES(?,?,?)');
    DEFAULT_AREAS.forEach((a, i) => ins.run(r.lastInsertRowid, a, i));
    logActivity(req.user.id, `Started a ${kind.replace('_', '-')} inspection for ${t.name}`, t.id);
    res.json({ id: r.lastInsertRowid });
  }));

  app.get('/api/inspections/:id', needUser, wrap((req, res) => {
    const n = inspectionFor(req.user, req.params.id);
    res.json({ inspection: n, items: itemsOf(n.id) });
  }));

  const editable = req => { const n = inspectionFor(req.user, req.params.id); return n; };
  app.put('/api/inspections/:id', needUser, needLandlord, wrap((req, res) => {
    const n = editable(req);
    db.prepare('UPDATE inspections SET notes=?, inspect_date=? WHERE id=?').run(str(req.body?.notes, 2000), dateOk(req.body?.date) ? req.body.date : n.inspect_date, n.id);
    unshare(n.id);
    res.json({ ok: true });
  }));
  app.put('/api/inspections/:id/items/:itemId', needUser, needLandlord, wrap((req, res) => {
    const n = editable(req);
    const cond = ['good', 'fair', 'poor', 'damaged', 'n/a'].includes(req.body?.condition) ? req.body.condition : 'good';
    const r = db.prepare('UPDATE inspection_items SET condition=?, notes=? WHERE id=? AND inspection_id=?').run(cond, str(req.body?.notes, 1000), req.params.itemId, n.id);
    if (!r.changes) bad('Item not found', 404);
    unshare(n.id);
    res.json({ ok: true });
  }));
  app.post('/api/inspections/:id/items', needUser, needLandlord, wrap((req, res) => {
    const n = editable(req);
    if (!str(req.body?.area, 100)) bad('Name the area');
    db.prepare('INSERT INTO inspection_items(inspection_id,area,sort) VALUES(?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM inspection_items WHERE inspection_id=?))').run(n.id, str(req.body.area, 100), n.id);
    unshare(n.id);
    res.json({ ok: true });
  }));
  app.delete('/api/inspections/:id/items/:itemId', needUser, needLandlord, wrap((req, res) => {
    const n = editable(req);
    for (const a of db.prepare('SELECT stored_name FROM attachments WHERE item_id=?').all(req.params.itemId)) removeStored(a.stored_name);
    db.prepare('DELETE FROM inspection_items WHERE id=? AND inspection_id=?').run(req.params.itemId, n.id);
    unshare(n.id);
    res.json({ ok: true });
  }));

  app.post('/api/inspections/:id/share', needUser, needLandlord, wrap((req, res) => {
    const n = editable(req);
    db.prepare("UPDATE inspections SET status='shared' WHERE id=?").run(n.id);
    notify(householdEmails(n.tenant_id), `Please review your ${n.kind.replace('_', '-')} inspection`, `Your landlord shared the ${n.kind.replace('_', '-')} inspection report. Please review it and click "I agree" (or add a comment).\n\n${link('/inspections/' + n.id)}`);
    logActivity(req.user.id, `Shared ${n.kind.replace('_', '-')} inspection with ${n.tenant_name}`, n.tenant_id);
    res.json({ ok: true });
  }));

  app.post('/api/inspections/:id/ack', needUser, wrap((req, res) => {
    if (req.user.role !== 'tenant') bad('Tenant accounts only', 403);
    const n = inspectionFor(req.user, req.params.id);
    db.prepare("UPDATE inspections SET acknowledged_by=?, acknowledged_at=CURRENT_TIMESTAMP, tenant_comment=? WHERE id=?").run(req.user.id, str(req.body?.comment, 2000), n.id);
    notify(landlordEmails(), `${req.user.name} reviewed the ${n.kind.replace('_', '-')} inspection`, `${req.user.name} acknowledged the inspection${req.body?.comment ? ' and left a comment' : ''}.\n\n${link('/inspections/' + n.id)}`);
    res.json({ ok: true });
  }));

  app.delete('/api/inspections/:id', needUser, needLandlord, wrap((req, res) => {
    const n = editable(req);
    for (const a of db.prepare('SELECT a.stored_name FROM attachments a JOIN inspection_items i ON i.id=a.item_id WHERE i.inspection_id=?').all(n.id)) removeStored(a.stored_name);
    db.prepare('DELETE FROM attachments WHERE item_id IN (SELECT id FROM inspection_items WHERE inspection_id=?)').run(n.id);
    db.prepare('DELETE FROM inspections WHERE id=?').run(n.id);
    res.json({ ok: true });
  }));

  app.get('/api/inspections/:id/report', needUser, wrap((req, res) => {
    const n = inspectionFor(req.user, req.params.id);
    const s = getSettings();
    res.type('html').send(printPage('Inspection report', `
      <h1>${n.kind === 'move_in' ? 'Move-in' : 'Move-out'} inspection</h1>
      <p class="mute">${esc(s.property_name || '')}${s.property_address ? ' · ' + esc(s.property_address) : ''}</p>
      <p><b>${esc(n.tenant_name)}</b>${n.unit ? ' · ' + esc(n.unit) : ''} · ${esc(n.inspect_date)}</p>
      ${n.notes ? `<p style="white-space:pre-wrap">${esc(n.notes)}</p>` : ''}
      <table><thead><tr><th>Area</th><th>Condition</th><th>Notes</th></tr></thead><tbody>${itemsOf(n.id).map(i => `<tr><td>${esc(i.area)}${i.photos.map(p => `<br><img src="/api/attachments/${p.id}/file" alt="" style="max-width:220px;margin-top:4px">`).join('')}</td><td>${esc(i.condition)}</td><td>${esc(i.notes)}</td></tr>`).join('')}</tbody></table>
      <h2>Acknowledgement</h2>
      <p>${n.acknowledged_at ? `Reviewed and acknowledged by ${esc(n.ack_name)} on ${esc(n.acknowledged_at)} UTC.` : 'Not yet acknowledged by the tenant.'}</p>
      ${n.tenant_comment ? `<p style="white-space:pre-wrap"><b>Tenant comment:</b> ${esc(n.tenant_comment)}</p>` : ''}`));
  }));
}
