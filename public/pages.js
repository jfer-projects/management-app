// Announcements, vendors, home guide, lease renewal and ticket repair details.
export function installPages(ctx) {
  const { html, api, toast, modal, submitter, route, view, money, dollars, fmtDate, fmtTs, badge, isLandlord, render, icon, emptyState, localToday, F } = ctx;

  // ---------- announcements ----------
  route(/^\/announcements$/, async () => {
    const list = await api('/announcements');
    return view(html`<div class="page-head"><div><h1>Announcements</h1><p>Posts appear on every tenant's home page. You can also email them.</p></div>
        <button class="primary" id="new">${icon('plus')} New announcement</button></div>
      ${list.length ? list.map(a => html`<div class="card"><div class="row sp"><h2 style="margin:0">${a.title}</h2><button class="sm danger" data-del="${a.id}">Delete</button></div>
        <p class="mute small" style="margin-top:4px">${fmtTs(a.created_at)} · ${a.by_name}</p><p style="white-space:pre-wrap;margin:0">${a.body}</p></div>`)
        : html`<div class="card">${emptyState('megaphone', 'No announcements yet. Use one for things like water shutoffs, building work or holiday notes.')}</div>`}`,
    root => {
      root.querySelector('#new').onclick = () => modal(html`<h2>New announcement</h2><form id="f">
        <div class="field"><label>Title</label><input name="title" maxlength="150" required placeholder="e.g. Water shut off Tuesday 9am–noon"></div>
        <div class="field"><label>Message</label><textarea name="body" required style="min-height:130px"></textarea></div>
        <div class="field"><label><input type="checkbox" name="email" checked> Also email every tenant</label></div><div class="err"></div>
        <div class="row"><button class="primary" type="submit">Post</button><button type="button" data-close>Cancel</button></div></form>`,
      (m, close) => submitter(m, '#f', async d => { await api('/announcements', 'POST', d); close(); toast('Posted'); render(); }));
      root.addEventListener('click', async e => {
        const b = e.target.closest('[data-del]');
        if (b && confirm('Delete this announcement?')) { await api('/announcements/' + b.dataset.del, 'DELETE'); render(); }
      });
    });
  });

  // ---------- vendors ----------
  const vendorForm = (v = {}) => html`<div class="fields"><div class="field"><label>Name</label><input name="name" value="${v.name}" required></div>
    <div class="field"><label>Trade</label><input name="trade" value="${v.trade}" placeholder="Plumber, electrician, HVAC…"></div>
    <div class="field"><label>Phone</label><input name="phone" value="${v.phone}"></div><div class="field"><label>Email</label><input name="email" type="email" value="${v.email}"></div></div>
    <div class="field"><label>Notes</label><textarea name="notes">${v.notes}</textarea></div>`;

  route(/^\/vendors$/, async () => {
    const vendors = await api('/vendors');
    return view(html`<div class="page-head"><div><h1>Vendors</h1><p>Your go-to plumber, electrician and more. Assign them to repair tickets to track what each job cost.</p></div>
        <button class="primary" id="new">${icon('plus')} Add vendor</button></div>
      ${vendors.length ? html`<div class="grid">${vendors.map(v => html`<div class="card"><div class="row sp"><div class="person">${ctx.avatar(v.name)}<div><b>${v.name}</b>${v.trade ? html`<div class="mute small">${v.trade}</div>` : ''}</div></div>
        <button class="sm" data-edit="${v.id}">Edit</button></div>
        <div style="margin-top:14px;display:grid;gap:6px">${v.phone ? html`<a href="tel:${v.phone}">${icon('phone')} ${v.phone}</a>` : ''}${v.email ? html`<a href="mailto:${v.email}">${icon('mail')} ${v.email}</a>` : ''}</div>
        ${v.notes ? html`<p class="mute small" style="white-space:pre-wrap;margin-top:12px">${v.notes}</p>` : ''}
        <hr><div class="row sp small"><span class="mute">${v.jobs} job${v.jobs === 1 ? '' : 's'}</span><b>${money(v.spent_cents)} spent</b></div></div>`)}</div>`
        : html`<div class="card">${emptyState('contact', 'No vendors yet. Add the people you call when something breaks.')}</div>`}`,
    root => {
      const open = (v = {}) => modal(html`<h2>${v.id ? 'Edit vendor' : 'Add vendor'}</h2><form id="f">${vendorForm(v)}<div class="err"></div>
        <div class="row"><button class="primary" type="submit">Save</button>${v.id ? html`<button type="button" class="danger" id="del">Delete</button>` : ''}<button type="button" data-close>Cancel</button></div></form>`,
      (m, close) => {
        submitter(m, '#f', async d => { await api(v.id ? '/vendors/' + v.id : '/vendors', v.id ? 'PUT' : 'POST', d); close(); render(); });
        m.querySelector('#del')?.addEventListener('click', async () => { if (confirm('Delete this vendor? Past tickets keep their cost.')) { await api('/vendors/' + v.id, 'DELETE'); close(); render(); } });
      });
      root.querySelector('#new').onclick = () => open();
      root.addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) open(vendors.find(v => v.id == b.dataset.edit)); });
    });
  });

  // ---------- home guide ----------
  const GUIDE = [['welcome', 'Welcome', 'home', 'Say hello and set expectations'], ['trash', 'Trash & recycling', 'inbox', 'Pickup days, where bins go'],
    ['parking', 'Parking', 'key', 'Assigned spot, guest rules'], ['quiet_hours', 'Quiet hours & house rules', 'clock', ''], ['laundry', 'Laundry', 'tool', ''],
    ['internet', 'Internet & cable', 'mail', 'Providers, setup tips'], ['emergency', 'Emergency contacts', 'phone', 'After-hours repairs, building super, water shutoff location'],
    ['utilities', 'Utilities & accounts', 'dollar', 'Who is billed for what'], ['appliances', 'Appliances & how-tos', 'book', 'Thermostat, dishwasher, filters'], ['other', 'Anything else', 'file', '']];

  route(/^\/home-guide$/, async () => {
    const g = await api('/home-guide');
    if (!isLandlord()) {
      const filled = GUIDE.filter(([k]) => g[k]);
      return view(html`<div class="page-head"><div><h1>Your home</h1><p>Handy information from your landlords.</p></div></div>
        ${filled.length ? html`<div class="grid">${filled.map(([k, label, ic]) => html`<div class="card"><div class="row" style="margin-bottom:10px"><div class="ico">${icon(ic)}</div><h2 style="margin:0">${label}</h2></div><div style="white-space:pre-wrap">${g[k]}</div></div>`)}</div>`
          : html`<div class="card">${emptyState('book', "Your landlords haven't added any home information yet.")}</div>`}`);
    }
    return view(html`<div class="page-head"><div><h1>Home guide</h1><p>Info your tenants see under "Your home". Leave a box empty to hide it. Avoid putting passwords or door codes here you wouldn't want every tenant of this unit to see.</p></div></div>
      <form id="f" class="card"><div class="grid" style="margin:0">${GUIDE.map(([k, label, , ph]) => html`<div class="field"><label>${label}</label><textarea name="${k}" placeholder="${ph}" style="min-height:90px">${g[k]}</textarea></div>`)}</div>
      <div class="err"></div><button class="primary" type="submit">Save</button></form>`,
    root => submitter(root, '#f', async d => { await api('/home-guide', 'PUT', d); toast('Saved'); }));
  });

  // ---------- lease card + renewal (tenant detail) ----------
  F.leaseCard = (t, hist) => html`<div class="card"><div class="row sp"><h2 style="margin:0">Lease</h2><button class="sm" id="renew">Renew / change rent</button></div>
    <p class="mute small" style="margin-top:6px">${t.lease_start ? fmtDate(t.lease_start) : 'No start date'} → ${t.lease_end ? fmtDate(t.lease_end) : 'no end date'} · ${money(t.rent_cents)} per month</p>
    ${hist.length ? html`<table><thead><tr><th>When</th><th>Change</th><th>By</th></tr></thead><tbody>${hist.map(h => html`<tr><td>${fmtDate(h.created_at)}</td>
      <td>Lease end ${h.old_end ? fmtDate(h.old_end) : '—'} → <b>${fmtDate(h.new_end)}</b>${h.old_rent_cents !== h.new_rent_cents ? html`<br>Rent ${money(h.old_rent_cents)} → <b>${money(h.new_rent_cents)}</b> from ${fmtDate(h.effective_date)}` : ''}${h.note ? html`<div class="mute small">${h.note}</div>` : ''}</td><td>${h.by_name}</td></tr>`)}</tbody></table>` : ''}</div>`;

  F.bindLease = (root, id, refresh, t) => {
    root.querySelector('#renew')?.addEventListener('click', () => {
      const y = t.lease_end ? String(Number(t.lease_end.slice(0, 4)) + 1) + t.lease_end.slice(4) : '';
      modal(html`<h2>Renew lease / change rent</h2><form id="f"><div class="fields">
        <div class="field"><label>New lease end date</label><input type="date" name="new_end" value="${y}" required></div>
        <div class="field"><label>New monthly rent ($)</label><input type="number" name="rent" step="0.01" min="0" placeholder="${dollars(t.rent_cents)} (unchanged)"></div>
        <div class="field"><label>New rent starts</label><input type="date" name="effective_date" value="${t.lease_end || localToday()}"></div></div>
        <div class="field"><label>Note (optional, included in the email)</label><input name="note" maxlength="300"></div>
        <div class="field"><label><input type="checkbox" name="email" checked> Email the tenant(s) about this</label></div>
        <p class="mute small">Rent already billed on or after the start date is updated to the new amount. Many places require advance written notice before a rent increase; check yours.</p>
        <div class="err"></div><div class="row"><button class="primary" type="submit">Save</button><button type="button" data-close>Cancel</button></div></form>`,
      (m, close) => submitter(m, '#f', async d => { await api(`/tenants/${id}/renew`, 'POST', d); close(); toast('Lease updated'); refresh(); }));
    });
  };

  // ---------- ticket repair details (landlord only) ----------
  F.workCard = (t, vendors) => html`<div class="card"><h2>Repair details <span class="mute small" style="font-weight:500">· only you can see this</span></h2>
    <form id="work"><div class="fields"><div class="field"><label>Vendor</label><select name="vendor_id"><option value="">None</option>${vendors.map(v => html`<option value="${v.id}" ${v.id === t.vendor_id ? 'selected' : ''}>${v.name}${v.trade ? ' · ' + v.trade : ''}</option>`)}</select></div>
      <div class="field"><label>Cost ($)</label><input name="cost" type="number" step="0.01" min="0.01" value="${t.cost_cents != null ? dollars(t.cost_cents) : ''}"></div></div>
      <div class="err"></div><div class="row"><button type="submit">Save</button>${t.cost_cents ? html`<button type="button" id="toexp">Add to expenses</button>` : ''}
      <a href="#/vendors" class="small">Manage vendors</a></div></form></div>`;

  F.bindWork = (root, id, t) => {
    submitter(root, '#work', async d => { await api(`/tickets/${id}/work`, 'PUT', d); toast('Saved'); render(); });
    root.querySelector('#toexp')?.addEventListener('click', async () => {
      try {
        await api('/expenses', 'POST', { category: 'repairs & maintenance', vendor: t.vendor_name || '', description: `Ticket #${id}: ${t.title}`, amount: dollars(t.cost_cents), date: localToday() });
        toast('Added to expenses');
      } catch (e) { toast(e.message); }
    });
  };
}
