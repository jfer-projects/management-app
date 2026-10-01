// Newer pages and widgets. app.js calls install() with its shared helpers before the first render.
export function install(ctx) {
  const { html, raw, api, toast, modal, submitter, route, go, view, money, dollars, fmtDate, fmtTs, badge, esc, getSession, isLandlord, render, bindActions, fmtSize } = ctx;
  const F = ctx.F;

  // ---------- photos & attachments ----------
  /** Shrinks big phone photos before upload (keeps files well under the 10 MB limit). */
  async function prepImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1024 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }

  async function uploadAttachment(file, query) {
    const f = await prepImage(file);
    if (f.size > 10 * 1024 * 1024) throw new Error(`${file.name} is larger than 10 MB`);
    const q = new URLSearchParams(query); q.set('filename', f.name);
    const res = await fetch('/api/attachments?' + q, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Upload failed');
    return out;
  }

  const photoBlock = (photos, { deletable = () => false } = {}) => photos.length ? html`<div class="photos">${photos.map(p => html`<figure>
    <a href="/api/attachments/${p.id}/file" target="_blank" rel="noopener">${/^(pdf)$/.test(p.ext) ? html`<div class="pdfthumb">PDF</div>` : html`<img loading="lazy" src="/api/attachments/${p.id}/file" alt="${p.caption || p.name}">`}</a>
    ${p.caption ? html`<figcaption>${p.caption}</figcaption>` : ''}${deletable(p) ? html`<button class="sm danger" data-delphoto="${p.id}">Remove</button>` : ''}</figure>`)}</div>` : '';
  const photoUpload = (query, label = 'Add photos', accept = 'image/jpeg,image/png,image/webp') =>
    html`<div class="field"><label>${label}</label><input type="file" accept="${accept}" multiple data-upload="${query}"></div>`;

  function bindPhotos(root, refresh) {
    root.addEventListener('change', async e => {
      const inp = e.target.closest('[data-upload]'); if (!inp || !inp.files.length) return;
      const query = Object.fromEntries(new URLSearchParams(inp.dataset.upload));
      inp.disabled = true;
      try { let n = 0; for (const f of inp.files) { await uploadAttachment(f, query); toast(`Uploaded ${++n} of ${inp.files.length}`); } refresh(); }
      catch (err) { toast(err.message); inp.value = ''; }
      finally { inp.disabled = false; }
    });
    root.addEventListener('click', async e => {
      const b = e.target.closest('[data-delphoto]');
      if (!b || !confirm('Remove this file?')) return;
      try { await api('/attachments/' + b.dataset.delphoto, 'DELETE'); refresh(); } catch (err) { toast(err.message); }
    });
  }
  Object.assign(F, { photoBlock, photoUpload, bindPhotos });

  // ---------- security card (2FA) ----------
  F.securityCard = () => {
    const u = getSession().user;
    return html`<div class="card" id="sec"><h2>Two-factor sign-in</h2>
      ${u.totp_enabled ? html`<p><span class="badge confirmed">on</span> A code from your authenticator app is needed when you sign in.</p>
        <form id="f2off"><div class="fields"><div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div>
        <div class="field"><label>Current code (or recovery code)</label><input name="code" required autocomplete="one-time-code"></div></div>
        <div class="err"></div><button type="submit">Turn off two-factor</button></form>`
        : html`<p class="mute">Adds a second step at sign-in using an authenticator app (Google Authenticator, Authy, 1Password…). Recommended for landlord accounts.</p>
        <button class="primary" id="twofa-on">Set up two-factor</button>`}</div>`;
  };
  F.bindSecurity = root => {
    root.querySelector('#twofa-on')?.addEventListener('click', async () => {
      let setup;
      try { setup = await api('/2fa/setup', 'POST'); } catch (e) { return toast(e.message); }
      modal(html`<h2>Set up two-factor</h2>
        <p>1. Scan this with your authenticator app:</p><div style="text-align:center;background:#fff;padding:8px;border-radius:8px;width:max-content;margin:0 auto">${raw(setup.qr)}</div>
        <p class="mute small">Can't scan? Enter this key manually: <code>${setup.secret}</code></p>
        <p>2. Enter the 6-digit code it shows:</p>
        <form id="f"><div class="field"><input name="code" inputmode="numeric" autocomplete="one-time-code" required></div><div class="err"></div>
        <div class="row"><button class="primary" type="submit">Turn on</button><button type="button" data-close>Cancel</button></div></form>`,
      (m, close) => submitter(m, '#f', async d => {
        const r = await api('/2fa/enable', 'POST', d);
        close();
        modal(html`<h2>Save your recovery codes</h2><p>Each code works once if you lose your phone. They won't be shown again.</p>
          <div class="box" style="font-family:monospace">${r.recovery_codes.join('\n')}</div><button class="primary" data-close>I saved them</button>`,
        () => {});
        ctx.reloadSession();
      }));
    });
    const off = root.querySelector('#f2off');
    if (off) submitter(root, '#f2off', async d => { await api('/2fa/disable', 'POST', d); toast('Two-factor turned off'); ctx.reloadSession(); });
  };

  // ---------- tenant detail extras (landlord) ----------
  F.householdCard = (t, members) => html`<div class="card"><div class="row sp"><h2 style="margin:0">People on this lease</h2><button class="sm" id="addperson">Add person</button></div>
    <p class="mute small">Everyone listed shares one balance and one set of charges, but each person has their own login.</p>
    <table><tbody><tr><td><b>${t.name}</b> <span class="mute small">(lease holder)</span><div class="mute small">${t.email}</div></td><td>${t.pending_invite ? badge('pending') : badge('active')}</td><td></td></tr>
    ${members.filter(m => m.active).map(m => html`<tr><td><b>${m.name}</b><div class="mute small">${m.email}</div></td><td>${m.pending_invite ? badge('pending') : badge('active')}</td>
      <td class="right"><button class="sm" data-resetperson="${m.id}">Reset sign-in</button> <button class="sm danger" data-rmperson="${m.id}">Remove</button></td></tr>`)}</tbody></table></div>`;

  F.depositCard = dep => html`<div class="card"><div class="row sp"><h2 style="margin:0">Security deposit</h2><button class="sm" id="adddep">Add entry</button></div>
    <p><b style="font-size:20px">${money(dep.held_cents)}</b> <span class="mute">currently held</span>${dep.return_due_by ? html`<br><span class="mute small">Return deadline after lease end: ${fmtDate(dep.return_due_by)} (based on your ${'"days to return deposit"'} setting; check your state's rules)</span>` : ''}</p>
    ${dep.entries.length ? html`<table><thead><tr><th>Date</th><th>Type</th><th>Note</th><th class="right">Amount</th><th></th></tr></thead><tbody>${dep.entries.map(e => html`<tr><td>${fmtDate(e.entry_date)}</td><td>${badge(e.kind === 'received' ? 'confirmed' : e.kind === 'deduction' ? 'overdue' : 'due')} ${e.kind}</td><td>${e.note}</td>
      <td class="right">${e.kind === 'received' || e.kind === 'interest' ? '+' : '−'}${money(e.amount_cents)}</td><td class="right"><button class="sm danger" data-deldep="${e.id}">Delete</button></td></tr>`)}</tbody></table>` : html`<div class="empty">No deposit recorded.</div>`}</div>`;

  F.inspectionsCard = list => html`<div class="card"><div class="row sp"><h2 style="margin:0">Move-in / move-out inspections</h2>
    <span><button class="sm" data-newinsp="move_in">Start move-in</button> <button class="sm" data-newinsp="move_out">Start move-out</button></span></div>
    ${list.length ? html`<table><tbody>${list.map(i => html`<tr class="click" data-go="/inspections/${i.id}"><td><b>${i.kind === 'move_in' ? 'Move-in' : 'Move-out'}</b> · ${fmtDate(i.inspect_date)}</td>
      <td>${i.status === 'shared' ? (i.acknowledged_at ? badge('confirmed') : badge('pending')) : badge('draft')} ${i.status === 'shared' ? (i.acknowledged_at ? 'tenant agreed' : 'awaiting tenant') : 'not shared'}</td></tr>`)}</tbody></table>` : html`<div class="empty">None yet. A dated, photo-backed checklist protects both of you if a deposit is ever disputed.</div>`}</div>`;

  F.bindTenantExtras = (root, id, refresh, tenant) => {
    const inviteBox = (title, token) => modal(html`<h2>${title}</h2><p>Send this link to them so they can set a password (we also emailed it if email is set up):</p>
      <div class="box">${location.origin}/#/invite/${token}</div><button class="primary" data-close>Done</button>`, () => {});
    root.querySelector('#addperson')?.addEventListener('click', () => modal(html`<h2>Add a person to this lease</h2><form id="f">
      <div class="field"><label>Full name</label><input name="name" required></div><div class="field"><label>Email (their login)</label><input name="email" type="email" required></div>
      <div class="field"><label>Phone</label><input name="phone"></div><div class="err"></div>
      <div class="row"><button class="primary" type="submit">Add & create invite</button><button type="button" data-close>Cancel</button></div></form>`,
    (m, close) => submitter(m, '#f', async d => { const r = await api(`/tenants/${id}/members`, 'POST', d); close(); inviteBox('Invite link', r.invite_token); refresh(); })));
    root.querySelector('#adddep')?.addEventListener('click', () => modal(html`<h2>Deposit entry</h2><form id="f"><div class="fields">
      <div class="field"><label>Type</label><select name="kind"><option value="received">Deposit received</option><option value="deduction">Deduction (damage, unpaid rent…)</option><option value="refund">Refund to tenant</option><option value="interest">Interest credited</option></select></div>
      <div class="field"><label>Amount ($)</label><input name="amount" type="number" step="0.01" min="0.01" required></div>
      <div class="field"><label>Date</label><input name="date" type="date" value="${ctx.localToday()}"></div></div>
      <div class="field"><label>Note (the tenant can see this)</label><input name="note" maxlength="300"></div><div class="err"></div>
      <div class="row"><button class="primary" type="submit">Save</button><button type="button" data-close>Cancel</button></div></form>`,
    (m, close) => submitter(m, '#f', async d => { await api(`/tenants/${id}/deposit`, 'POST', d); close(); refresh(); })));
    root.addEventListener('click', async e => {
      const rm = e.target.closest('[data-rmperson]'), rs = e.target.closest('[data-resetperson]'), dd = e.target.closest('[data-deldep]'), ni = e.target.closest('[data-newinsp]');
      try {
        if (rm && confirm('Remove this person from the lease? They will no longer be able to sign in.')) { await api('/members/' + rm.dataset.rmperson, 'DELETE'); refresh(); }
        if (rs && confirm('Clears their password and two-factor, and creates a new invite link. Continue?')) { const r = await api(`/tenants/${rs.dataset.resetperson}/invite`, 'POST'); inviteBox('New invite link', r.invite_token); }
        if (dd && confirm('Delete this deposit entry?')) { await api('/deposit/' + dd.dataset.deldep, 'DELETE'); refresh(); }
        if (ni) { const r = await api('/inspections', 'POST', { tenant_id: id, kind: ni.dataset.newinsp }); go('/inspections/' + r.id); }
      } catch (err) { toast(err.message); }
    });
  };

  // ---------- inspections ----------
  const CONDITIONS = ['good', 'fair', 'poor', 'damaged', 'n/a'];
  route(/^\/inspections\/(\d+)$/, async id => {
    const { inspection: n, items } = await api('/inspections/' + id);
    const L = isLandlord();
    const title = `${n.kind === 'move_in' ? 'Move-in' : 'Move-out'} inspection`;
    return view(html`<p><a href="#${L ? '/tenants/' + n.tenant_id : '/'}">← Back</a></p>
      <div class="card"><div class="row sp"><div><h1 style="margin:0">${title}</h1><span class="mute">${n.tenant_name}${n.unit ? ' · ' + n.unit : ''} · ${fmtDate(n.inspect_date)}</span></div>
        <div class="row"><a class="btn" href="/api/inspections/${id}/report" target="_blank">Printable report</a>
        ${L ? html`${n.status === 'draft' ? html`<button class="primary" id="share">Share with tenant</button>` : html`<span>${badge('confirmed')} shared</span>`}<button class="danger" id="delinsp">Delete</button>` : ''}</div></div>
        ${n.acknowledged_at ? html`<p>${badge('confirmed')} Acknowledged by <b>${n.ack_name}</b> on ${fmtTs(n.acknowledged_at)}.</p>` : n.status === 'shared' ? html`<p>${badge('pending')} Waiting for the tenant to review.</p>` : ''}
        ${n.tenant_comment ? html`<div class="box"><b>Tenant comment:</b>\n${n.tenant_comment}</div>` : ''}
        ${L ? html`<form id="meta" class="fields"><div class="field"><label>Date</label><input type="date" name="date" value="${n.inspect_date}"></div>
          <div class="field" style="grid-column:1/-1"><label>General notes</label><textarea name="notes">${n.notes}</textarea></div><div><button type="submit" class="sm">Save notes</button></div></form>`
          : n.notes ? html`<p style="white-space:pre-wrap">${n.notes}</p>` : ''}</div>
      ${items.map(i => html`<div class="card" data-item="${i.id}"><div class="row sp"><h3 style="margin:0">${i.area}</h3>
        ${L ? html`<span><select data-cond>${CONDITIONS.map(c => html`<option ${c === i.condition ? 'selected' : ''}>${c}</option>`)}</select> <button class="sm danger" data-delitem="${i.id}">✕</button></span>` : badge(i.condition === 'good' ? 'paid' : i.condition === 'fair' ? 'due' : i.condition === 'n/a' ? 'draft' : 'overdue')}</div>
        ${L ? html`<input data-notes placeholder="Notes (scratches, stains, working order…)" value="${i.notes}" style="margin-top:8px">` : i.notes ? html`<p>${i.notes}</p>` : ''}
        ${photoBlock(i.photos, { deletable: () => L })}${L ? photoUpload('item_id=' + i.id, 'Add photos') : ''}</div>`)}
      ${L ? html`<form id="additem" class="card row"><input name="area" placeholder="Add another area (e.g. Garage storage)" style="flex:1" required><button type="submit">Add area</button></form>` : ''}
      ${!L && n.status === 'shared' ? html`<form id="ack" class="card"><h2>Your review</h2><p class="mute small">If everything looks right, confirm below. If something is missing or wrong, say so in the comment before confirming.</p>
        <div class="field"><textarea name="comment" placeholder="Optional comment">${n.tenant_comment}</textarea></div><div class="err"></div>
        <button class="primary" type="submit">${n.acknowledged_at ? 'Update my acknowledgement' : 'I have reviewed this and agree'}</button></form>` : ''}`,
    root => {
      bindPhotos(root, render);
      if (!L) return submitter(root, '#ack', async d => { await api(`/inspections/${id}/ack`, 'POST', d); toast('Thanks, recorded'); render(); });
      submitter(root, '#meta', async d => { await api('/inspections/' + id, 'PUT', d); toast('Saved'); render(); });
      submitter(root, '#additem', async d => { await api(`/inspections/${id}/items`, 'POST', d); render(); });
      root.querySelector('#share')?.addEventListener('click', async () => { await api(`/inspections/${id}/share`, 'POST'); toast('Shared with tenant'); render(); });
      root.querySelector('#delinsp')?.addEventListener('click', async () => { if (confirm('Delete this inspection and its photos?')) { await api('/inspections/' + id, 'DELETE'); go('/tenants/' + n.tenant_id); } });
      root.querySelectorAll('[data-item]').forEach(card => {
        const save = async () => { try { await api(`/inspections/${id}/items/${card.dataset.item}`, 'PUT', { condition: card.querySelector('[data-cond]').value, notes: card.querySelector('[data-notes]').value }); toast('Saved'); } catch (e) { toast(e.message); } };
        card.querySelector('[data-cond]').onchange = save; card.querySelector('[data-notes]').onchange = save;
      });
      root.addEventListener('click', async e => {
        const d = e.target.closest('[data-delitem]'); if (!d || !confirm('Remove this area and its photos?')) return;
        await api(`/inspections/${id}/items/${d.dataset.delitem}`, 'DELETE'); render();
      });
    });
  });

  // ---------- finances (landlord) ----------
  route(/^\/finances$/, async () => {
    const year = new URLSearchParams(location.hash.split('?')[1] || '').get('year') || String(new Date().getFullYear());
    const [sum, ex] = await Promise.all([api('/finance/summary?year=' + year), api('/expenses?year=' + year)]);
    const years = Array.from({ length: 6 }, (_, i) => String(new Date().getFullYear() - i));
    return view(html`<div class="row sp"><h1>Finances</h1><select id="year" style="width:auto">${years.map(y => html`<option ${y === year ? 'selected' : ''}>${y}</option>`)}</select></div>
      <div class="grid"><div class="card stat"><div class="l">Rent received</div><div class="n">${money(sum.income_cents)}</div></div>
        <div class="card stat"><div class="l">Expenses</div><div class="n">${money(sum.expenses_cents)}</div></div>
        <div class="card stat"><div class="l">Net</div><div class="n" style="color:${sum.net_cents < 0 ? 'var(--bad)' : 'var(--ok)'}">${money(sum.net_cents)}</div></div></div>
      <div class="card"><div class="row sp"><h2 style="margin:0">Expenses</h2><span><button class="primary sm" id="addexp">Add expense</button>
        <a class="btn sm" href="/api/finance/expenses.csv?year=${year}">Expenses CSV</a> <a class="btn sm" href="/api/finance/income.csv?year=${year}">Income CSV</a></span></div>
        <p class="mute small">Track mortgage interest, HOA dues, repairs, insurance and more. The CSVs open in Excel/Sheets for your tax preparer. Receipts can be photographed and attached.</p>
        ${sum.expenses_by_category.length ? html`<div class="table-wrap"><table><tbody>${sum.expenses_by_category.map(c => html`<tr><td>${c.category}</td><td class="right">${money(c.c)}</td></tr>`)}</tbody></table></div><hr style="border:0;border-top:1px solid var(--line)">` : ''}
        ${ex.expenses.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Category</th><th>Vendor / note</th><th class="right">Amount</th><th></th></tr></thead><tbody>${ex.expenses.map(e => html`<tr>
          <td>${fmtDate(e.expense_date)}</td><td>${e.category}</td><td>${e.vendor}<div class="mute small">${e.description}</div></td><td class="right">${money(e.amount_cents)}</td>
          <td class="right"><button class="sm" data-receipts="${e.id}">Receipts (${e.receipts})</button> <button class="sm danger" data-delexp="${e.id}">Delete</button></td></tr>`)}</tbody></table></div>` : html`<div class="empty">No expenses recorded for ${year}.</div>`}</div>
      <div class="card"><h2>Rent received by month</h2>${sum.income_by_month.length ? html`<table><tbody>${sum.income_by_month.map(m => html`<tr><td>${new Date(2000, +m.m - 1, 1).toLocaleString('en-US', { month: 'long' })}</td><td class="right">${money(m.c)}</td></tr>`)}</tbody></table>` : html`<div class="empty">No confirmed payments in ${year}.</div>`}</div>`,
    root => {
      root.querySelector('#year').onchange = e => { location.hash = '/finances?year=' + e.target.value; };
      root.querySelector('#addexp').onclick = () => modal(html`<h2>Add expense</h2><form id="f"><div class="fields">
        <div class="field"><label>Date</label><input type="date" name="date" value="${ctx.localToday()}"></div>
        <div class="field"><label>Amount ($)</label><input type="number" step="0.01" min="0.01" name="amount" required></div>
        <div class="field"><label>Category</label><select name="category">${ex.categories.map(c => html`<option>${c}</option>`)}</select></div>
        <div class="field"><label>Vendor</label><input name="vendor"></div></div>
        <div class="field"><label>Description</label><input name="description"></div>
        <div class="field"><label>Receipt (optional photo or PDF)</label><input type="file" name="receipt" accept="image/jpeg,image/png,image/webp,application/pdf"></div><div class="err"></div>
        <div class="row"><button class="primary" type="submit">Save</button><button type="button" data-close>Cancel</button></div></form>`,
      (m, close) => submitter(m, '#f', async d => {
        const r = await api('/expenses', 'POST', d);
        const f = m.querySelector('[name=receipt]').files[0];
        if (f) await uploadAttachment(f, { expense_id: r.id });
        close(); toast('Expense added'); render();
      }));
      root.addEventListener('click', async e => {
        const del = e.target.closest('[data-delexp]'), rc = e.target.closest('[data-receipts]');
        if (del && confirm('Delete this expense and its receipts?')) { await api('/expenses/' + del.dataset.delexp, 'DELETE'); render(); }
        if (rc) {
          const eid = rc.dataset.receipts;
          const list = await api('/attachments?expense_id=' + eid);
          modal(html`<h2>Receipts</h2>${list.length ? photoBlock(list, { deletable: () => true }) : html`<p class="mute">No receipts attached.</p>`}${photoUpload('expense_id=' + eid, 'Add receipt', 'image/jpeg,image/png,image/webp,application/pdf')}<button data-close>Close</button>`,
            m => { bindPhotos(m, () => { m.closest('.modal-bg').remove(); render(); }); });
        }
      });
    });
  });

  // ---------- property listing (landlord) ----------
  const LISTING = [['title', 'Listing title', 'e.g. Bright 2BR condo near downtown'], ['headline', 'One-line hook', ''], ['address', 'Address', ''], ['neighborhood', 'Neighborhood', ''],
    ['asking_rent', 'Asking rent', '$2,100'], ['deposit', 'Security deposit', ''], ['bedrooms', 'Bedrooms', ''], ['bathrooms', 'Bathrooms', ''], ['sqft', 'Square feet', ''], ['floor', 'Floor / unit', ''],
    ['available_date', 'Available date', ''], ['lease_term', 'Lease term', '12 months'], ['pets', 'Pet policy', ''], ['parking', 'Parking', ''], ['laundry', 'Laundry', ''], ['utilities', 'Utilities included', ''], ['hoa_notes', 'HOA / building notes', '']];
  const listingText = l => [l.title, [l.address, l.neighborhood].filter(Boolean).join(' · '),
    [l.asking_rent && `${l.asking_rent}/month`, l.bedrooms && `${l.bedrooms} bed`, l.bathrooms && `${l.bathrooms} bath`, l.sqft && `${l.sqft} sq ft`].filter(Boolean).join(' · '),
    l.available_date && `Available: ${l.available_date}`, '', l.headline, '', l.description,
    l.amenities && '\nAmenities:\n' + l.amenities.split('\n').filter(x => x.trim()).map(x => '• ' + x.trim()).join('\n'),
    '', ...[['Lease', l.lease_term], ['Deposit', l.deposit], ['Pets', l.pets], ['Parking', l.parking], ['Laundry', l.laundry], ['Utilities', l.utilities], ['HOA/Building', l.hoa_notes]].filter(x => x[1]).map(x => `${x[0]}: ${x[1]}`),
    l.contact && '\nContact:\n' + l.contact].filter(x => x !== undefined && x !== null && x !== false).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  route(/^\/property$/, async () => {
    const { listing: l, photos } = await api('/listing');
    return view(html`<div class="row sp"><h1>Property &amp; listing</h1><span><button class="sm" id="copy">Copy listing text</button> <a class="btn sm" href="/api/listing/sheet" target="_blank">Printable sheet</a>
        ${photos.length ? html`<a class="btn sm" href="/api/listing/photos.tar">Download all photos</a>` : ''}</span></div>
      <p class="mute">Keep your listing description and photos here so you can post the unit quickly when it's time to find a tenant. Tenants never see this page.</p>
      <div class="card"><h2>Photos</h2><p class="mute small">The first photo is the cover. Use the arrows to reorder, and add captions (room names help on listing sites).</p>
        ${photos.length ? html`<div class="photos big">${photos.map((p, i) => html`<figure data-photo="${p.id}"><a href="/api/attachments/${p.id}/file" target="_blank"><img loading="lazy" src="/api/attachments/${p.id}/file" alt="${p.caption || p.name}"></a>
          <figcaption>${i === 0 ? html`<b>Cover</b> · ` : ''}${p.caption || html`<span class="mute">No caption</span>`}</figcaption>
          <div class="row" style="gap:4px"><button class="sm" data-move="-1" ${i === 0 ? 'disabled' : ''}>←</button><button class="sm" data-move="1" ${i === photos.length - 1 ? 'disabled' : ''}>→</button>
          <button class="sm" data-caption="${p.id}">Caption</button><button class="sm danger" data-delphoto="${p.id}">Remove</button></div></figure>`)}</div>` : html`<div class="empty">No photos yet.</div>`}
        ${photoUpload('listing=1', 'Add photos (you can pick many at once)')}</div>
      <form id="f"><div class="card"><h2>Details</h2><div class="fields">${LISTING.map(([k, label, ph]) => html`<div class="field"><label>${label}</label><input name="${k}" value="${l[k]}" placeholder="${ph}"></div>`)}</div>
        <div class="field"><label>Description</label><textarea name="description" style="min-height:160px">${l.description}</textarea></div>
        <div class="field"><label>Amenities (one per line)</label><textarea name="amenities">${l.amenities}</textarea></div>
        <div class="field"><label>Contact info for the listing</label><textarea name="contact">${l.contact}</textarea></div>
        <div class="err"></div><button class="primary" type="submit">Save details</button></div></form>`,
    root => {
      bindPhotos(root, render);
      submitter(root, '#f', async d => { await api('/listing', 'PUT', d); toast('Listing saved'); render(); });
      root.querySelector('#copy').onclick = async () => {
        const cur = Object.fromEntries(new FormData(root.querySelector('#f')));
        try { await navigator.clipboard.writeText(listingText(cur)); toast('Listing text copied'); }
        catch { modal(html`<h2>Listing text</h2><textarea style="min-height:300px" readonly>${listingText(cur)}</textarea><button data-close>Close</button>`, () => {}); }
      };
      const order = () => [...root.querySelectorAll('[data-photo]')].map(f => Number(f.dataset.photo));
      root.addEventListener('click', async e => {
        const mv = e.target.closest('[data-move]'), cap = e.target.closest('[data-caption]');
        try {
          if (mv) {
            const ids = order(), id = Number(mv.closest('[data-photo]').dataset.photo), i = ids.indexOf(id), j = i + Number(mv.dataset.move);
            [ids[i], ids[j]] = [ids[j], ids[i]];
            await api('/attachments/reorder', 'POST', { ids }); render();
          }
          if (cap) { const c = prompt('Caption (e.g. "Living room")'); if (c !== null) { await api('/attachments/' + cap.dataset.caption, 'PUT', { caption: c }); render(); } }
        } catch (err) { toast(err.message); }
      });
    });
  });

  // ---------- settings (landlord) ----------
  route(/^\/settings$/, async () => {
    const s = getSession().settings;
    const [landlords, email, backup, activity] = await Promise.all([api('/landlords'), api('/email/status'), api('/backup/status'), api('/activity')]);
    const me = getSession().user;
    return view(html`<h1>Settings</h1>
      <form id="f">
        <div class="card"><h2>Property</h2><div class="fields"><div class="field"><label>Property name</label><input name="property_name" value="${s.property_name}"></div>
        <div class="field"><label>Address</label><input name="property_address" value="${s.property_address}"></div></div>
        <div class="field"><label>Contact info shown to tenants</label><textarea name="contact_info">${s.contact_info}</textarea></div></div>
        <div class="card"><h2>How tenants can pay you</h2><p class="mute small">Only methods you fill in are shown to tenants. Cash App and Venmo get a one-tap link with the amount pre-filled.</p>
        <div class="fields"><div class="field"><label>Cash App $cashtag</label><input name="cashapp_tag" value="${s.cashapp_tag}" placeholder="$yourtag"></div>
        <div class="field"><label>Venmo username</label><input name="venmo_handle" value="${s.venmo_handle}" placeholder="@yourname"></div>
        <div class="field"><label>Zelle email / phone</label><input name="zelle_contact" value="${s.zelle_contact}"></div></div>
        <div class="field"><label>Wire instructions (bank, routing, account, reference)</label><textarea name="wire_instructions">${s.wire_instructions}</textarea></div>
        <div class="field"><label>Extra note shown on every payment screen</label><textarea name="payment_notes">${s.payment_notes}</textarea></div></div>
        <div class="card"><h2>Reminders &amp; links</h2><div class="fields">
        <div class="field"><label>Remind tenants this many days before rent is due</label><input name="reminder_days" type="number" min="0" max="30" value="${s.reminder_days ?? 3}"></div>
        <div class="field"><label>Days to return a deposit after lease end</label><input name="deposit_return_days" type="number" min="0" max="120" value="${s.deposit_return_days ?? 30}"></div>
        <div class="field"><label>Public web address (used in emails)</label><input name="app_url" value="${s.app_url}" placeholder="https://rent.example.com"></div></div>
        <p class="mute small">Deposit return deadlines and late-fee limits are set by your state or local law. Check them before relying on these defaults.</p></div>
        <div class="err"></div><button class="primary" type="submit">Save settings</button></form>
      <div class="card" style="margin-top:16px"><div class="row sp"><h2 style="margin:0">Landlords</h2><button class="sm" id="addll">Invite landlord</button></div>
        <table><tbody>${landlords.map(l => html`<tr><td><b>${l.name}</b>${l.id === me.id ? ' (you)' : ''}<div class="mute small">${l.email}</div></td>
          <td>${!l.active ? badge('inactive') : l.pending_invite ? badge('pending') : badge('active')} ${l.totp_enabled ? html`<span class="mute small">2FA on</span>` : ''}</td>
          <td class="right">${l.id !== me.id && l.active ? html`<button class="sm" data-resetll="${l.id}">Reset sign-in</button> <button class="sm danger" data-rmll="${l.id}">Deactivate</button>` : ''}</td></tr>`)}</tbody></table></div>
      ${F.securityCard()}
      <div class="card"><div class="row sp"><h2 style="margin:0">Email</h2><button class="sm" id="testmail">Send me a test email</button></div>
        ${email.configured ? html`<p>${badge('confirmed')} Email is set up.</p>` : html`<p>${badge('overdue')} Email isn't set up yet, so reminders and notifications are only logged below. Set the <code>SMTP_URL</code> environment variable (see the README).</p>`}
        ${email.recent.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>${email.recent.map(m => html`<tr><td>${fmtTs(m.created_at)}</td><td>${m.to_addr}</td><td>${m.subject}</td><td>${badge(m.status === 'sent' ? 'confirmed' : m.status === 'failed' ? 'rejected' : 'pending')} ${m.status}${m.error ? html`<div class="mute small">${m.error}</div>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="mute">No emails yet.</p>`}</div>
      <div class="card"><div class="row sp"><h2 style="margin:0">Backups</h2><button class="sm primary" id="backup">Download full backup</button></div>
        <p class="mute small">A daily database snapshot is kept on the server (${backup.snapshots.length} so far). A downloaded backup includes the database <b>and</b> all uploaded files — save one somewhere safe off the server (your computer or cloud drive) regularly.</p>
        <p>Last download: ${backup.last_download ? fmtTs(backup.last_download) : html`<b style="color:var(--bad)">never</b>`} · ${backup.files} stored files</p></div>
      <div class="card"><h2>Activity log</h2>${activity.length ? html`<div class="table-wrap"><table><tbody>${activity.map(a => html`<tr><td class="mute small" style="white-space:nowrap">${fmtTs(a.created_at)}</td><td><b>${a.user_name || 'System'}</b> · ${a.text}</td></tr>`)}</tbody></table></div>` : html`<p class="mute">Nothing yet.</p>`}</div>`,
    root => {
      submitter(root, '#f', async d => { const r = await api('/settings', 'PUT', d); ctx.setSettings(r); toast('Settings saved'); });
      F.bindSecurity(root);
      root.querySelector('#testmail').onclick = async () => { await api('/email/test', 'POST'); toast('Queued. Refreshing…'); setTimeout(render, 1500); };
      root.querySelector('#addll').onclick = () => modal(html`<h2>Invite another landlord</h2><p class="mute small">Gets full access: tenants, payments, documents, settings.</p><form id="f">
        <div class="field"><label>Name</label><input name="name" required></div><div class="field"><label>Email</label><input name="email" type="email" required></div><div class="err"></div>
        <div class="row"><button class="primary" type="submit">Send invite</button><button type="button" data-close>Cancel</button></div></form>`,
      (m, close) => submitter(m, '#f', async d => {
        const r = await api('/landlords', 'POST', d); close();
        modal(html`<h2>Invite created</h2><p>Send this link so they can set a password:</p><div class="box">${location.origin}/#/invite/${r.invite_token}</div><button class="primary" data-close>Done</button>`, () => {});
        render();
      }));
      root.querySelector('#backup').onclick = () => modal(html`<h2>Download backup</h2><p class="mute small">Confirm your password. The file contains all tenant data and documents, so store it securely.</p><form id="f">
        <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password"></div><div class="err"></div>
        <div class="row"><button class="primary" type="submit">Download</button><button type="button" data-close>Cancel</button></div></form>`,
      (m, close) => submitter(m, '#f', async d => { const r = await api('/backup/prepare', 'POST', d); close(); location.href = r.url; setTimeout(render, 2500); }));
      root.addEventListener('click', async e => {
        const rs = e.target.closest('[data-resetll]'), rm = e.target.closest('[data-rmll]');
        try {
          if (rs && confirm('Clears their password and two-factor and creates a new invite link. Continue?')) {
            const r = await api(`/landlords/${rs.dataset.resetll}/reset`, 'POST');
            modal(html`<h2>New invite link</h2><div class="box">${location.origin}/#/invite/${r.invite_token}</div><button class="primary" data-close>Done</button>`, () => {});
          }
          if (rm && confirm('Deactivate this landlord account?')) { await api('/landlords/' + rm.dataset.rmll, 'DELETE'); render(); }
        } catch (err) { toast(err.message); }
      });
    });
  });
}
