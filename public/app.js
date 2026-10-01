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
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.6c2.3.2 3.9 1.7 4.5 4.4"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M2.5 10h19"/><path d="M6.5 15h4"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5 5L3.5 17.5a2 2 0 0 0 3 3l6.2-6.2a4 4 0 0 0 5-5l-2.4 2.4-2.3-.6-.6-2.3z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10"/><path d="M8 7h4M8 11h4M8 15h4M2 21h20"/>',
  megaphone: '<path d="M3 11v3a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 8a5 5 0 0 1 0 8"/><path d="M18 5a9 9 0 0 1 0 14"/>',
  contact: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 17c.5-2 2-3 3.5-3s3 1 3.5 3M15 9.5h3M15 13h3"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 18V5.5M9 8h7"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4M12 17.4v.1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  dollar: '<path d="M12 3v18M16.5 7.5c-.7-1.2-2.3-2-4.5-2-2.6 0-4 1.2-4 2.9 0 4.6 8.5 2.1 8.5 6.4 0 1.8-1.6 3-4.2 3-2.2 0-3.9-.8-4.7-2.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 7l9 6 9-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
};
const icon = n => raw(`<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`);
const hue = s2 => [...String(s2)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (name, cls = '') => html`<span class="avatar ${cls}" style="--h:${hue(name)}">${initials(name)}</span>`;
const stat = (label, value, { icon: ic, tone = '', sub = '', color = '' } = {}) => html`<div class="card stat"><div class="l">${label}</div>
  <div class="n" ${color ? raw(`style="color:${color}"`) : ''}>${value}</div>${sub ? html`<div class="sub">${sub}</div>` : ''}${ic ? html`<div class="ico ${tone}">${icon(ic)}</div>` : ''}</div>`;
const emptyState = (ic, text) => html`<div class="empty"><div class="ico">${icon(ic)}</div>${text}</div>`;
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
      if (m) {
        if (isLandlord()) counts = await api('/counts').catch(() => null);
        return shell(hash, await fn(...m.slice(1)));
      }
    }
    go('/');
  } catch (e) {
    if (e.status === 401) { session = null; return render(); }
    $app.innerHTML = html`<main><div class="card"><p class="err">${e.message}</p><a href="#/">Back to start</a></div></main>`.s;
  }
}
window.addEventListener('hashchange', render);

let counts = null;
function shell(hash, view) {
  const L = isLandlord();
  const groups = L ? [
    ['', [['/', 'Dashboard', 'home'], ['/tenants', 'Tenants', 'users'], ['/payments', 'Payments', 'card', 'pending_payments'], ['/tickets', 'Tickets', 'tool', 'open_tickets']]],
    ['Records', [['/documents', 'Documents', 'file'], ['/finances', 'Finances', 'chart'], ['/vendors', 'Vendors', 'contact']]],
    ['Property', [['/property', 'Listing & photos', 'building'], ['/announcements', 'Announcements', 'megaphone'], ['/home-guide', 'Home guide', 'book']]],
  ] : [
    ['', [['/', 'Home', 'home'], ['/ledger', 'Charges & payments', 'card'], ['/tickets', 'Repair requests', 'tool'], ['/documents', 'Documents', 'file'], ['/home-guide', 'Your home', 'book']]],
  ];
  const active = t => (t === '/' ? hash === '/' : hash.startsWith(t));
  const link = ([h, label, ic, badgeKey]) => html`<a class="nav ${active(h) ? 'on' : ''}" href="#${h}">${icon(ic)}<span>${label}</span>${badgeKey && counts?.[badgeKey] ? html`<span class="pill">${counts[badgeKey]}</span>` : ''}</a>`;
  const name = session.settings.property_name || 'Rental Portal';
  $app.innerHTML = html`<div class="layout">
    <aside class="side" id="side">
      <div class="logo-row"><div class="logo">${icon('building')}</div><div><b>${name}</b><span>${L ? 'Landlord portal' : 'Resident portal'}</span></div></div>
      ${groups.map(([label, items]) => html`${label ? html`<div class="nav-label">${label}</div>` : ''}${items.map(link)}`)}
      <div style="flex:1"></div>
      ${link(L ? ['/settings', 'Settings', 'cog'] : ['/account', 'Account', 'cog'])}
      <div class="me">${avatar(session.user.name)}<div class="who"><b>${session.user.name}</b><span>${L ? 'Landlord' : 'Tenant'}</span></div>
        <button id="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button></div>
    </aside>
    <div class="scrim" id="scrim"></div>
    <div class="content">
      <header class="mobilebar"><div class="logo">${icon('building')}</div><b>${name}</b><button id="menu" aria-label="Menu">${icon('menu')}</button></header>
      <main>${view}</main>
    </div></div>`.s;
  document.body.classList.remove('menu-open');
  document.getElementById('menu').onclick = () => document.body.classList.toggle('menu-open');
  document.getElementById('scrim').onclick = () => document.body.classList.remove('menu-open');
  document.getElementById('logout').onclick = async () => { await api('/logout', 'POST'); session = null; counts = null; go('/'); render(); };
  // Any table not already in a scroll wrapper gets one, so wide tables scroll inside their card on phones.
  $app.querySelectorAll('main table').forEach(t => {
    if (t.parentElement.classList.contains('table-wrap')) return;
    const w = document.createElement('div'); w.className = 'table-wrap'; t.replaceWith(w); w.appendChild(t);
  });
  window.scrollTo(0, 0);
  view.mount?.($app.querySelector('main'));
}
// Views return html with an optional .mount(root) hook.
const view = (content, mount) => Object.assign(content, { mount });

// ---------- auth views ----------
function authCard(title, body, mount) {
  const prop = session?.settings?.property_name || 'Rental Portal';
  $app.innerHTML = html`<div class="auth-wrap">
    <section class="auth-brand">
      <div class="logo-row"><div class="logo">${icon('building')}</div><div><b>${prop}</b><span>Resident &amp; landlord portal</span></div></div>
      <div><h2>Your home, handled.</h2><p>Pay rent, request repairs and keep every document in one secure place.</p>
        <ul class="auth-points"><li><span class="ico">${icon('card')}</span>See what's due and pay your way</li><li><span class="ico">${icon('tool')}</span>Request repairs with photos</li><li><span class="ico">${icon('file')}</span>Leases and documents, always at hand</li></ul></div>
      <small style="opacity:.6">Secure sign-in with optional two-factor authentication</small>
    </section>
    <section class="auth-form"><div class="auth-card"><h1>${title}</h1><div class="card">${body}</div></div></section></div>`.s;
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
  </tr>`)}</tbody></table></div>` : emptyState('file', 'No charges yet.');

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
  </tr>`)}</tbody></table></div>` : emptyState('card', 'No payments yet.');

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
  </tr>`)}</tbody></table></div>` : emptyState('file', 'No documents yet.');

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
  const [d, dep, insp, news] = await Promise.all([api('/me/ledger'), api('/me/deposit'), api('/inspections'), api('/announcements')]);
  const next = d.charges.filter(c => c.remaining_cents > 0 && c.status !== 'overdue').reverse()[0];
  const overdue = d.charges.filter(c => c.status === 'overdue');
  const recent = d.payments.slice(0, 5);
  return view(html`
    <div class="page-head"><div><h1>Hi, ${session.user.name.split(' ')[0]}</h1><p>${session.settings.property_name || ''}</p></div></div>
    ${news.filter(n => Date.now() - Date.parse(n.created_at.replace(' ', 'T') + 'Z') < 60 * 86400000).slice(0, 3).map(n => html`<div class="notice"><b>${n.title}</b><div style="white-space:pre-wrap">${n.body}</div><div class="when">${fmtDate(n.created_at)} · ${n.by_name}</div></div>`)}
    <div class="hero"><div>
      <div class="eyebrow">${d.overdue_cents > 0 ? 'Amount overdue' : d.balance_cents > 0 ? 'Balance due' : "You're all paid up"}</div>
      <div class="amt">${money(Math.max(0, d.balance_cents))}</div>
      <div class="note">${d.overdue_cents > 0 ? `${money(d.overdue_cents)} is past due. ` : ''}${d.balance_cents < 0 ? `You have a ${money(-d.balance_cents)} credit. ` : ''}${next ? `Next charge ${money(next.remaining_cents)} on ${fmtDate(next.due_date)}.` : d.scheduled?.[0] ? `Next rent ${money(d.scheduled[0].amount_cents)} on ${fmtDate(d.scheduled[0].due_date)}.` : ''}${d.pending_cents > 0 ? ` ${money(d.pending_cents)} awaiting confirmation.` : ''}</div></div>
      <button class="btn light" id="pay">Make a payment</button></div>
    <div class="grid">
      ${stat('Monthly rent', money(session.user.rent_cents), { icon: 'dollar', sub: `Due on day ${session.user.due_day} of each month` })}
      ${dep.held_cents > 0 ? stat('Security deposit', money(dep.held_cents), { icon: 'shield', tone: 'ok', sub: 'Held by your landlords' }) : ''}
      ${session.user.lease_start && session.user.lease_end ? (() => {
        const a = Date.parse(session.user.lease_start), b = Date.parse(session.user.lease_end), pct = Math.max(0, Math.min(100, Math.round((Date.now() - a) / (b - a) * 100)));
        const left = Math.max(0, Math.round((b - Date.now()) / (30.4 * 86400000)));
        return html`<div class="card stat"><div class="l">Lease ends</div><div class="n" style="font-size:22px">${fmtDate(session.user.lease_end)}</div>
          <div class="progress" style="margin:10px 0 6px"><span style="width:${pct}%"></span></div><div class="sub">${left} month${left === 1 ? '' : 's'} remaining</div><div class="ico info">${icon('calendar')}</div></div>`;
      })() : ''}
    </div>
    <div class="card"><div class="row sp" style="margin-bottom:6px"><h2 style="margin:0">Recent payments</h2><a class="btn sm" href="#/ledger">View all</a></div>${paymentsTable(recent)}</div>
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
  const [{ ticket: t, comments }, photos, vendors] = await Promise.all([api('/tickets/' + id), api('/attachments?ticket_id=' + id), isLandlord() ? api('/vendors') : []]);
  const L = isLandlord();
  return view(html`<a class="back" href="#/tickets">${icon('back')} All tickets</a>
    <div class="card"><div class="row sp"><h1 style="margin:0">${t.title}</h1><div>${badge(t.status)}</div></div>
      <p class="mute small">#${t.id} · ${t.category} · ${t.priority} priority · opened ${fmtTs(t.created_at)}${L ? ` by ${t.created_by_name || t.tenant_name}${t.unit ? ' (' + t.unit + ')' : ''}` : t.created_by_name ? ` by ${t.created_by_name}` : ''}</p>
      <p style="white-space:pre-wrap">${t.description}</p>
      ${F.photoBlock(photos, { deletable: p => L || p.uploaded_by === session.user.id })}${t.status === 'resolved' ? '' : F.photoUpload('ticket_id=' + id, 'Add photos')}
      <div class="row">${L
        ? ['open', 'in_progress', 'resolved'].map(s => html`<button class="sm ${t.status === s ? 'primary' : ''}" data-status="${s}">${s.replace('_', ' ')}</button>`)
        : t.status === 'resolved' ? '' : html`<button class="sm" data-status="resolved">Mark resolved</button>`}</div></div>
    ${L ? F.workCard(t, vendors) : ''}
    <div class="card"><h2>Conversation</h2>
      ${comments.length ? comments.map(c => html`<div class="comment ${c.role} ${c.internal ? 'internal' : ''}"><b>${c.name}</b> ${c.internal ? html`<span class="badge pending">private note</span>` : ''} <span class="mute small">${fmtTs(c.created_at)}</span><div style="white-space:pre-wrap">${c.body}</div></div>`) : html`<p class="mute">No replies yet.</p>`}
      <form id="f"><div class="field"><textarea name="body" placeholder="Write a reply…" required></textarea></div>
      ${L ? html`<div class="field"><label><input type="checkbox" name="internal"> Private note (only you and your co-landlord see this)</label></div>` : ''}
      <div class="err"></div><button class="primary" type="submit">Send</button></form></div>`,
  root => {
    F.bindPhotos(root, render);
    if (L) F.bindWork(root, id, t);
    submitter(root, '#f', async d => { await api(`/tickets/${id}/comments`, 'POST', d); render(); });
    root.querySelectorAll('[data-status]').forEach(b => b.onclick = async () => { await api(`/tickets/${id}/status`, 'PUT', { status: b.dataset.status }); toast('Ticket updated'); render(); });
  });
});

// ---------- landlord views ----------
async function landlordDashboard() {
  const d = await api('/dashboard');
  const pending = (await api('/payments')).filter(p => p.status === 'pending');
  const hr = new Date().getHours();
  const hello = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const note = a => a.kind === 'lease' ? html`<b>${a.name}</b>'s lease ends ${fmtDate(a.date)} (${a.days} day${a.days === 1 ? '' : 's'}). Time to decide on renewal or listing.`
    : a.kind === 'insurance' ? html`<b>${a.name}</b>'s renters insurance ${a.days < 0 ? 'expired' : 'expires'} ${fmtDate(a.date)}.`
    : a.kind === 'backup' ? html`<a href="#/settings">Download a backup</a> — ${a.date ? 'the last one was ' + fmtDate(a.date) : 'none has been downloaded yet'}.`
    : html`<a href="#/settings">Email isn't set up</a>, so reminders and alerts aren't being sent.`;
  return view(html`<div class="page-head"><div><h1>${hello}, ${session.user.name.split(' ')[0]}</h1>
      <p>${session.settings.property_name || ''} · ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
      <div class="row"><a class="btn" href="#/tenants">${icon('users')} Tenants</a><a class="btn primary" href="#/tickets">${icon('tool')} Open tickets</a></div></div>
    <div class="grid">
      ${stat('Outstanding', money(d.outstanding_cents), { icon: 'dollar', tone: d.outstanding_cents ? 'warn' : 'ok', sub: 'Due from tenants today' })}
      ${stat('Overdue', money(d.overdue_cents), { icon: 'alert', tone: d.overdue_cents ? 'bad' : 'ok', color: d.overdue_cents ? 'var(--bad)' : '', sub: d.overdue_cents ? 'Needs follow-up' : 'Everyone is current' })}
      ${stat('Collected this month', money(d.collected_this_month_cents), { icon: 'check', tone: 'ok', sub: 'Confirmed payments' })}
      ${stat('Open tickets', d.open_tickets, { icon: 'tool', tone: 'info', sub: d.open_tickets ? 'Awaiting attention' : 'All caught up' })}</div>
    ${d.attention.length ? html`<div class="card"><h2>Needs attention</h2>${d.attention.map(a => html`<div class="callout ${a.kind === 'insurance' && a.days < 0 ? 'bad' : ''}" ${a.tenant_id ? raw(`data-go="/tenants/${a.tenant_id}" style="cursor:pointer"`) : ''}>
      <div class="ico ${a.kind === 'lease' ? 'info' : 'warn'}">${icon(a.kind === 'lease' ? 'calendar' : a.kind === 'insurance' ? 'shield' : a.kind === 'backup' ? 'file' : 'mail')}</div><div>${note(a)}</div></div>`)}</div>` : ''}
    ${pending.length ? html`<div class="card"><h2>Payments waiting for you to confirm (${pending.length})</h2>${paymentsTable(pending, { admin: true, showTenant: true })}</div>` : ''}
    <div class="card"><div class="row sp" style="margin-bottom:8px"><h2 style="margin:0">Tenants</h2><a class="btn sm" href="#/tenants">Manage</a></div>${tenantTable(d.tenants)}</div>`,
  root => { bindActions(root, render); bindRows(root); });
}

const tenantTable = tenants => tenants.length ? html`<div class="table-wrap"><table><thead><tr><th>Tenant</th><th class="hide-sm">Unit</th><th class="right">Rent</th><th class="right">Balance</th><th>Status</th></tr></thead>
  <tbody>${tenants.map(t => html`<tr class="click" data-go="/tenants/${t.id}"><td><div class="person">${avatar(t.name)}<div><b>${t.name}${t.members?.length ? ' & ' + t.members.join(', ') : ''}</b><div class="mute small">${t.email}</div></div></div></td><td class="hide-sm">${t.unit}</td>
  <td class="right">${money(t.rent_cents)}</td><td class="right">${money(t.balance_cents)}</td>
  <td>${!t.active ? badge('inactive') : t.pending_invite ? badge('pending') : t.overdue_cents > 0 ? badge('overdue') : t.balance_cents > 0 ? badge('due') : badge('paid')}</td></tr>`)}</tbody></table></div>`
  : emptyState('users', 'No tenants yet. Add your first tenant to get started.');
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
  const [docs, dep, insp, hist] = await Promise.all([api('/documents?tenant_id=' + id), api(`/tenants/${id}/deposit`), api('/inspections?tenant_id=' + id), api(`/tenants/${id}/lease-history`)]);
  const t = d.tenant;
  const yr = new Date().getFullYear();
  return view(html`<a class="back" href="#/tenants">${icon('back')} All tenants</a>
    <div class="card"><div class="row sp"><div class="person">${avatar(t.name, 'lg')}<div><h1 style="margin:0">${t.name}</h1><span class="mute">${t.email}${t.phone ? ' · ' + t.phone : ''}${t.unit ? ' · ' + t.unit : ''}</span></div></div>
      <div class="row"><button id="edit">Edit terms</button><button class="primary" id="rec">Record payment</button><button id="chg">Add charge</button>
        <a class="btn" href="/api/statement?tenant_id=${id}&year=${yr}" target="_blank">Statement</a></div></div>
      ${d.invite_token ? html`<div class="box" style="margin-top:12px"><b>Invite link</b> (send this to ${t.name.split(' ')[0]} so they can set a password):\n<a href="${inviteUrl(d.invite_token)}">${inviteUrl(d.invite_token)}</a></div>`
        : html`<p><button class="sm" id="reinvite">Reset password / new invite link</button></p>`}</div>
    <div class="grid">${stat('Balance', money(d.balance_cents), { icon: 'dollar', tone: d.balance_cents > 0 ? 'warn' : 'ok', sub: d.overdue_cents ? money(d.overdue_cents) + ' overdue' : 'Nothing overdue' })}
      ${stat('Monthly rent', money(t.rent_cents), { icon: 'card', sub: 'Due on day ' + t.due_day })}
      ${stat('Pending payments', money(d.pending_cents), { icon: 'clock', tone: d.pending_cents ? 'warn' : '', sub: 'Waiting for confirmation' })}</div>
    ${scheduleCards(d, { admin: true })}
    <div class="card"><h2>Payments</h2>${paymentsTable(d.payments, { admin: true })}</div>
    ${F.leaseCard(t, hist)}${F.householdCard(t, d.members)}${F.depositCard(dep)}${F.inspectionsCard(insp)}
    <div class="card"><h2>Documents</h2>${docsTable(docs)}${uploadForm({ tenantId: id })}</div>`,
  root => {
    bindRows(root);
    F.bindTenantExtras(root, id, render, t);
    F.bindLease(root, id, render, t);
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
  icon, avatar, stat, emptyState, paymentsTable,
  getSession: () => session,
  setSettings: s2 => { session.settings = s2; },
  reloadSession: () => { session = null; render(); },
});
render();
