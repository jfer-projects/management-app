// Starts the app on :3100 with throwaway sample data (./data-demo). Run: npm run demo
// Landlord login: demo@example.com / demopassword1    Tenant login: tina@example.com / tenantpass1
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';

fs.rmSync('data-demo', { recursive: true, force: true });
const PORT = 3100, base = `http://localhost:${PORT}`;
spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: 'data-demo' }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1200));

const jars = {};
async function call(who, method, path, body) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: jars[who] || '' }, body: body && JSON.stringify(body) });
  const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
  const data = await res.json(); if (!res.ok) throw new Error(path + ': ' + data.error); return data;
}
const L = (m, p, b) => call('L', m, p, b);
const ym = (off, day) => { const d = new Date(new Date().getFullYear(), new Date().getMonth() + off, day); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const mon = off => new Date(new Date().getFullYear(), new Date().getMonth() + off, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

await L('POST', '/setup', { name: 'Demo Landlord', email: 'demo@example.com', password: 'demopassword1', property_name: 'Maple Court Condo #4B' });
await L('PUT', '/settings', { venmo_handle: '@demo-landlord', cashapp_tag: '$demolandlord', zelle_contact: 'demo@example.com',
  contact_info: 'Demo Landlord\n(555) 010-2030\ndemo@example.com', wire_instructions: 'Bank: Example Bank\nRouting: 000000000\nAccount: 000000000\nReference: your name + unit' });

const pdf = text => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 50>>stream\nBT /F1 14 Tf 20 50 Td (${text}) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`);
const upload = (qs, text) => fetch(`${base}/api/documents?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: jars.L }, body: pdf(text) });

const tenants = [
  { name: 'Tina Tenant', email: 'tina@example.com', unit: '4B', rent: '1500', due_day: 1, late_fee: '50', grace_days: 5, lease_start: ym(-6, 1), lease_end: ym(2, 28), insurance_expires: ym(0, 48), phone: '555-0101' },
  { name: 'Marcus Rivera', email: 'marcus@example.com', unit: '4C', rent: '1850', due_day: 5, late_fee: '75', grace_days: 3, lease_start: ym(-3, 1), lease_end: ym(9, 28), phone: '555-0102' },
];
for (const [i, t] of tenants.entries()) {
  const { id, invite_token } = await L('POST', '/tenants', t);
  t.id = id;
  if (i === 0) await call('T', 'POST', '/invite/' + invite_token, { password: 'tenantpass1' });
  const rent = Number(t.rent);
  // Prior months of history: paid on time, except one late month for Marcus
  for (const off of [-3, -2, -1]) {
    if (i === 1 && off === -3 && false) continue;
    await L('POST', `/tenants/${id}/charges`, { type: 'rent', description: `Rent – ${mon(off)}`, amount: rent, due_date: ym(off, t.due_day) });
    await L('POST', '/payments', { tenant_id: id, amount: rent, method: i ? 'zelle' : 'venmo', paid_date: ym(off, t.due_day + (i && off === -1 ? 4 : 0)), reference: 'demo' });
  }
}
await L('POST', `/tenants/${tenants[0].id}/charges`, { type: 'fee', description: 'Parking permit', amount: 45, due_date: ym(0, 10) });
await call('T', 'POST', '/payments', { amount: '300', method: 'cashapp', reference: 'CA-9X21', note: 'Partial, rest Friday' });

await upload(`filename=lease.pdf&name=${encodeURIComponent('Lease 2026–2027')}&category=lease&tenant_id=${tenants[0].id}`, 'Residential Lease - Tina Tenant');
await upload(`filename=lease.pdf&name=${encodeURIComponent('Lease 2026')}&category=lease&tenant_id=${tenants[1].id}`, 'Residential Lease - Marcus Rivera');
await upload(`filename=rules.pdf&name=${encodeURIComponent('House rules & quiet hours')}&category=notice&tenant_id=all`, 'House Rules');

const png = (w, h, fn) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = fn(x / w, y / h); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const scene = (r, g, b) => png(320, 240, (x, y) => [Math.min(255, r + y * 60), Math.min(255, g + x * 50), Math.min(255, b + (1 - y) * 40)]);
const send = (who, qs, bytes) => fetch(`${base}/api/attachments?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: jars[who] }, body: bytes }).then(r => r.json());

// second landlord (spouse), a second person on Tina's lease
const w = await L('POST', '/landlords', { name: 'Sam Landlord', email: 'wife@example.com' });
await call('W', 'POST', '/invite/' + w.invite_token, { password: 'wifepassword1' });
const tom = await L('POST', `/tenants/${tenants[0].id}/members`, { name: 'Tom Tenant', email: 'tom@example.com' });
await call('M', 'POST', '/invite/' + tom.invite_token, { password: 'tompassword1' });

// deposit, expenses
await L('POST', `/tenants/${tenants[0].id}/deposit`, { kind: 'received', amount: '1500', date: ym(-6, 1), note: 'Held in escrow account' });
await L('POST', `/tenants/${tenants[1].id}/deposit`, { kind: 'received', amount: '1850', date: ym(-3, 1) });
for (const [cat, vendor, amt, off, day] of [['mortgage interest', 'First Bank', 910, -1, 1], ['HOA dues', 'Maple Court HOA', 385, -1, 5], ['repairs & maintenance', 'Reliable Plumbing', 140, -2, 12], ['insurance', 'Landlord policy', 96, -1, 20]]) {
  await call('W', 'POST', '/expenses', { category: cat, vendor, amount: amt, date: ym(off, day) });
}

// listing + photos
await L('PUT', '/listing', { title: 'Sunny 2BR condo at Maple Court', headline: 'Top-floor corner unit with a private balcony', address: '123 Main St #4B', neighborhood: 'Downtown',
  asking_rent: '$1,950', deposit: '$1,950', bedrooms: '2', bathrooms: '1.5', sqft: '980', floor: '4th floor', available_date: ym(3, 1), lease_term: '12 months', pets: 'Cats OK, no dogs',
  parking: '1 assigned space', laundry: 'In-unit washer/dryer', utilities: 'Water and trash included', hoa_notes: 'Elevator, gym, secure entry',
  description: 'Bright corner condo with floor-to-ceiling windows, refinished hardwood floors and an updated kitchen with stone counters. Walk to cafes, transit and the park.',
  amenities: 'Private balcony\nIn-unit laundry\nStainless appliances\nCentral A/C\nBuilding gym\nSecure entry', contact: 'Demo Landlord\n(555) 010-2030' });
for (const [name, cap, c] of [['living', 'Living room', [60, 90, 120]], ['kitchen', 'Kitchen', [150, 120, 60]], ['bedroom', 'Primary bedroom', [90, 60, 130]], ['bath', 'Bathroom', [40, 130, 140]]]) {
  await send('L', `listing=1&filename=${name}.png&caption=${encodeURIComponent(cap)}`, scene(...c));
}

// move-in inspection, shared with Tina
const insp = await L('POST', '/inspections', { tenant_id: tenants[0].id, kind: 'move_in', date: ym(-6, 1) });
const idet = await L('GET', '/inspections/' + insp.id);
await L('PUT', `/inspections/${insp.id}/items/${idet.items[3].id}`, { condition: 'fair', notes: 'Small chip on dishwasher door' });
await L('PUT', `/inspections/${insp.id}/items/${idet.items[1].id}`, { condition: 'good', notes: 'Fresh paint, no marks' });
await send('L', `item_id=${idet.items[3].id}&filename=dishwasher.png`, scene(120, 70, 60));
await L('POST', `/inspections/${insp.id}/share`);
await call('T', 'POST', `/inspections/${insp.id}/ack`, { comment: 'Looks right to me.' });

const tk = await call('T', 'POST', '/tickets', { title: 'Kitchen faucet dripping', description: 'Steady drip from the base of the faucet since Monday.', category: 'plumbing', priority: 'normal' });
await L('POST', `/tickets/${tk.id}/comments`, { body: 'Thanks, plumber is scheduled for Thursday morning.' });
await send('T', `ticket_id=${tk.id}&filename=faucet.png&caption=Faucet`, scene(70, 110, 150));
await L('POST', `/tickets/${tk.id}/comments`, { body: 'Ask the plumber to bring the cartridge for this model.', internal: true });
await L('PUT', `/tickets/${tk.id}/status`, { status: 'in_progress' });
await call('T', 'POST', '/tickets', { title: 'Intercom buzzer not working', description: 'Guests cannot buzz me in.', category: 'electrical', priority: 'low' });
console.log(`\nDemo ready: ${base}\n  landlord: demo@example.com / demopassword1\n  tenant:   tina@example.com / tenantpass1  (co-tenant tom@example.com / tompassword1)\n  spouse:   wife@example.com / wifepassword1\n`);
