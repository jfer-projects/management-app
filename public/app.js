import { install } from './features.js';

// ---------- tiny helpers ----------
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } }
const raw = s => new Raw(s);
// Tagged template: every interpolation is HTML-escaped unless wrapped in raw() or produced by html``.
const html = (strs, ...vals) => new Raw(strs.reduce((out, s, i) => {
  let v = vals[i - 1];
  v = v instanceof Raw ? v.s : Array.isArray(v) ? v.map(x => (x instanceof Raw ? x.s : esc(x))).join('') : esc(v);
  return out + v + s;
}));

const money = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = c => (c / 100).toFixed(2);
const fmtDate = d => d ? new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const fmtTs = t => t ? new Date(t.replace(' ', 'T') + (t.includes('Z') || t.includes('T') && t.length > 19 ? '' : 'Z')).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const badge = s => html`<span class="badge ${s}">${s.replace('_', ' ')}</span>`;
const METHOD = { ach: 'Bank account (automatic)', cashapp: 'Cash App', venmo: 'Venmo', zelle: 'Zelle', wire: 'Bank wire', check: 'Check', cash: 'Cash', other: 'Other' };

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function modal(content, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${content.s}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  bg.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  document.body.appendChild(bg);
  onMount?.(bg.querySelector('.modal'), close);
  bg.querySelector('input,select,textarea')?.focus();
  return close;
}

const formData = form => Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, v]).concat(
  [...form.querySelectorAll('input[type=checkbox]')].map(c => [c.name, c.checked])));

/** Wire up a <form>: on submit run handler(data), show errors inline. */
function submitter(root, selector, handler) {
  const form = root.querySelector(selector);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]'); const errEl = form.querySelector('.err');
    if (errEl) errEl.textContent = '';
    btn.disabled = true;
    try { await handler(formData(form)); }
    catch (err) { if (errEl) errEl.textContent = err.message; else toast(err.message); }
    finally { btn.disabled = false; }
  });
}

// ---------- state ----------
let session = null;
const isLandlord = () => session.user.role === 'landlord';

async function loadSession() { session = await api('/session'); }

// ---------- router ----------
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
const go = h => { location.hash = h; };

async function render() {
  const hash = location.hash.slice(1) || '/';
  try {
    if (!session) await loadSession();
    const inv = hash.match(/^\/invite\/(\w+)$/);
    if (inv) return await inviteView(inv[1]);
    const rst = hash.match(/^\/reset\/(\w+)$/);
    if (rst) return await resetView(rst[1]);
    if (hash === '/forgot') return forgotView();
    if (!session.user) return session.needsSetup ? setupView() : loginView();
    for (const [re, fn] of routes) {
      const m = hash.match(re);
      if (m) return shell(hash, await fn(...m.slice(1)));
    }
    go('/');
  } catch (e) {
    if (e.status === 401) { session = null; return render(); }
    $app.innerHTML = html`<main><div class="card"><p class="err">${e.message}</p><a href="#/">Back to start</a></div></main>`.s;
  }
}
window.addEventListener('hashchange', render);

function shell(hash, view) {
  const L = isLandlord();
  const tabs = L
    ? [['/', 'Dashboard'], ['/tenants', 'Tenants'], ['/payments', 'Payments'], ['/documents', 'Documents'], ['/tickets', 'Tickets'], ['/finances', 'Finances'], ['/property', 'Property'], ['/settings', 'Settings']]
    : [['/', 'Home'], ['/ledger', 'Charges & payments'], ['/documents', 'Documents'], ['/tickets', 'Requests'], ['/account', 'Account']];
  const active = t => (t === '/' ? hash === '/' : hash.startsWith(t));
  $app.innerHTML = html`
    <header class="top"><div class="bar">
      <span class="brand">${session.settings.property_name || 'Rental Portal'}</span>
      <nav>${tabs.map(([h, l]) => html`<a href="#${h}" class="${active(h) ? 'on' : ''}">${l}</a>`)}</nav>
      <button class="sm" id="logout">Sign out</button>
    </div></header>
    <main>${view}</main>`.s;
  document.getElementById('logout').onclick = async () => { await api('/logout', 'POST'); session = null; go('/'); render(); };
  view.mount?.($app.querySelector('main'));
}
// Views return html with an optional .mount(root) hook.
const view = (content, mount) => Object.assign(content, { mount });

// ---------- auth views ----------
function authCard(title, body, mount) {
  $app.innerHTML = html`<div class="auth"><div class="card"><h1>${title}</h1>${body}</div></div>`.s;
  mount($app);
}

function loginView() {
  authCard(session.settings.property_name || 'Rental Portal', html`
    <form id="f"><div class="field"><label>Email</label><input name="email" type="email" autocomplete="username" required></div>
    <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
    <div class="field" id="codeField" hidden><label>Authentication code (or a recovery code)</label><input name="code" autocomplete="one-time-code" inputmode="numeric"></div>
    <div class="err"></div><button class="primary" type="submit">Sign in</button></form>
    <p class="small"><a href="#/forgot">Forgot your password?</a></p>
    <p class="mute small">Need access? Ask your landlord for an invite link.</p>`, root =>
    submitter(root, '#f', async d => {
      const r = await api('/login', 'POST', d);
      if (r.totp_required) {
        root.querySelector('#codeField').hidden = false;
        root.querySelector('[name=code]').required = true; root.querySelector('[name=code]').focus();
        root.querySelector('.err').textContent = 'Enter the 6-digit code from your authenticator app.';
        return;
      }
      session = null; render();
    }));
}

function forgotView() {
  authCard('Reset your password', html`
    <p class="mute">Enter your email and we'll send you a reset link.</p>
    <form id="f"><div class="field"><label>Email</label><input name="email" type="email" required></div>
    <div class="err"></div><button class="primary" type="submit">Send reset link</button></form>
    <p class="small"><a href="#/">Back to sign in</a></p>
    <p class="mute small">No email arriving? Ask your landlord to reset your sign-in.</p>`, root =>
    submitter(root, '#f', async d => { await api('/forgot', 'POST', d); root.querySelector('.err').style.color = 'var(--ok)'; root.querySelector('.err').textContent = 'If that email has an account, a reset link is on its way.'; }));
}

async function resetView(token) {
  let info;
  try { info = await api('/reset/' + token); } catch (e) {
    return authCard('Reset link problem', html`<p>${e.message}</p><a href="#/forgot">Request a new link</a>`, () => {});
  }
  authCard('Choose a new password', html`
    <p class="mute">For <b>${info.email}</b></p>
    <form id="f"><div class="field"><label>New password (8+ characters)</label><input name="password" type="password" autocomplete="new-password" minlength="8" required></div>
    <div class="err"></div><button class="primary" type="submit">Set password</button></form>`, root =>
    submitter(root, '#f', async d => { await api('/reset/' + token, 'POST', d); go('/'); toast('Password updated. Please sign in.'); }));
}

function setupView() {
  authCard('Set up your portal', html`
    <p class="mute">Create the landlord account. You'll add your tenants next.</p>
    <form id="f"><div class="field"><label>Property name</label><input name="property_name" placeholder="e.g. 123 Main St #4B" required></div>
    ${session.setupCodeRequired ? html`<div class="field"><label>Setup code (the SETUP_CODE you set on the server)</label><input name="setup_code" required></div>` : ''}
    <div class="field"><label>Your name</label><input name="name" required></div>
    <div class="field"><label>Email</label><input name="email" type="email" autocomplete="username" required></div>
    <div class="field"><label>Password (8+ characters)</label><input name="password" type="password" autocomplete="new-password" minlength="8" required></div>
    <div class="err"></div><button class="primary" type="submit">Create account</button></form>`, root =>
    submitter(root, '#f', async d => { await api('/setup', 'POST', d); session = null; render(); }));
}

async function inviteView(token) {
  let info;
  try { info = await api('/invite/' + token); } catch (e) {
    return authCard('Invite link problem', html`<p>${e.message}</p><a href="#/">Go to sign in</a>`, () => {});
  }
  authCard(`Welcome, ${info.name}`, html`
    <p class="mute">Choose a password for <b>${info.email}</b>.</p>
    <form id="f"><div class="field"><label>Password (8+ characters)</label><input name="password" type="password" autocomplete="new-password" minlength="8" required></div>
    <div class="err"></div><button class="primary" type="submit">Create my account</button></form>`, root =>
    submitter(root, '#f', async d => { await api('/invite/' + token, 'POST', d); session = null; go('/'); render(); }));
}

// ---------- shared pieces ----------
const chargesTable = (charges, { admin = false } = {}) => charges.length ? html`
  <div class="table-wrap"><table><thead><tr><th>Due</th><th>Description</th><th class="right">Amount</th><th class="right">Remaining</th><th>Status</th>${admin ? html`<th></th>` : ''}</tr></thead>
  <tbody>${charges.map(c => html`<tr>
    <td>${fmtDate(c.due_date)}</td><td>${c.description}</td>
    <td class="right ${c.amount_cents < 0 ? 'neg' : ''}">${money(c.amount_cents)}</td>
    <td class="right">${c.status === 'credit' || c.status === 'scheduled' ? '' : money(c.remaining_cents)}</td>
    <td>${badge(c.status)}</td>
    ${admin ? html`<td class="right">${c.id ? html`<button class="sm danger" data-void="${c.id}">Void</button>` : ''}</td>` : ''}
  </tr>`)}</tbody></table></div>` : html`<div class="empty">No charges yet.</div>`;

const paymentsTable = (payments, { admin = false, showTenant = false } = {}) => payments.length ? html`
  <div class="table-wrap"><table><thead><tr><th>Date</th>${showTenant ? html`<th>Tenant</th>` : ''}<th>Method</th><th class="hide-sm">Reference</th><th class="right">Amount</th><th>Status</th>${admin ? html`<th></th>` : ''}</tr></thead>
  <tbody>${payments.map(p => html`<tr>
    <td>${fmtDate(p.paid_date)}</td>${showTenant ? html`<td>${p.tenant_name}</td>` : ''}
    <td>${METHOD[p.method] || p.method}</td><td class="hide-sm">${p.reference}${p.note ? html`<div class="mute small">${p.note}</div>` : ''}
      ${p.paid_by_name ? html`<div class="mute small">reported by ${p.paid_by_name}</div>` : ''}${p.reviewed_by_name ? html`<div class="mute small">${p.status} by ${p.reviewed_by_name}</div>` : ''}</td>
    <td class="right">${money(p.amount_cents)}</td><td>${badge(p.status)}${p.status === 'confirmed' ? html`<div><a class="small" href="/api/payments/${p.id}/receipt" target="_blank">Receipt</a></div>` : ''}</td>
    ${admin ? html`<td class="right">${p.status === 'pending' ? html`
      <button class="sm primary" data-review="${p.id}" data-status="confirmed">Confirm</button>
      <button class="sm" data-review="${p.id}" data-status="rejected">Reject</button>` : ''}</td>` : ''}
  </tr>`)}</tbody></table></div>` : html`<div class="empty">No payments yet.</div>`;

const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Splits a ledger into Due now / Upcoming (incl. future scheduled rent) / Past charges. */
function scheduleCards(d, { admin = false } = {}) {
  const today = localToday();
  const dueNow = d.charges.filter(c => c.remaining_cents > 0 && c.due_date <= today && c.status !== 'credit').reverse();
  const future = d.charges.filter(c => c.due_date > today);
  const upcoming = [...future, ...(d.scheduled || [])].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const shown = new Set([...dueNow, ...future]);
  const past = d.charges.filter(c => !shown.has(c));
  const upTotal = upcoming.reduce((s, c) => s + (c.status === 'scheduled' ? c.amount_cents : c.remaining_cents), 0);
  return html`
    ${dueNow.length ? html`<div class="card"><h2>Due now</h2>${chargesTable(dueNow, { admin })}</div>` : ''}
    <div class="card"><div class="row sp"><h2 style="margin:0">Upcoming charges</h2>${upcoming.length ? html`<span class="mute small">${upcoming.length} scheduled · ${money(upTotal)} total</span>` : ''}</div>
      ${upcoming.length ? chargesTable(upcoming, { admin }) : html`<div class="empty">Nothing scheduled.</div>`}</div>
    <div class="card"><h2>Past charges</h2>${past.length ? chargesTable(past, { admin }) : html`<div class="empty">No past charges yet.</div>`}</div>`;
}

// ---------- documents ----------
const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const DOC_CATS = ['lease', 'addendum', 'notice', 'insurance', 'receipt', 'inspection', 'other'];

const docsTable = (docs, { showTenant = false } = {}) => docs.length ? html`
  <div class="table-wrap"><table><thead><tr><th>Document</th><th>Type</th>${showTenant ? html`<th>For</th>` : ''}<th class="hide-sm">Added</th><th></th></tr></thead>
  <tbody>${docs.map(d => html`<tr>
    <td><a href="/api/documents/${d.id}/download"><b>${d.name}</b></a><div class="mute small">${d.ext.toUpperCase()} · ${fmtSize(d.size)}${d.tenant_id && !d.visible_to_tenant ? ' · hidden from tenant' : ''}</div></td>
    <td>${badge(d.category)}</td>${showTenant ? html`<td>${d.tenant_name || 'All tenants'}</td>` : ''}
    <td class="hide-sm">${fmtDate(d.created_at)}<div class="mute small">${d.uploader_name}</div></td>
    <td class="right">${isLandlord() || d.uploaded_by === session.user.id ? html`<button class="sm danger" data-deldoc="${d.id}">Delete</button>` : ''}</td>
  </tr>`)}</tbody></table></div>` : html`<div class="empty">No documents yet.</div>`;

const uploadForm = ({ tenants = null, tenantId = null } = {}) => html`
  <form id="docform" class="card" style="background:var(--mutebg);border:0">
    <h3>Upload a document</h3>
    <div class="fields">
      <div class="field"><label>File (PDF, PNG, JPG, DOCX, TXT · max 10 MB)</label><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.docx,.txt" required></div>
      <div class="field"><label>Name (optional)</label><input name="name" maxlength="150" placeholder="e.g. Lease 2026–2027"></div>
      ${isLandlord() ? html`<div class="field"><label>Type</label><select name="category">${DOC_CATS.map(c => html`<option>${c}</option>`)}</select></div>` : ''}
      ${tenants ? html`<div class="field"><label>For</label><select name="tenant_id"><option value="all">All tenants (property-wide)</option>${tenants.map(t => html`<option value="${t.id}">${t.name}</option>`)}</select></div>` : ''}
    </div>
    ${isLandlord() && tenantId ? html`<input type="hidden" name="tenant_id" value="${tenantId}">` : ''}
    ${isLandlord() ? html`<div class="field"><label><input type="checkbox" name="visible" checked> Tenant can see this document</label></div>` : ''}
    <div class="err"></div><button class="primary" type="submit">Upload</button></form>`;

async function uploadDoc(d, file) {
  if (!file) throw new Error('Choose a file');
  if (file.size > 10 * 1024 * 1024) throw new Error('File is larger than 10 MB');
  const q = new URLSearchParams({ filename: file.name });
  for (const k of ['name', 'category', 'tenant_id']) if (d[k]) q.set(k, d[k]);
  if (d.visible === false) q.set('visible', '0');
  const res = await fetch('/api/documents?' + q, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'Upload failed');
}

function bindDocs(root, refresh) {
  const form = root.querySelector('#docform');
  if (form) submitter(root, '#docform', async d => { await uploadDoc(d, form.file.files[0]); toast('Document uploaded'); refresh(); });
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-deldoc]');
    if (!b || !confirm('Delete this document permanently?')) return;
    try { await api('/documents/' + b.dataset.deldoc, 'DELETE'); toast('Document deleted'); refresh(); } catch (err) { toast(err.message); }
  });
}

/** Delegated handlers for confirm/reject/void buttons inside `root`. */
function bindActions(root, refresh) {
  root.addEventListener('click', async e => {
    const r = e.target.closest('[data-review]'); const v = e.target.closest('[data-void]');
    try {
      if (r) { await api(`/payments/${r.dataset.review}/review`, 'POST', { status: r.dataset.status }); toast(r.dataset.status === 'confirmed' ? 'Payment confirmed' : 'Payment rejected'); refresh(); }
      if (v && confirm('Void this charge? It will be removed from the tenant\'s balance.')) { await api('/charges/' + v.dataset.void, 'DELETE'); toast('Charge voided'); refresh(); }
    } catch (err) { toast(err.message); }
  });
}

// ---------- tenant: pay modal ----------
function payLink(method, s, amount, note) {
  if (method === 'venmo' && s.venmo_handle) return `https://venmo.com/${encodeURIComponent(s.venmo_handle.replace(/^@/, ''))}?txn=pay&amount=${amount}&note=${encodeURIComponent(note)}`;
  if (method === 'cashapp' && s.cashapp_tag) return `https://cash.app/$${encodeURIComponent(s.cashapp_tag.replace(/^\$/, ''))}/${amount}`;
  return null;
}

function openPayModal(balanceCents, afterSave) {
  const s = session.settings;
  const avail = [];
  if (s.stripe_enabled) avail.push('ach');
  if (s.cashapp_tag) avail.push('cashapp');
  if (s.venmo_handle) avail.push('venmo');
  if (s.zelle_contact) avail.push('zelle');
  if (s.wire_instructions) avail.push('wire');
  avail.push('check', 'cash', 'other');
  const note = `Rent - ${session.user.name}`;

  modal(html`
    <h2>Make a payment</h2>
    <form id="f">
      <div class="field"><label>Amount ($)</label><input name="amount" type="number" step="0.01" min="0.01" value="${balanceCents > 0 ? dollars(balanceCents) : ''}" required></div>
      <label>How are you paying?</label>
      <div class="method">${avail.map((m, i) => html`<label><input type="radio" name="method" value="${m}" ${i === 0 ? 'checked' : ''}>${METHOD[m]}</label>`)}</div>
      <div id="how"></div>
      <div id="manual">
      <div class="field"><label>Confirmation / reference # (optional)</label><input name="reference" maxlength="100" placeholder="e.g. last 4 of transaction ID"></div>
      <div class="field"><label>Note (optional)</label><input name="note" maxlength="300"></div></div>
      <div class="err"></div>
      <div class="row"><button class="primary" type="submit" id="go">I've sent this payment</button><button type="button" data-close>Cancel</button></div>
      <p class="mute small"><span id="foot">Your landlord will confirm once the money arrives. Balance updates at that point.</span></p>
    </form>`, (root, close) => {
    const how = root.querySelector('#how');
    const update = () => {
      const m = root.querySelector('[name=method]:checked').value;
      const amt = Number(root.querySelector('[name=amount]').value || 0).toFixed(2);
      const link = payLink(m, s, amt, note);
      const text = {
        cashapp: `Send to $${(s.cashapp_tag || '').replace(/^\$/, '')} on Cash App.`,
        venmo: `Send to @${(s.venmo_handle || '').replace(/^@/, '')} on Venmo. Choose "Friends & Family" / avoid the goods & services fee if your landlord asks you to.`,
        ach: "Pay straight from your bank account. You'll log in to your bank on Stripe's secure page (we never see your bank login or account number). Your balance updates automatically once the debit clears, usually 3–5 business days.",
        zelle: `Send with Zelle to: ${s.zelle_contact}`,
        wire: s.wire_instructions,
        check: 'Hand or mail the check to your landlord, then report it here.',
        cash: 'Hand the cash to your landlord and ask for a receipt, then report it here.',
        other: 'Describe how you paid in the note below.',
      }[m];
      const ach = m === 'ach';
      root.querySelector('#manual').hidden = ach;
      root.querySelector('#go').textContent = ach ? 'Continue to secure bank login' : "I've sent this payment";
      root.querySelector('#foot').hidden = ach;
      how.innerHTML = html`<div class="box">${text}${s.payment_notes ? '\n\n' + s.payment_notes : ''}</div>${link ? html`<p><a class="btn" href="${link}" target="_blank" rel="noopener">Open ${METHOD[m]} with amount filled in ↗</a></p>` : ''}`.s;
    };
    root.addEventListener('input', update); update();
    submitter(root, '#f', async d => {
      if (d.method === 'ach') { const { url } = await api('/stripe/checkout', 'POST', { amount: d.amount }); location.href = url; return; }
      const r = await api('/payments', 'POST', d);
      close(); toast(r.status === 'confirmed' ? 'Payment recorded' : 'Thanks! Waiting on landlord confirmation.'); afterSave();
    });
  });
}

// ---------- tenant views ----------
route(/^\/$/, async () => {
  if (isLandlord()) return landlordDashboard();
  const [d, dep, insp] = await Promise.all([api('/me/ledger'), api('/me/deposit'), api('/inspections')]);
  const next = d.charges.filter(c => c.remaining_cents > 0 && c.status !== 'overdue').reverse()[0];
  const overdue = d.charges.filter(c => c.status === 'overdue');
  const recent = d.payments.slice(0, 5);
  return view(html`
    <h1>Hi, ${session.user.name.split(' ')[0]}</h1>
    <div class="grid">
      <div class="card stat"><div class="l">Current balance</div><div class="n">${money(Math.max(0, d.balance_cents))}</div>
        ${d.balance_cents < 0 ? html`<div class="l neg">You have a ${money(-d.balance_cents)} credit</div>` : ''}</div>
      ${d.overdue_cents > 0 ? html`<div class="card stat"><div class="l">Overdue</div><div class="n" style="color:var(--bad)">${money(d.overdue_cents)}</div></div>` : ''}
      ${d.pending_cents > 0 ? html`<div class="card stat"><div class="l">Awaiting confirmation</div><div class="n">${money(d.pending_cents)}</div></div>` : ''}
      ${next && !overdue.length ? html`<div class="card stat"><div class="l">Next due ${fmtDate(next.due_date)}</div><div class="n">${money(next.remaining_cents)}</div></div>` : ''}
    </div>
    <div class="card row sp"><div><h2 style="margin:0">Pay rent</h2><span class="mute small">Cash App, Venmo, Zelle, wire, and more</span></div>
      <button class="primary" id="pay">Make a payment</button></div>
    <div class="card"><h2>Recent payments</h2>${paymentsTable(recent)}</div>
    ${dep.entries.length ? html`<div class="card"><h2>Security deposit</h2><p><b style="font-size:20px">${money(dep.held_cents)}</b> <span class="mute">held by your landlords</span></p>
      <table><tbody>${dep.entries.map(e => html`<tr><td>${fmtDate(e.entry_date)}</td><td>${e.kind}</td><td>${e.note}</td><td class="right">${e.kind === 'received' || e.kind === 'interest' ? '+' : '−'}${money(e.amount_cents)}</td></tr>`)}</tbody></table></div>` : ''}
    ${insp.length ? html`<div class="card"><h2>Inspection reports</h2><table><tbody>${insp.map(i => html`<tr class="click" data-go="/inspections/${i.id}"><td><b>${i.kind === 'move_in' ? 'Move-in' : 'Move-out'}</b> · ${fmtDate(i.inspect_date)}</td><td>${i.acknowledged_at ? badge('confirmed') : badge('pending')} ${i.acknowledged_at ? 'reviewed' : 'please review'}</td></tr>`)}</tbody></table></div>` : ''}
    ${session.settings.contact_info ? html`<div class="card"><h3>Landlord contact</h3><div style="white-space:pre-wrap">${session.settings.contact_info}</div></div>` : ''}`,
  root => { bindRows(root); root.querySelector('#pay').onclick = () => openPayModal(d.balance_cents, render); });
});

route(/^\/ledger$/, async () => {
  const d = await api('/me/ledger');
  const yr = new Date().getFullYear();
  return view(html`<div class="row sp"><h1>Charges & payments</h1><span><a class="btn sm" href="/api/statement?year=${yr}" target="_blank">${yr} statement</a> <a class="btn sm" href="/api/statement?year=${yr - 1}" target="_blank">${yr - 1}</a></span></div>
    ${d.household.length > 1 ? html`<p class="mute small">Shared by ${d.household.map(h => h.name).join(' and ')}.</p>` : ''}
    <div class="card row sp"><h2 style="margin:0">Current balance</h2><b style="font-size:20px">${money(d.balance_cents)}</b></div>
    ${scheduleCards(d)}
    <div class="card"><h2>Payments</h2>${paymentsTable(d.payments)}</div>`);
});

route(/^\/account$/, async () => {
  const d = await api('/me/ledger');
  return view(html`<h1>Account</h1>
  <div class="card"><h2>${session.user.name}</h2><p class="mute">${session.user.email}</p>
  <p>Rent: <b>${money(session.user.rent_cents)}</b> due on day <b>${session.user.due_day}</b> of each month.
  ${session.user.lease_end ? html`<br>Lease ends ${fmtDate(session.user.lease_end)}.` : ''}
  ${d.household.length > 1 ? html`<br>On this lease: ${d.household.map(h => h.name).join(', ')}.` : ''}</p>
  <form id="prefs" style="max-width:420px"><div class="field"><label>Phone</label><input name="phone" value="${session.user.phone}"></div>
  <div class="field"><label><input type="checkbox" name="email_reminders" ${session.user.email_reminders ? 'checked' : ''}> Email me rent reminders</label></div>
  <div class="err"></div><button type="submit">Save</button></form></div>
  <div class="card" style="max-width:520px"><h2>Change password</h2>
  <form id="f"><div class="field"><label>Current password</label><input type="password" name="current" autocomplete="current-password" required></div>
  <div class="field"><label>New password</label><input type="password" name="password" autocomplete="new-password" minlength="8" required></div>
  <div class="err"></div><button class="primary" type="submit">Update password</button></form></div>
  ${F.securityCard()}`,
  root => {
    submitter(root, '#f', async d2 => { await api('/password', 'POST', d2); toast('Password updated'); root.querySelector('#f').reset(); });
    submitter(root, '#prefs', async d2 => { await api('/me', 'PUT', d2); session = null; toast('Saved'); render(); });
    F.bindSecurity(root);
  });
});

// ---------- tickets (both roles) ----------
route(/^\/tickets$/, async () => {
  const tickets = await api('/tickets');
  const L = isLandlord();
  return view(html`<div class="row sp"><h1>${L ? 'Tickets' : 'Maintenance requests'}</h1>${L ? '' : html`<button class="primary" id="new">New request</button>`}</div>
    <div class="card">${tickets.length ? html`<div class="table-wrap"><table><thead><tr><th>#</th><th>Issue</th>${L ? html`<th>Tenant</th>` : ''}<th>Priority</th><th>Status</th><th class="hide-sm">Updated</th></tr></thead>
    <tbody>${tickets.map(t => html`<tr class="click" data-go="/tickets/${t.id}"><td>${t.id}</td><td><b>${t.title}</b><div class="mute small">${t.category}${t.comment_count ? ` · ${t.comment_count} repl${t.comment_count == 1 ? 'y' : 'ies'}` : ''}</div></td>
    ${L ? html`<td>${t.tenant_name}</td>` : ''}<td>${badge(t.priority === 'normal' ? 'low' : t.priority)}</td><td>${badge(t.status)}</td><td class="hide-sm">${fmtTs(t.updated_at)}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">${L ? 'No tickets yet.' : 'Nothing open. Use "New request" to report a problem.'}</div>`}</div>`,
  root => {
    root.querySelectorAll('[data-go]').forEach(r => r.onclick = () => go(r.dataset.go));
    root.querySelector('#new')?.addEventListener('click', () => modal(html`<h2>New maintenance request</h2>
      <form id="f"><div class="field"><label>What's wrong?</label><input name="title" maxlength="150" required placeholder="e.g. Kitchen faucet is leaking"></div>
      <div class="fields"><div class="field"><label>Category</label><select name="category">${['plumbing', 'electrical', 'appliance', 'hvac', 'noise', 'other'].map(c => html`<option>${c}</option>`)}</select></div>
      <div class="field"><label>Priority</label><select name="priority"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="urgent">Urgent</option></select></div></div>
      <div class="field"><label>Details</label><textarea name="description" maxlength="4000" required></textarea></div>
      <p class="mute small">You can add photos on the next screen.</p>
      <div class="err"></div><div class="row"><button class="primary" type="submit">Submit</button><button type="button" data-close>Cancel</button></div></form>`,
    (m, close) => submitter(m, '#f', async d => { const r = await api('/tickets', 'POST', d); close(); go('/tickets/' + r.id); })));
  });
});

route(/^\/tickets\/(\d+)$/, async id => {
  const [{ ticket: t, comments }, photos] = await Promise.all([api('/tickets/' + id), api('/attachments?ticket_id=' + id)]);
  const L = isLandlord();
  return view(html`<p><a href="#/tickets">← All tickets</a></p>
    <div class="card"><div class="row sp"><h1 style="margin:0">${t.title}</h1><div>${badge(t.status)}</div></div>
      <p class="mute small">#${t.id} · ${t.category} · ${t.priority} priority · opened ${fmtTs(t.created_at)}${L ? ` by ${t.created_by_name || t.tenant_name}${t.unit ? ' (' + t.unit + ')' : ''}` : t.created_by_name ? ` by ${t.created_by_name}` : ''}</p>
      <p style="white-space:pre-wrap">${t.description}</p>
      ${F.photoBlock(photos, { deletable: p => L || p.uploaded_by === session.user.id })}${t.status === 'resolved' ? '' : F.photoUpload('ticket_id=' + id, 'Add photos')}
      <div class="row">${L
        ? ['open', 'in_progress', 'resolved'].map(s => html`<button class="sm ${t.status === s ? 'primary' : ''}" data-status="${s}">${s.replace('_', ' ')}</button>`)
        : t.status === 'resolved' ? '' : html`<button class="sm" data-status="resolved">Mark resolved</button>`}</div></div>
    <div class="card"><h2>Conversation</h2>
      ${comments.length ? comments.map(c => html`<div class="comment ${c.role} ${c.internal ? 'internal' : ''}"><b>${c.name}</b> ${c.internal ? html`<span class="badge pending">private note</span>` : ''} <span class="mute small">${fmtTs(c.created_at)}</span><div style="white-space:pre-wrap">${c.body}</div></div>`) : html`<p class="mute">No replies yet.</p>`}
      <form id="f"><div class="field"><textarea name="body" placeholder="Write a reply…" required></textarea></div>
      ${L ? html`<div class="field"><label><input type="checkbox" name="internal"> Private note (only you and your co-landlord see this)</label></div>` : ''}
      <div class="err"></div><button class="primary" type="submit">Send</button></form></div>`,
  root => {
    F.bindPhotos(root, render);
    submitter(root, '#f', async d => { await api(`/tickets/${id}/comments`, 'POST', d); render(); });
    root.querySelectorAll('[data-status]').forEach(b => b.onclick = async () => { await api(`/tickets/${id}/status`, 'PUT', { status: b.dataset.status }); toast('Ticket updated'); render(); });
  });
});

// ---------- landlord views ----------
async function landlordDashboard() {
  const d = await api('/dashboard');
  const pending = (await api('/payments')).filter(p => p.status === 'pending');
  return view(html`<h1>Dashboard</h1>
    <div class="grid">
      <div class="card stat"><div class="l">Outstanding</div><div class="n">${money(d.outstanding_cents)}</div></div>
      <div class="card stat"><div class="l">Overdue</div><div class="n" style="color:${d.overdue_cents ? 'var(--bad)' : 'inherit'}">${money(d.overdue_cents)}</div></div>
      <div class="card stat"><div class="l">Collected this month</div><div class="n">${money(d.collected_this_month_cents)}</div></div>
      <div class="card stat"><div class="l">Open tickets</div><div class="n">${d.open_tickets}</div></div></div>
    ${d.attention.length ? html`<div class="card"><h2>Needs attention</h2><table><tbody>${d.attention.map(a => html`<tr ${a.tenant_id ? raw(`class="click" data-go="/tenants/${a.tenant_id}"`) : ''}>
      <td>${a.kind === 'lease' ? html`<b>${a.name}</b>'s lease ends ${fmtDate(a.date)} (${a.days} day${a.days === 1 ? '' : 's'}). Decide on renewal or listing.`
        : a.kind === 'insurance' ? html`<b>${a.name}</b>'s renters insurance ${a.days < 0 ? 'expired' : 'expires'} ${fmtDate(a.date)}.`
        : a.kind === 'backup' ? html`<a href="#/settings">Download a backup</a> — ${a.date ? 'the last one was ' + fmtDate(a.date) : 'none has been downloaded yet'}.`
        : html`<a href="#/settings">Email isn't set up</a>, so reminders and alerts aren't being sent.`}</td></tr>`)}</tbody></table></div>` : ''}
    ${pending.length ? html`<div class="card"><h2>Payments waiting for you to confirm (${pending.length})</h2>${paymentsTable(pending, { admin: true, showTenant: true })}</div>` : ''}
    <div class="card"><div class="row sp"><h2>Tenants</h2><a class="btn" href="#/tenants">Manage</a></div>${tenantTable(d.tenants)}</div>`,
  root => { bindActions(root, render); bindRows(root); });
}

const tenantTable = tenants => tenants.length ? html`<div class="table-wrap"><table><thead><tr><th>Tenant</th><th class="hide-sm">Unit</th><th class="right">Rent</th><th class="right">Balance</th><th>Status</th></tr></thead>
  <tbody>${tenants.map(t => html`<tr class="click" data-go="/tenants/${t.id}"><td><b>${t.name}</b><div class="mute small">${t.email}</div></td><td class="hide-sm">${t.unit}</td>
  <td class="right">${money(t.rent_cents)}</td><td class="right">${money(t.balance_cents)}</td>
  <td>${!t.active ? badge('inactive') : t.pending_invite ? badge('pending') : t.overdue_cents > 0 ? badge('overdue') : t.balance_cents > 0 ? badge('due') : badge('paid')}</td></tr>`)}</tbody></table></div>`
  : html`<div class="empty">No tenants yet. Add your first tenant to get started.</div>`;
const bindRows = root => root.querySelectorAll('[data-go]').forEach(r => r.onclick = () => go(r.dataset.go));

const tenantForm = (t = {}) => html`
  <div class="fields"><div class="field"><label>Full name</label><input name="name" value="${t.name}" required></div>
  <div class="field"><label>Email (their login)</label><input name="email" type="email" value="${t.email}" required></div>
  <div class="field"><label>Phone</label><input name="phone" value="${t.phone}"></div>
  <div class="field"><label>Unit</label><input name="unit" value="${t.unit}"></div>
  <div class="field"><label>Monthly rent ($)</label><input name="rent" type="number" step="0.01" min="0" value="${t.rent_cents ? dollars(t.rent_cents) : ''}"></div>
  <div class="field"><label>Rent due day (1–28)</label><input name="due_day" type="number" min="1" max="28" value="${t.due_day || 1}"></div>
  <div class="field"><label>Lease start</label><input name="lease_start" type="date" value="${t.lease_start}"></div>
  <div class="field"><label>Lease end</label><input name="lease_end" type="date" value="${t.lease_end}"></div>
  <div class="field"><label>Late fee ($, 0 = none)</label><input name="late_fee" type="number" step="0.01" min="0" value="${t.late_fee_cents ? dollars(t.late_fee_cents) : ''}"></div>
  <div class="field"><label>Grace period (days)</label><input name="grace_days" type="number" min="0" value="${t.grace_days ?? 5}"></div></div>
  <div class="field"><label>Renters insurance expires</label><input name="insurance_expires" type="date" value="${t.insurance_expires}"></div>
  <div class="field"><label><input type="checkbox" name="email_reminders" ${t.email_reminders === false ? '' : 'checked'}> Send this tenant rent reminder emails</label></div>
  <div class="field"><label><input type="checkbox" name="auto_confirm" ${t.auto_confirm ? 'checked' : ''}> Auto-confirm this tenant's reported payments (skip my review)</label></div>`;

route(/^\/tenants$/, async () => {
  const tenants = await api('/tenants');
  return view(html`<div class="row sp"><h1>Tenants</h1><button class="primary" id="add">Add tenant</button></div><div class="card">${tenantTable(tenants)}</div>`,
  root => {
    bindRows(root);
    root.querySelector('#add').onclick = () => modal(html`<h2>Add tenant</h2><form id="f">${tenantForm()}<div class="err"></div>
      <div class="row"><button class="primary" type="submit">Add & create invite link</button><button type="button" data-close>Cancel</button></div></form>`,
    (m, close) => submitter(m, '#f', async d => { const r = await api('/tenants', 'POST', d); close(); go('/tenants/' + r.id); render(); }));
  });
});

const inviteUrl = token => `${location.origin}/#/invite/${token}`;

route(/^\/tenants\/(\d+)$/, async id => {
  const d = await api('/tenants/' + id);
  const [docs, dep, insp] = await Promise.all([api('/documents?tenant_id=' + id), api(`/tenants/${id}/deposit`), api('/inspections?tenant_id=' + id)]);
  const t = d.tenant;
  const yr = new Date().getFullYear();
  return view(html`<p><a href="#/tenants">← All tenants</a></p>
    <div class="card"><div class="row sp"><div><h1 style="margin:0">${t.name}</h1><span class="mute">${t.email}${t.phone ? ' · ' + t.phone : ''}${t.unit ? ' · ' + t.unit : ''}</span></div>
      <div class="row"><button id="edit">Edit terms</button><button class="primary" id="rec">Record payment</button><button id="chg">Add charge</button>
        <a class="btn" href="/api/statement?tenant_id=${id}&year=${yr}" target="_blank">Statement</a></div></div>
      ${d.invite_token ? html`<div class="box" style="margin-top:12px"><b>Invite link</b> (send this to ${t.name.split(' ')[0]} so they can set a password):\n<a href="${inviteUrl(d.invite_token)}">${inviteUrl(d.invite_token)}</a></div>`
        : html`<p><button class="sm" id="reinvite">Reset password / new invite link</button></p>`}</div>
    <div class="grid"><div class="card stat"><div class="l">Balance</div><div class="n">${money(d.balance_cents)}</div></div>
      <div class="card stat"><div class="l">Monthly rent</div><div class="n">${money(t.rent_cents)}</div><div class="l">due day ${t.due_day}</div></div>
      <div class="card stat"><div class="l">Pending payments</div><div class="n">${money(d.pending_cents)}</div></div></div>
    ${scheduleCards(d, { admin: true })}
    <div class="card"><h2>Payments</h2>${paymentsTable(d.payments, { admin: true })}</div>
    ${F.householdCard(t, d.members)}${F.depositCard(dep)}${F.inspectionsCard(insp)}
    <div class="card"><h2>Documents</h2>${docsTable(docs)}${uploadForm({ tenantId: id })}</div>`,
  root => {
    bindRows(root);
    F.bindTenantExtras(root, id, render, t);
    bindActions(root, render);
    bindDocs(root, render);
    root.querySelector('#reinvite')?.addEventListener('click', async () => {
      if (!confirm('This signs the tenant out and clears their password. Continue?')) return;
      await api(`/tenants/${id}/invite`, 'POST'); render();
    });
    root.querySelector('#edit').onclick = () => modal(html`<h2>Edit tenant</h2><form id="f">${tenantForm(t)}
      <div class="field"><label><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> Active tenant (uncheck to deactivate and block login)</label></div>
      <div class="err"></div><div class="row"><button class="primary" type="submit">Save</button><button type="button" data-close>Cancel</button></div></form>`,
    (m, close) => submitter(m, '#f', async d2 => { await api('/tenants/' + id, 'PUT', d2); close(); toast('Saved'); render(); }));
    root.querySelector('#chg').onclick = () => modal(html`<h2>Add charge or credit</h2><form id="f">
      <div class="field"><label>Type</label><select name="type"><option value="other">Other</option><option value="utility">Utility pass-through</option><option value="hoa">HOA / building fee</option><option value="parking">Parking</option><option value="repair">Repair / damage</option><option value="fee">Fee</option></select></div>
      <div class="field"><label>Description</label><input name="description" required placeholder="e.g. Water bill – September"></div>
      <div class="fields"><div class="field"><label>Amount ($) — negative for a credit</label><input name="amount" type="number" step="0.01" required></div>
      <div class="field"><label>Due date</label><input name="due_date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div></div>
      <div class="err"></div><div class="row"><button class="primary" type="submit">Add</button><button type="button" data-close>Cancel</button></div></form>`,
    (m, close) => submitter(m, '#f', async d2 => { await api(`/tenants/${id}/charges`, 'POST', d2); close(); toast('Charge added'); render(); }));
    root.querySelector('#rec').onclick = () => modal(html`<h2>Record a payment received</h2><form id="f">
      <div class="fields"><div class="field"><label>Amount ($)</label><input name="amount" type="number" step="0.01" min="0.01" required value="${d.balance_cents > 0 ? dollars(d.balance_cents) : ''}"></div>
      <div class="field"><label>Method</label><select name="method">${Object.entries(METHOD).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
      <div class="field"><label>Date received</label><input name="paid_date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>Reference</label><input name="reference"></div></div>
      <div class="err"></div><div class="row"><button class="primary" type="submit">Record</button><button type="button" data-close>Cancel</button></div></form>`,
    (m, close) => submitter(m, '#f', async d2 => { await api('/payments', 'POST', { ...d2, tenant_id: id }); close(); toast('Payment recorded'); render(); }));
  });
});

route(/^\/documents$/, async () => {
  const L = isLandlord();
  const [docs, tenants] = await Promise.all([api('/documents'), L ? api('/tenants') : null]);
  return view(html`<h1>Documents</h1>
    <div class="card">${L ? html`<p class="mute small">Leases, notices and other files. Pick a tenant to attach a document to their file, or "All tenants" for building-wide items like house rules.</p>` : html`<p class="mute small">Your lease and other documents from your landlord. You can also upload things like proof of renters insurance.</p>`}
    ${docsTable(docs, { showTenant: L })}${uploadForm({ tenants: L ? tenants.filter(t => t.active) : null })}</div>`,
  root => bindDocs(root, render));
});

route(/^\/payments$/, async () => {
  const p = await api('/payments');
  return view(html`<h1>Payments</h1><div class="card">${paymentsTable(p, { admin: true, showTenant: true })}</div>`, root => bindActions(root, render));
});

const F = {};
install({
  html, raw, esc, api, toast, modal, submitter, route, go, view, money, dollars, fmtDate, fmtTs, badge, isLandlord, render, bindActions, fmtSize, localToday, F,
  getSession: () => session,
  setSettings: s2 => { session.settings = s2; },
  reloadSession: () => { session = null; render(); },
});
render();
