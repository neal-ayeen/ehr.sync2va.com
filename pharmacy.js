/* ==========================================================================
   Sync2EHR · Pharmacy directory + admin-managed pharmacy messages
   --------------------------------------------------------------------------
   Load AFTER app.js: in index.html, add a script tag with src="pharmacy.js"
   on the line right after the app.js script tag. Roll back by deleting that
   line. app.js itself is not modified.

   Administrators: add pharmacies; add and edit pharmacy messages.
   Everyone else:  browse the pharmacy directory (phone / fax / address) and
                   open pharmacy messages read-only.

   Note: the admin check below runs in the browser. The shared data row in
   Supabase is only protected if its row-level security rules say so.
   ========================================================================== */
(function(){
  const TYPES = ['Retail','Mail order','Specialty','Hospital outpatient'];
  const STATUSES = ['Open','Needs review','Urgent','Closed'];
  const MESSAGE_TYPES = ['Clarify dosage','Prior authorization required','Medication out of stock','Drug interaction warning','Refill too soon','Therapeutic substitution request','Insurance rejected claim','Prescription received'];

  /* The four pharmacies that were hardcoded in the "Change Pharmacy" list, now
     stored as data with fictional contact details (555-01xx numbers). */
  let pharmacies = [
    {id:'PHM-001', name:'Allied Pharmacy',      type:'Retail',     phone:'(415) 555-0144', fax:'(415) 555-0145', address:'88 Mission St, San Francisco, CA 94103'},
    {id:'PHM-002', name:'CarePlus Pharmacy',    type:'Retail',     phone:'(415) 555-0131', fax:'(415) 555-0132', address:'210 Market St, San Francisco, CA 94105'},
    {id:'PHM-003', name:'Northside Pharmacy',   type:'Retail',     phone:'(415) 555-0172', fax:'(415) 555-0173', address:'1450 Polk St, San Francisco, CA 94109'},
    {id:'PHM-004', name:'SynClinic Mail Order', type:'Mail order', phone:'(800) 555-0190', fax:'(800) 555-0191', address:'PO Box 4400, Oakland, CA 94604'}
  ];

  /* Escapes text for HTML content AND attribute values (app.js's adminText does not escape quotes). */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  /* Newer app.js versions have currentUserIsAdmin(); the live version has no admin role,
     so there the admins are the permanent-access accounts listed in PERMANENT_ACCESS_USER_IDS. */
  const isAdmin = () => typeof currentUserIsAdmin === 'function'
    ? currentUserIsAdmin()
    : Boolean(typeof cloudUser !== 'undefined' && cloudUser && typeof PERMANENT_ACCESS_USER_IDS !== 'undefined' && PERMANENT_ACCESS_USER_IDS.has(cloudUser.id));
  const today = () => new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
  const newId = prefix => `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2,5).toUpperCase()}`;
  const byName = name => { const key = String(name || '').trim().toLowerCase(); return pharmacies.find(p => p.name.toLowerCase() === key); };

  /* Give every message a stable id so edits never depend on list position.
     Ids for older messages come from their position, so every browser assigns the same ones. */
  function giveMessageIds(list){
    (list || []).forEach((m, i) => { if (m && !m.id) m.id = `PM-L${String(i + 1).padStart(3, '0')}`; });
  }
  function cleanPharmacies(list){
    return (list || []).filter(p => p && String(p.name || '').trim()).map((p, i) => ({
      id: p.id || `PHM-L${String(i + 1).padStart(3, '0')}`, name: String(p.name).trim(), type: p.type || 'Retail',
      phone: p.phone || '', fax: p.fax || '', address: p.address || ''
    }));
  }
  function options(values, selected){
    const list = [...values];
    if (selected && !list.some(v => v.toLowerCase() === String(selected).toLowerCase())) list.push(selected); // keep a value that is no longer listed
    return list.map(v => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
  }
  const pharmacyOptions = selected => options(pharmacies.map(p => p.name), selected);
  const openModalOf = type => { $('#modal').dataset.type = type; $('#modal').classList.remove('hidden'); };

  /* ---------- saved with the rest of the shared data ---------- */
  const baseCloudState = currentCloudState;
  currentCloudState = function(){ return {...baseCloudState(), pharmacies: cloneCloud(pharmacies)}; };

  const baseApplyCloudState = applyCloudState;
  applyCloudState = function(data = {}){
    // If the saved data has no pharmacy list (first run, or an older copy of the app saved it),
    // this browser keeps its current list; it is written back with the next normal save.
    if (data && Array.isArray(data.pharmacies)) pharmacies = cleanPharmacies(repairSharedText(data.pharmacies));
    if (data && Array.isArray(data.pharmacyMessages)) giveMessageIds(data.pharmacyMessages);
    baseApplyCloudState(data);
  };

  // Include the pharmacy list in the change check that triggers a save.
  const baseSnapshot = prescriptionStateSnapshot;
  prescriptionStateSnapshot = function(){ return baseSnapshot() + '|' + JSON.stringify(pharmacies); };

  /* ---------- eRx tables ---------- */
  function tableHead(title, actionHtml){
    return `<div class="erx-table-head"><h3>${title}</h3>${actionHtml || ''}</div>`;
  }
  function directoryTable(){
    const action = isAdmin() ? '<button type="button" class="primary" id="addPharmacy">+ Add pharmacy</button>' : '';
    const rows = pharmacies.map(p => `<div class="erx-row erx-pharmacy-grid erx-static"><b>${esc(p.name)}</b><span>${esc(p.type)}</span><span>${esc(p.phone || '—')}</span><span>${esc(p.fax || '—')}</span><span>${esc(p.address || '—')}</span></div>`).join('');
    return `<section class="erx-table">${tableHead('Pharmacies', action)}<div class="erx-head erx-pharmacy-grid"><span>Pharmacy</span><span>Type</span><span>Phone</span><span>Fax</span><span>Address</span></div>${rows || '<p class="empty-state">No pharmacies yet.</p>'}</section>`;
  }
  function messagesTable(){
    const admin = isAdmin();
    const action = admin ? '<button type="button" class="primary" id="addPharmacyMessage">+ Add message</button>' : '';
    const rows = pharmacyMessages.map(m => `<button type="button" class="erx-row erx-message-grid pharmacy-message-row" data-message-id="${esc(m.id)}"><b>${esc(m.type)}</b><span>${esc(m.patient)}</span><span>${esc(m.medication)}</span><span>${esc(m.pharmacy)}</span><span>${erxPill(esc(m.status))}</span><span>${admin ? 'Edit' : 'Open'} →</span></button>`).join('');
    return `<section class="erx-table">${tableHead('Pharmacy Messages', action)}<div class="erx-head erx-message-grid"><span>Message</span><span>Patient</span><span>Medication</span><span>Pharmacy</span><span>Status</span><span>Actions</span></div>${rows || '<p class="empty-state">No pharmacy messages.</p>'}</section>`;
  }

  const baseErxRows = erxRows;
  erxRows = function(){
    giveMessageIds(pharmacyMessages);
    if (activeErxTab === 'Pharmacies') return directoryTable();
    if (activeErxTab === 'Pharmacy Messages') return messagesTable();
    return baseErxRows();
  };

  const baseRenderPrescriptions = renderPrescriptions;
  renderPrescriptions = function(tab = activeErxTab){
    baseRenderPrescriptions(tab);
    bindPharmacyViews();
  };
  function bindPharmacyViews(){
    const tabs = $('#prescriptions .erx-subtabs');
    if (tabs && !tabs.querySelector('[data-erx-tab="Pharmacies"]')) {
      tabs.insertAdjacentHTML('beforeend', `<button class="${activeErxTab === 'Pharmacies' ? 'active' : ''}" data-erx-tab="Pharmacies">Pharmacies</button>`);
      tabs.lastElementChild.onclick = () => renderPrescriptions('Pharmacies');
    }
    const change = $('#changePharmacy'); if (change) change.onclick = openChangePharmacy;
    const addPharmacy = $('#addPharmacy'); if (addPharmacy) addPharmacy.onclick = openAddPharmacy;
    const addMessage = $('#addPharmacyMessage'); if (addMessage) addMessage.onclick = () => openMessageEditor();
    $$('.pharmacy-message-row').forEach(row => row.onclick = () => {
      if (!pharmacyMessages.some(m => m.id === row.dataset.messageId)) { toast('This message is no longer available. The list has been refreshed.'); renderPrescriptions(activeErxTab); return; }
      isAdmin() ? openMessageEditor(row.dataset.messageId) : openMessageDetail(row.dataset.messageId);
    });
  }

  /* "Change Pharmacy" lists the directory instead of four fixed names, and can also move the
     patient's active prescriptions. Each prescription keeps its own pharmacy; completed ones
     keep the pharmacy they were filled at. */
  const activeRxFor = name => prescriptions.filter(rx => rx && rx.patient === name && rx.status !== 'Completed');
  const baseChangePharmacy = openChangePharmacy;
  openChangePharmacy = function(){
    baseChangePharmacy();
    const p = selectedErxPatient(), select = $('#modalFields select[name="pharmacy"]');
    if (!select) return;
    select.innerHTML = pharmacyOptions(p.preferredPharmacy || 'CarePlus Pharmacy');
    const n = activeRxFor(p.n).length;
    if (n) (select.closest('label') || select).insertAdjacentHTML('afterend',
      `<label class="rx-move-active" style="display:flex;align-items:flex-start;gap:9px;font-weight:600;margin:4px 0 6px"><input type="checkbox" name="moveActiveRx" value="yes" checked style="width:16px;height:16px;margin:2px 0 0;flex:0 0 16px">
        <span>Also send ${esc(p.n)}'s ${n} active prescription${n === 1 ? '' : 's'} to this pharmacy</span></label>
       <p class="form-note" style="margin:0 0 14px;font-size:12px">Completed prescriptions keep the pharmacy they were filled at.</p>`);
  };

  /* Prescription form: a Pharmacy field. Editing keeps the prescription's own pharmacy;
     a new prescription starts with its patient's preferred pharmacy. */
  if (typeof rxForm === 'function') {
    const baseRxForm = rxForm;
    rxForm = function(rx = {}){
      const html = baseRxForm(rx);
      const who = rx.patient || activeErxPatient;
      const patient = (typeof patients !== 'undefined' ? patients : []).find(p => p.n === who) || {};
      const current = rx.pharmacy || patient.preferredPharmacy || 'CarePlus Pharmacy';
      const field = `<label style="margin-bottom:14px">Pharmacy<select name="rxPharmacy" data-auto="${rx.pharmacy ? '' : '1'}">${pharmacyOptions(current)}</select></label>`;
      const at = html.lastIndexOf('</div>');
      return at < 0 ? html + field : html.slice(0, at) + field + html.slice(at);
    };
  }
  $('#modalFields').addEventListener('change', e => {
    if (e.target.name === 'rxPharmacy') { e.target.dataset.auto = ''; return; }
    if (e.target.name !== 'patient' || $('#modal').dataset.type !== 'erx-new') return;
    const sel = $('#modalFields select[name="rxPharmacy"]');
    if (!sel || sel.dataset.auto !== '1') return;   // keep a pharmacy the user picked
    const p = patients.find(x => x.n === e.target.value) || {};
    sel.innerHTML = pharmacyOptions(p.preferredPharmacy || 'CarePlus Pharmacy');
  });

  /* Prescription details: flag a prescription that still goes to an old pharmacy. */
  if (typeof openPrescriptionDetails === 'function') {
    const baseRxDetails = openPrescriptionDetails;
    openPrescriptionDetails = function(rx){
      baseRxDetails(rx);
      const p = rx && patients.find(x => x.n === rx.patient), preferred = p && p.preferredPharmacy;
      if (!preferred || !rx.pharmacy || preferred === rx.pharmacy || rx.status === 'Completed') return;
      const grid = $('#modalFields .detail-grid');
      if (grid) grid.insertAdjacentHTML('afterend', `<p class="export-note rx-pharmacy-mismatch" style="margin-top:12px">${esc(rx.patient)}'s preferred pharmacy is now <b>${esc(preferred)}</b>, but this prescription still goes to <b>${esc(rx.pharmacy)}</b>. Click Edit Prescription to change it.</p>`);
    };
  }

  /* app.js handles these forms with a capture listener on the form that stops the event, so this
     listens on the document (capture) to run first. It never stops the event. */
  document.addEventListener('submit', e => {
    if (!e.target || e.target.id !== 'modalForm') return;
    const type = $('#modal').dataset.type;
    if (type === 'erx-pharmacy') {
      const d = new FormData(e.target), chosen = String(d.get('pharmacy') || ''), p = selectedErxPatient();
      if (!chosen || d.get('moveActiveRx') !== 'yes') return;
      const moved = activeRxFor(p.n).filter(rx => rx.pharmacy !== chosen);
      moved.forEach(rx => { rx.pharmacy = chosen; });   // app.js then saves the preferred pharmacy, re-renders and saves
      if (moved.length) setTimeout(() => toast(`Preferred pharmacy updated. ${moved.length} active prescription${moved.length === 1 ? '' : 's'} moved to ${chosen}.`), 0);
      return;
    }
    if (type !== 'erx-new' && type !== 'erx-edit') return;
    const chosen = String(new FormData(e.target).get('rxPharmacy') || '');
    if (!chosen) return;
    const index = Number($('#modal').dataset.rxIndex), first = prescriptions[0];
    // app.js sets the pharmacy from the eRx header patient; put back the one chosen in the form.
    setTimeout(() => {
      const rx = type === 'erx-edit' ? prescriptions[index] : (prescriptions[0] !== first ? prescriptions[0] : null);
      if (!rx || rx.pharmacy === chosen) return;
      rx.pharmacy = chosen;
      renderPrescriptions(activeErxTab);   // re-renders and queues the shared save
    }, 0);
  }, true);

  /* ---------- admin: add a pharmacy ---------- */
  function openAddPharmacy(){
    if (!isAdmin()) { toast('Only administrators can add pharmacies'); return; }
    $('#modalTitle').textContent = 'Add pharmacy';
    $('#modalFields').innerHTML = `<p class="form-note">New pharmacies appear for every user in the Pharmacies list and in Change Pharmacy.</p>
      <div class="rx-modal-grid">
        <label>Pharmacy name<input name="name" required maxlength="80" placeholder="e.g. Bayview Community Pharmacy"></label>
        <label>Type<select name="type">${options(TYPES, 'Retail')}</select></label>
        <label>Phone<input name="phone" type="tel" required maxlength="30" placeholder="(415) 555-0100"></label>
        <label>Fax<input name="fax" type="tel" maxlength="30" placeholder="(415) 555-0101"></label>
      </div>
      <label>Address<input name="address" maxlength="160" placeholder="Street, city, state, ZIP"></label>`;
    openModalOf('pharmacy-add');
  }

  /* ---------- admin: add or edit a pharmacy message ---------- */
  function openMessageEditor(id = ''){
    if (!isAdmin()) { toast('Only administrators can add or edit pharmacy messages'); return; }
    giveMessageIds(pharmacyMessages);
    const existing = pharmacyMessages.find(m => m.id === id);
    const m = existing || {status:'Open', patient: activeErxPatient, pharmacy: selectedErxPatient().preferredPharmacy || 'CarePlus Pharmacy'};
    const meds = [...new Set(prescriptions.map(rx => rx.medication).filter(Boolean))];
    $('#modalTitle').textContent = existing ? 'Edit pharmacy message' : 'Add pharmacy message';
    $('#modalFields').innerHTML = `
      <datalist id="pharmacyMessageTypes">${MESSAGE_TYPES.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      <datalist id="pharmacyMessageMeds">${meds.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="rx-modal-grid">
        <label>Message type<input name="type" list="pharmacyMessageTypes" required maxlength="80" value="${esc(m.type || '')}" placeholder="e.g. Clarify dosage"></label>
        <label>Status<select name="status">${options(STATUSES, m.status || 'Open')}</select></label>
        <label>Patient<select name="patient" required>${options(patients.map(p => p.n), m.patient)}</select></label>
        <label>Medication<input name="medication" list="pharmacyMessageMeds" required maxlength="120" value="${esc(m.medication || '')}" placeholder="e.g. Metformin 500 mg tablet"></label>
        <label>Pharmacy<select name="pharmacy" required>${pharmacyOptions(m.pharmacy)}</select></label>
        <label>Received<input value="${esc(m.received || (existing ? 'Not recorded' : 'Today'))}" readonly></label>
      </div>
      <label>Message from the pharmacy<textarea name="details" maxlength="2000" placeholder="What the pharmacy is asking or reporting, e.g. the dose on the prescription does not match the patient's last fill.">${esc(m.details || '')}</textarea></label>`;
    $('#modal').dataset.messageId = existing ? existing.id : '';
    openModalOf(existing ? 'pharmacy-message-edit' : 'pharmacy-message-new');
  }

  /* ---------- everyone else: read-only message ---------- */
  function openMessageDetail(id){
    const m = pharmacyMessages.find(x => x.id === id); if (!m) return;
    const ph = byName(m.pharmacy) || {};
    $('#modalTitle').textContent = m.type || 'Pharmacy message';
    $('#modalFields').innerHTML = `<div class="detail-banner"><div class="profile-avatar">Rx</div><div><b>${esc(m.pharmacy)}</b><p>${esc(m.status)} · ${esc(m.patient)}</p></div></div>
      <div class="detail-grid">
        <div><small>Patient</small><b>${esc(m.patient)}</b></div>
        <div><small>Medication</small><b>${esc(m.medication)}</b></div>
        <div><small>Pharmacy phone</small><b>${esc(ph.phone || 'Not listed')}</b></div>
        <div><small>Pharmacy fax</small><b>${esc(ph.fax || 'Not listed')}</b></div>
        <div><small>Status</small><b>${esc(m.status)}</b></div>
        <div><small>Received</small><b>${esc(m.received || 'Not recorded')}</b></div>
      </div>
      <div class="export-note pharmacy-message-text"><b>Message from the pharmacy</b>\n${esc(m.details || 'No message text was added.')}</div>`;
    openModalOf('details');
  }

  /* ---------- saving the forms ---------- */
  $('#modalForm').addEventListener('submit', e => {
    const type = $('#modal').dataset.type;
    if (!['pharmacy-add', 'pharmacy-message-new', 'pharmacy-message-edit'].includes(type)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!isAdmin()) { $('#modal').classList.add('hidden'); toast('Administrator access is required'); return; }
    const d = new FormData(e.target), val = k => String(d.get(k) || '').trim();

    if (type === 'pharmacy-add') {
      const name = val('name');
      if (byName(name)) { toast(`${name} is already in the pharmacy list`); return; } // keep the form open
      pharmacies.push({id: newId('PHM'), name, type: val('type') || 'Retail', phone: val('phone'), fax: val('fax'), address: val('address')});
      pharmacies.sort((a, b) => a.name.localeCompare(b.name));
      activeErxTab = 'Pharmacies';
      toast(`${name} added to pharmacies`);
    } else {
      const fields = {type: val('type'), status: val('status'), patient: val('patient'), medication: val('medication'), pharmacy: val('pharmacy'), details: val('details')};
      if (type === 'pharmacy-message-new') {
        pharmacyMessages.unshift({id: newId('PM'), received: today(), ...fields});
        toast('Pharmacy message added');
      } else {
        giveMessageIds(pharmacyMessages);
        const m = pharmacyMessages.find(x => x.id === $('#modal').dataset.messageId);
        if (!m) { toast('This message was changed or removed by someone else. Close this form and open it again.'); return; }
        Object.assign(m, fields);
        toast('Pharmacy message updated');
      }
      activeErxTab = 'Pharmacy Messages';
    }
    renderPrescriptions(activeErxTab); // re-renders and queues the shared save (savePrescriptions)
    $('#modal').classList.add('hidden');
    e.target.reset();
  }, true);

  giveMessageIds(pharmacyMessages);
  prescriptionStateSignature = prescriptionStateSnapshot();
})();
