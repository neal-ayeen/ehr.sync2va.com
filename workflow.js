/* Sync2EHR — connected workflow (November 2026)
   Loaded after app.js, pharmacy.js and referrals.js. It connects the pages to each other so a
   student can follow one patient visit from start to finish:
     register → schedule → check in → visit note → prescription / orders → complete → invoice → payment
   It also replaces the fixed sample numbers (dashboard, billing, reports) with live counts,
   and gives the search, bell and Help center buttons something to do.
   Like the other add-ons it wraps app.js functions instead of editing them. */
(function () {
  'use strict';
  if (typeof page !== 'function' || typeof patients === 'undefined' || typeof appointments === 'undefined') return;

  const q = s => document.querySelector(s);
  const qa = s => [...document.querySelectorAll(s)];
  const esc = typeof escapeHtml === 'function' ? escapeHtml : v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad = n => String(n).padStart(2, '0');
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const localValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || word + 's')}`;
  const OPEN = typeof OPEN_APPOINTMENT_STATUSES !== 'undefined' ? OPEN_APPOINTMENT_STATUSES : ['Scheduled', 'Confirmed', 'Checked In', 'Rescheduled'];
  const isOpenAppt = a => OPEN.includes(a.status || 'Scheduled');
  const apptTime = a => new Date(a.time);
  const validTime = a => a && a.time && !Number.isNaN(apptTime(a).getTime());
  const needsUpdate = a => validTime(a) && isOpenAppt(a) && apptTime(a) < new Date(Date.now() - 60 * 60 * 1000);
  const money = n => `$${Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  const balanceOf = x => Number(x.remainingBalance ?? currencyValue(x.amount));
  const fire = (el, type) => el && el.dispatchEvent(new Event(type, {bubbles: true}));
  const closeModal = () => { const m = q('#modal'); if (m) m.classList.add('hidden'); };
  const visitType = a => a.otherType || a.type || 'Office visit';

  /* ---------- modal helpers ---------- */
  let modalDirty = false;
  document.addEventListener('input', e => { if (e.target.closest && e.target.closest('#modalFields')) modalDirty = true; }, true);
  document.addEventListener('change', e => { if (e.target.closest && e.target.closest('#modalFields') && e.isTrusted) modalDirty = true; }, true);
  function leaveModal(){
    if (modalDirty && !confirm('Leave this form without saving your changes?')) return false;
    modalDirty = false; closeModal(); return true;
  }
  // Read-only detail windows say "Close" instead of "Save details".
  const modalEl = q('#modal');
  function syncModalButton(){
    const btn = q('#modalForm > button[type="submit"]');
    if (!btn || !modalEl) return;
    const type = modalEl.dataset.type;
    if (type === 'details' || type === 'wf-panel') btn.textContent = 'Close';
    else if (btn.textContent === 'Close') btn.textContent = 'Save details';
    if (modalEl.classList.contains('hidden')) modalDirty = false;
  }
  if (modalEl) new MutationObserver(syncModalButton).observe(modalEl, {attributes: true, attributeFilter: ['class', 'data-type']});
  // Panels opened by this file only need closing on submit.
  q('#modalForm')?.addEventListener('submit', e => {
    if (modalEl.dataset.type !== 'wf-panel') return;
    e.preventDefault(); e.stopImmediatePropagation(); closeModal();
  }, true);
  function openPanel(title, html){
    q('#modalTitle').textContent = title;
    q('#modalFields').innerHTML = html;
    modalEl.dataset.type = 'wf-panel';
    modalEl.classList.remove('hidden');
    modalDirty = false; syncModalButton();
  }

  /* ---------- save status next to the search button ---------- */
  const actions = q('.top-actions');
  if (actions && !q('#saveStatus')) actions.insertAdjacentHTML('afterbegin', '<span id="saveStatus" class="save-status" role="status" aria-live="polite" hidden></span>');
  const STATUS_TEXT = {loading: ['Connecting…', 'busy'], pending: ['Saving…', 'busy'], saving: ['Saving…', 'busy'], saved: ['All changes saved', 'ok'], error: ['Not saved yet — retrying', 'warn'], 'signed-out': ['Signed out', 'warn']};
  window.addEventListener('sync2ehr:cloud-status', e => {
    const el = q('#saveStatus'); if (!el) return;
    const [text, tone] = STATUS_TEXT[e.detail.state] || ['', ''];
    el.hidden = !text; el.textContent = text; el.className = `save-status ${tone}`;
    el.title = e.detail.detail || (tone === 'ok' ? 'Your work is saved to the shared training workspace.' : '');
  });

  /* ---------- opening other pages already filled in ---------- */
  function openAppointmentFor({patient, time} = {}){
    page('appointments');
    openModal('appointment');
    const name = q('#modalFields [name="name"]'), when = q('#modalFields [name="time"]');
    if (patient && name) name.value = patient;
    if (time && when) when.value = time;
    modalDirty = false;
  }
  function openNoteFor({patient, time, appointment} = {}){
    page('medical');
    openMedicalNoteEditor();
    const f = q('#modalFields');
    if (patient && f.querySelector('[name="patient"]')) f.querySelector('[name="patient"]').value = patient;
    if (time && f.querySelector('[name="checkup"]')) f.querySelector('[name="checkup"]').value = String(time).slice(0, 16);
    if (appointment) {
      const type = f.querySelector('[name="type"]');
      if (type) type.value = /annual/i.test(visitType(appointment)) ? 'Annual physical' : 'Progress note';
      f.insertAdjacentHTML('afterbegin', `<input type="hidden" name="appointmentId" value="${esc(appointment.id)}"><p class="form-note wf-link-note">Visit note for ${esc(appointment.patient)} · ${esc(visitType(appointment))} · ${esc(formatDateTime(appointment.time, {withYear: true}))}</p>`);
    }
    modalDirty = false;
  }
  function openInvoiceFor({patient, appointment} = {}){
    page('billing');
    openNewInvoice();
    const f = q('#modalFields'), select = f.querySelector('[name="patient"]');
    if (patient && select) { select.value = patient; fire(select, 'change'); }
    if (appointment) {
      const dos = f.querySelector('[name="dateOfService"]'), service = f.querySelector('[name="service"]');
      if (dos && appointment.time) dos.value = String(appointment.time).slice(0, 10);
      if (service) service.value = visitType(appointment);
      f.insertAdjacentHTML('afterbegin', `<input type="hidden" name="appointmentId" value="${esc(appointment.id)}"><p class="form-note wf-link-note">Charge for ${esc(appointment.patient)}'s ${esc(visitType(appointment))} on ${esc(formatDay(String(appointment.time).slice(0, 10)))}. Add the ICD-11 and CPT codes, then save.</p>`);
      const insured = patients.find(p => p.n === appointment.patient)?.insurance?.provider;
      const payer = f.querySelector('[name="payer"]');
      if (insured && payer && !payer.value) payer.value = insured;
    }
    modalDirty = false;
  }
  function openPrescriptionFor(name){
    if (name) activeErxPatient = name;
    activeErxTab = 'Prescriptions';
    page('prescriptions');
    openNewPrescription();
    modalDirty = false;
  }
  function openErxTab(tab){ activeErxTab = tab; page('prescriptions'); }
  function openReferralFor(name){
    if (!q('.nav-item[data-page="referrals"]')) { toast('Referrals / Orders is not available on this page.'); return; }
    page('referrals');
    q('#roNew')?.click();
    if (!name) return;
    const pick = q('#roForm select[name="patientId"]') || q('#roForm select[name="patient"]');
    const target = patients.find(p => p.n === name);
    if (pick && target) {
      const option = [...pick.options].find(o => o.value === target.id || o.value === target.n || o.textContent.trim().startsWith(target.n));
      if (option) { pick.value = option.value; fire(pick, 'change'); }
    }
  }
  // Remember which appointment a note or invoice came from, so the task list knows it is done.
  document.addEventListener('submit', e => {
    if (!e.target || e.target.id !== 'modalForm') return;
    const type = modalEl.dataset.type;
    if (!['medical-create', 'billing-create'].includes(type)) return;
    const link = e.target.querySelector('[name="appointmentId"]')?.value;
    if (!link) return;
    const list = type === 'medical-create' ? () => medicalRecords : () => invoices, first = list()[0];
    setTimeout(() => { const rec = list()[0]; if (rec && rec !== first) { rec.appointmentId = link; type === 'medical-create' ? saveMedicalRecords() : saveInvoices(); } }, 0);
  }, true);

  /* ---------- tasks (dashboard card, bell and "View all tasks") ---------- */
  const recentDays = 30;
  const recentlyCompleted = () => appointments.filter(a => validTime(a) && a.status === 'Completed' && apptTime(a) >= new Date(Date.now() - recentDays * 864e5));
  const noteFor = a => medicalRecords.some(r => r.appointmentId === a.id || (r.patient === a.patient && r.checkup && String(r.checkup).slice(0, 10) === String(a.time).slice(0, 10)));
  const invoiceFor = a => invoices.some(x => x.appointmentId === a.id || (x.patient === a.patient && String(x.dateOfService || '').slice(0, 10) === String(a.time).slice(0, 10)));
  function openOrders(){
    try {
      const ro = currentCloudState().referralsOrders || {};
      const closed = new Set(['Completed', 'Cancelled', 'Approved', 'Denied', 'Cancelled / Closed']);
      return Object.values(ro).flat().filter(r => r && !closed.has(r.status));
    } catch (e) { return []; }
  }
  function computeTasks(){
    const tasks = [];
    const stale = appointments.filter(needsUpdate).sort((a, b) => String(b.time).localeCompare(String(a.time)));
    if (stale.length) tasks.push({tone: 'coral', title: 'Past appointments to update', text: `${plural(stale.length, 'visit')} still marked Scheduled, Confirmed or Checked In`, count: stale.length, go: () => { page('appointments'); setApptFilter('needs-update'); }});
    const unnoted = recentlyCompleted().filter(a => !noteFor(a));
    if (unnoted.length) tasks.push({tone: 'coral', title: 'Visit notes to write', text: `${plural(unnoted.length, 'completed visit')} without a SOAP note`, count: unnoted.length, go: () => openNoteFor({patient: unnoted[0].patient, time: unnoted[0].time, appointment: unnoted[0]})});
    const unbilled = recentlyCompleted().filter(a => !invoiceFor(a));
    if (unbilled.length) tasks.push({tone: 'amber', title: 'Visits to bill', text: `${plural(unbilled.length, 'completed visit')} without an invoice`, count: unbilled.length, go: () => openInvoiceFor({patient: unbilled[0].patient, appointment: unbilled[0]})});
    const refills = refillRequests.filter(r => !['Approved', 'Denied', 'Completed'].includes(r.status));
    if (refills.length) tasks.push({tone: 'amber', title: 'Refill requests', text: `${plural(refills.length, 'request')} waiting for review`, count: refills.length, go: () => openErxTab('Refill Requests')});
    const messages = pharmacyMessages.filter(m => m.status !== 'Closed'), urgent = messages.filter(m => m.status === 'Urgent').length;
    if (messages.length) tasks.push({tone: urgent ? 'coral' : 'blue', title: 'Pharmacy messages', text: `${plural(messages.length, 'open message')}${urgent ? ` · ${urgent} urgent` : ''}`, count: messages.length, urgent, go: () => openErxTab('Pharmacy Messages')});
    const pas = priorAuthorizations.filter(p => !['Approved', 'Denied', 'Expired', 'Cancelled', 'Cancelled / Closed'].includes(p.status));
    if (pas.length) tasks.push({tone: 'blue', title: 'Medication prior authorizations', text: `${plural(pas.length, 'request')} in progress`, count: pas.length, go: () => openErxTab('Prior Authorizations')});
    const orders = openOrders();
    if (orders.length) tasks.push({tone: 'blue', title: 'Referrals & orders', text: `${plural(orders.length, 'open referral or order', 'open referrals and orders')}`, count: orders.length, go: () => page('referrals')});
    const denied = invoices.filter(x => x.status === 'Denied' || x.claimStatus === 'Denied');
    if (denied.length) tasks.push({tone: 'coral', title: 'Denied claims to fix', text: `${plural(denied.length, 'claim')} to correct and resubmit`, count: denied.length, go: () => { page('billing'); setInvoiceFilter('Denied'); }});
    const drafts = invoices.filter(x => x.status === 'Draft');
    if (drafts.length) tasks.push({tone: 'amber', title: 'Draft invoices', text: `${plural(drafts.length, 'invoice')} not sent yet`, count: drafts.length, go: () => { page('billing'); setInvoiceFilter('Draft'); }});
    return tasks;
  }
  function openTaskPanel(){
    const tasks = computeTasks();
    openPanel('Tasks to review', tasks.length
      ? `<p class="form-note">Everything below comes from the shared training workspace. Open a task to work on it.</p><div class="wf-task-list">${tasks.map((t, i) => `<button type="button" class="wf-task" data-task="${i}"><span class="dot ${t.tone}-dot"></span><span><b>${esc(t.title)}</b><small>${esc(t.text)}</small></span><em>${t.count}</em><span class="wf-go">Open →</span></button>`).join('')}</div>`
      : '<div class="wf-empty"><b>All caught up</b><p>No open tasks right now. New tasks appear here as patients are scheduled, seen and billed.</p></div>');
    qa('.wf-task').forEach(b => b.onclick = () => { closeModal(); tasks[Number(b.dataset.task)].go(); });
  }

  /* ---------- dashboard ---------- */
  function greeting(){
    const h = q('#dashboard .welcome h1'); if (!h) return;
    const hour = new Date().getHours(), text = hour < 12 ? 'Good morning, ' : hour < 18 ? 'Good afternoon, ' : 'Good evening, ';
    if (h.firstChild && h.firstChild.nodeType === 3) h.firstChild.textContent = text;
  }
  function setCard(card, label, value, note, tone, onOpen){
    if (!card) return;
    const small = card.querySelector('small'), strong = card.querySelector('strong'), em = card.querySelector('em');
    if (small) small.textContent = label;
    if (strong) strong.textContent = value;
    if (em) { em.textContent = note; em.className = tone || 'muted'; }
    if (!card.dataset.wfBound) {
      card.dataset.wfBound = '1'; card.onclick = null; card.classList.add('wf-clickable'); card.tabIndex = 0; card.setAttribute('role', 'button');
      card.addEventListener('click', () => card._open && card._open());
      card.addEventListener('keydown', e => { if (e.key === 'Enter' && card._open) card._open(); });
    }
    card._open = onOpen;
  }
  const baseStats = typeof updateDashboardStats === 'function' ? updateDashboardStats : () => {};
  updateDashboardStats = function(){
    baseStats();
    const cards = qa('#dashboard .stat-grid article'), today = new Date();
    const todays = appointments.filter(a => validTime(a) && sameDay(apptTime(a), today) && !['Cancelled', 'No Show'].includes(a.status));
    const checkedIn = todays.filter(a => ['Checked In', 'Completed'].includes(a.status)).length;
    const weekEnd = new Date(startOfDay(today).getTime() + 7 * 864e5);
    const week = appointments.filter(a => validTime(a) && isOpenAppt(a) && apptTime(a) > today && apptTime(a) < weekEnd && !sameDay(apptTime(a), today)).length;
    const unpaid = invoices.filter(x => x.status !== 'Paid'), outstanding = unpaid.reduce((s, x) => s + balanceOf(x), 0);
    const tasks = computeTasks(), taskTotal = tasks.reduce((s, t) => s + t.count, 0), urgent = tasks.filter(t => t.tone === 'coral').reduce((s, t) => s + t.count, 0);
    setCard(cards[0], 'Patients today', String(new Set(todays.map(a => a.patient)).size), `${plural(checkedIn, 'checked in or seen', 'checked in or seen')} · ${patients.length} in total`, 'muted', () => page('patients'));
    setCard(cards[1], 'Appointments today', String(todays.length), `${week} more in the next 7 days`, 'muted', () => { page('appointments'); setApptFilter('upcoming'); });
    setCard(cards[2], 'Outstanding billing', `$${Math.round(outstanding).toLocaleString('en-US')}`, `${plural(unpaid.length, 'unpaid invoice')}`, 'muted', () => { page('billing'); setInvoiceFilter('Unpaid'); });
    setCard(cards[3], 'Pending tasks', String(taskTotal), urgent ? `${urgent} need attention first` : 'Nothing urgent', urgent ? 'negative' : 'positive', openTaskPanel);
    renderTaskCard(tasks, taskTotal);
    const dot = q('.notification i'); if (dot) dot.hidden = !taskTotal;
    greeting();
  };
  function renderTaskCard(tasks, total){
    const card = q('#dashboard .card.tasks'); if (!card) return;
    const badge = card.querySelector('.round-badge'); if (badge) badge.textContent = String(total);
    card.querySelectorAll('.task').forEach(t => t.remove());
    const viewAll = card.querySelector('.view-all');
    const html = tasks.length
      ? tasks.slice(0, 4).map((t, i) => `<div class="task"><span class="dot ${t.tone}-dot"></span><div><b>${esc(t.title)}</b><p>${esc(t.text)}</p></div><button type="button" data-dash-task="${i}">Review</button></div>`).join('')
      : '<div class="task wf-all-clear"><span class="dot"></span><div><b>All caught up</b><p>No open tasks right now.</p></div></div>';
    if (viewAll) viewAll.insertAdjacentHTML('beforebegin', html); else card.insertAdjacentHTML('beforeend', html);
    card.querySelectorAll('[data-dash-task]').forEach(b => b.onclick = () => tasks[Number(b.dataset.dashTask)].go());
    if (viewAll) viewAll.onclick = openTaskPanel;
  }
  renderSchedule = function(){
    const target = q('#scheduleList'); if (!target) return;
    const today = new Date();
    const sub = q('#dashboard .schedule .card-head p');
    if (sub) sub.textContent = today.toLocaleDateString('en-US', {weekday: 'long', day: 'numeric', month: 'long'});
    const todays = appointments.filter(a => validTime(a) && sameDay(apptTime(a), today) && !['Cancelled', 'No Show'].includes(a.status)).sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const upcoming = appointments.filter(a => validTime(a) && isOpenAppt(a) && apptTime(a) > today && !sameDay(apptTime(a), today)).sort((a, b) => String(a.time).localeCompare(String(b.time))).slice(0, 3);
    const row = (a, i, showDate) => { const d = apptTime(a); return `<button type="button" class="appt wf-appt" data-appointment="${esc(a.id)}"><time><b>${d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'})}</b>${showDate ? d.toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : ''}</time><span class="line-dot ${i % 3 === 1 ? 'blue-dot' : i % 3 === 2 ? 'amber-dot' : ''}"></span><div class="appt-info"><b>${esc(a.patient)}</b><p>${esc(visitType(a))}</p></div><span class="appt-tag appointment-status ${appointmentStatusClass(a.status)}">${esc(a.status || 'Scheduled')}</span></button>`; };
    target.innerHTML = todays.length
      ? todays.map((a, i) => row(a, i, false)).join('')
      : `<div class="wf-empty compact"><b>No appointments today</b><p>${upcoming.length ? 'Next up:' : 'Nothing is scheduled yet.'}</p></div>${upcoming.map((a, i) => row(a, i, true)).join('')}`;
    target.querySelectorAll('[data-appointment]').forEach(b => b.onclick = () => openAppointmentEditor(b.dataset.appointment));
  };
  // "+ New appointment" on the dashboard opens the booking form, not just the calendar.
  q('#dashboard .welcome [data-page="appointments"]')?.addEventListener('click', () => setTimeout(() => openModal('appointment'), 0));

  /* ---------- appointments: list filters, calendar, connected actions ---------- */
  let apptFilter = 'upcoming';
  const APPT_FILTERS = [['upcoming', 'Upcoming'], ['needs-update', 'Needs update'], ['past', 'Past'], ['cancelled', 'Cancelled / No-show'], ['all', 'All']];
  function apptGroups(){
    const sod = startOfDay(new Date()), valid = appointments.filter(validTime);
    return {
      upcoming: valid.filter(a => isOpenAppt(a) && apptTime(a) >= sod && !needsUpdate(a)).sort((a, b) => String(a.time).localeCompare(String(b.time))),
      'needs-update': valid.filter(needsUpdate).sort((a, b) => String(b.time).localeCompare(String(a.time))),
      past: valid.filter(a => apptTime(a) < sod && !['Cancelled', 'No Show'].includes(a.status)).sort((a, b) => String(b.time).localeCompare(String(a.time))),
      cancelled: valid.filter(a => ['Cancelled', 'No Show'].includes(a.status)).sort((a, b) => String(b.time).localeCompare(String(a.time))),
      all: [...appointments].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
    };
  }
  function setApptFilter(f){ apptFilter = f; renderAppointmentList(); q('.appointment-list-card')?.scrollIntoView({block: 'start'}); }
  renderAppointmentList = function(){
    normalizeAppointments();
    const target = q('#appointmentList'); if (!target) return;
    const head = q('.appointment-list-card .card-head'), groups = apptGroups();
    if (head) {
      head.querySelector('h3').textContent = 'Appointment list';
      head.querySelector('p').textContent = 'Open an appointment to update its status as the visit moves along.';
      let bar = q('#apptFilters');
      if (!bar) { head.insertAdjacentHTML('afterend', '<div class="wf-filter-bar" id="apptFilters" role="tablist" aria-label="Appointment filters"></div>'); bar = q('#apptFilters'); }
      bar.innerHTML = APPT_FILTERS.map(([key, label]) => `<button type="button" role="tab" aria-selected="${apptFilter === key}" class="${apptFilter === key ? 'active' : ''}${key === 'needs-update' && groups[key].length ? ' attention' : ''}" data-appt-filter="${key}">${label} <span>${groups[key].length}</span></button>`).join('');
      bar.querySelectorAll('[data-appt-filter]').forEach(b => b.onclick = () => { apptFilter = b.dataset.apptFilter; renderAppointmentList(); });
    }
    const list = groups[apptFilter] || groups.upcoming;
    const empty = {upcoming: 'No upcoming appointments. Click “+ New appointment” to book one.', 'needs-update': 'All past appointments have an outcome. Nice work.', past: 'No past appointments yet.', cancelled: 'No cancelled or no-show appointments.', all: 'No appointments yet.'}[apptFilter];
    target.innerHTML = list.map(a => `<button class="appointment-row" data-appointment="${esc(a.id)}"><span class="appt-date">${validTime(a) ? esc(formatDateTime(a.time, {withYear: true})) : 'No date'}</span><span><b>${esc(a.patient)}</b><small>${esc(visitType(a))} · ${esc(a.id)}</small></span><span>${esc(a.type)}</span><span class="pill appointment-status ${appointmentStatusClass(a.status)}">${esc(a.status || 'Scheduled')}</span><span>Manage →</span></button>`).join('') || `<p class="empty-state">${empty}</p>`;
    target.querySelectorAll('.appointment-row').forEach(row => row.onclick = () => openAppointmentEditor(row.dataset.appointment));
    const badge = q('.nav-item[data-page="appointments"] em');
    if (badge) { const n = groups.upcoming.length + groups['needs-update'].length; badge.textContent = String(n); badge.hidden = !n; }
  };
  const HOUR_START = 7, HOUR_END = 19, HOUR_PX = 56, EVENT_PX = 50;
  renderCalendar = function(){
    const view = q('#calendarViewport'); if (!view) return;
    view.classList.toggle('wf-wide', calendarView !== 'day');
    const today = new Date();
    qa('.calendar-view').forEach(x => x.classList.toggle('active', x.dataset.calendarView === calendarView));
    const label = q('#calendarLabel'), timeLabel = a => apptTime(a).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
    const statusClass = a => `status-${appointmentStatusClass(a.status)}`;
    if (calendarView === 'month') {
      label.textContent = calendarDate.toLocaleString('en-US', {month: 'long', year: 'numeric'});
      const first = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1), start = new Date(first);
      start.setDate(first.getDate() - first.getDay());
      const cells = Array.from({length: 42}, (_, i) => {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const items = appointments.filter(a => validTime(a) && sameDay(apptTime(a), d)).sort((a, b) => String(a.time).localeCompare(String(b.time)));
        return `<div class="month-day ${d.getMonth() === calendarDate.getMonth() ? '' : 'outside'} ${sameDay(d, today) ? 'is-today' : ''}" data-day="${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}" title="Click an empty space to book on this day"><b>${d.getDate()}</b>${items.map(a => `<button class="month-event calendar-appointment ${statusClass(a)}" data-appointment="${esc(a.id)}" title="${esc(timeLabel(a))} · ${esc(a.patient)} · ${esc(a.status || 'Scheduled')}"><time>${esc(timeLabel(a))}</time>${esc(a.patient)}</button>`).join('')}</div>`;
      }).join('');
      view.innerHTML = `<div class="month-weekdays"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div><div class="month-grid">${cells}</div>`;
      view.querySelectorAll('.month-day').forEach(cell => cell.onclick = e => { if (e.target.closest('.calendar-appointment')) return; openAppointmentFor({time: `${cell.dataset.day}T09:00`}); });
    } else {
      const count = calendarView === 'week' ? 7 : 1, start = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), calendarDate.getDate());
      if (calendarView === 'week') start.setDate(start.getDate() - start.getDay());
      const dates = Array.from({length: count}, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
      label.textContent = count === 1
        ? start.toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'})
        : `${dates[0].toLocaleDateString('en-US', {month: 'short', day: 'numeric'})} – ${dates[6].toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})}`;
      const height = (HOUR_END - HOUR_START) * HOUR_PX;
      const cols = dates.map(d => {
        const items = appointments.filter(a => validTime(a) && sameDay(apptTime(a), d)).sort((a, b) => String(a.time).localeCompare(String(b.time)));
        return `<div class="cal-col ${sameDay(d, today) ? 'today-bg' : ''}" data-day="${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}">${items.map((a, i) => {
          const t = apptTime(a), same = items.filter(x => String(x.time).slice(0, 16) === String(a.time).slice(0, 16)), slot = Math.max(0, same.indexOf(a));
          const top = Math.max(0, Math.min(height - EVENT_PX, ((t.getHours() - HOUR_START) * 60 + t.getMinutes()) * HOUR_PX / 60));
          const layout = same.length > 1 ? `;left:calc(${slot * (100 / same.length)}% + 4px);right:auto;width:calc(${100 / same.length}% - 8px);z-index:${5 + slot}` : '';
          return `<button class="cal-event calendar-appointment ${['event-mint', 'event-blue', 'event-peach'][i % 3]} ${statusClass(a)}" data-appointment="${esc(a.id)}" style="top:${top}px;height:${EVENT_PX}px${layout}" title="${esc(timeLabel(a))} · ${esc(a.patient)} · ${esc(a.status || 'Scheduled')}${same.length > 1 ? ' · double booking' : ''}"><time>${esc(timeLabel(a))} · ${esc(a.status || 'Scheduled')}</time><b>${esc(a.patient)}</b><span class="cal-type">${esc(visitType(a))}</span>${same.length > 1 ? '<small>Double-booked</small>' : ''}</button>`;
        }).join('')}</div>`;
      }).join('');
      const hours = Array.from({length: HOUR_END - HOUR_START}, (_, i) => { const h = HOUR_START + i; return `<div class="time-slot" style="height:${HOUR_PX}px">${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}</div>`; }).join('');
      view.innerHTML = `<div class="weekdays" style="grid-template-columns:62px repeat(${count},1fr)"><span></span>${dates.map(d => `<span class="${sameDay(d, today) ? 'today-col' : ''}">${d.toLocaleString('en-US', {weekday: 'short'}).toUpperCase()} ${d.getDate()}</span>`).join('')}</div><div class="calendar-body wf-calendar-body" style="grid-template-columns:62px repeat(${count},1fr);height:${height}px"><div>${hours}</div>${cols}</div>`;
      view.querySelectorAll('.cal-col').forEach(col => col.onclick = e => {
        if (e.target.closest('.calendar-appointment')) return;
        const y = e.clientY - col.getBoundingClientRect().top, minutes = Math.max(0, Math.round(y / HOUR_PX * 2) * 30), h = HOUR_START + Math.floor(minutes / 60), m = minutes % 60;
        openAppointmentFor({time: `${col.dataset.day}T${pad(Math.min(h, HOUR_END - 1))}:${pad(m)}`});
      });
    }
    view.querySelectorAll('.calendar-appointment').forEach(el => el.onclick = e => { e.stopPropagation(); openAppointmentEditor(el.dataset.appointment); });
  };
  function shiftCalendar(direction){
    const d = new Date(calendarDate);
    if (calendarView === 'month') calendarDate = new Date(d.getFullYear(), d.getMonth() + direction, 1);
    else { d.setDate(d.getDate() + direction * (calendarView === 'week' ? 7 : 1)); calendarDate = d; }
    renderCalendar();
  }
  if (q('#calendarPrev')) { q('#calendarPrev').onclick = () => shiftCalendar(-1); q('#calendarPrev').setAttribute('aria-label', 'Previous'); }
  if (q('#calendarNext')) { q('#calendarNext').onclick = () => shiftCalendar(1); q('#calendarNext').setAttribute('aria-label', 'Next'); }
  if (q('#calendarToday')) q('#calendarToday').onclick = () => { calendarDate = new Date(); renderCalendar(); };
  qa('.calendar-view').forEach(btn => btn.onclick = () => { calendarView = btn.dataset.calendarView; renderCalendar(); });

  const baseApptEditor = openAppointmentEditor;
  openAppointmentEditor = function(id){
    baseApptEditor(id);
    const a = appointments.find(x => x.id === id); if (!a) return;
    modalDirty = false;
    const f = q('#modalFields');
    f.querySelector('.form-note')?.remove();
    f.insertAdjacentHTML('afterbegin', `<div class="wf-actions" aria-label="Connected actions"><button type="button" class="secondary" data-wf="chart">Open patient chart</button><button type="button" class="secondary" data-wf="note">Write visit note</button><button type="button" class="secondary" data-wf="invoice">Create invoice</button></div><p class="form-note wf-status-help">Update the <b>Status</b> as the visit moves along: <b>Checked In</b> when the patient arrives, <b>Completed</b> when the visit is done. A completed visit becomes the patient's last visit.</p>`);
    f.querySelector('[data-wf="chart"]').onclick = () => { if (leaveModal()) openPatientDetails(a.patient); };
    f.querySelector('[data-wf="note"]').onclick = () => { if (leaveModal()) openNoteFor({patient: a.patient, time: a.time, appointment: a}); };
    f.querySelector('[data-wf="invoice"]').onclick = () => { if (leaveModal()) openInvoiceFor({patient: a.patient, appointment: a}); };
    if (!patients.some(p => p.n === a.patient)) f.querySelector('[data-wf="chart"]').disabled = true;
  };

  /* ---------- patients: chart summary, allergies & sex, search ---------- */
  const SEXES = ['Female', 'Male', 'Other', 'Unknown'];
  function demographicsFields(p = {}){
    return `<label>Sex<select name="sex"><option value="">Not set</option>${SEXES.map(s => `<option ${p.sex === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label>Allergies<input name="allergies" value="${esc(p.allergies || '')}" placeholder="e.g. Penicillin (hives) — leave empty for NKDA"></label>`;
  }
  function addDemographics(p){
    const dob = q('#modalFields input[name="dob"]')?.closest('label');
    if (dob && !q('#modalFields [name="allergies"]')) dob.insertAdjacentHTML('afterend', demographicsFields(p));
  }
  const baseOpenModal = openModal;
  openModal = function(type){
    baseOpenModal(type);
    if (type === 'patient') { addDemographics({}); modalDirty = false; }
  };
  function orderCountFor(p){ return openOrders().filter(r => r.patientId === p.id || r.patient === p.n).length; }
  const baseDetails = openPatientDetails;
  openPatientDetails = function(name){
    const p = patients.find(x => x.n === name);
    if (!p) { toast(`${name || 'This patient'} is no longer in the patient directory.`); return; }
    baseDetails(name);
    addDemographics(p);
    const f = q('#modalFields'), v = patientVisitSummary(p);
    const meds = prescriptions.filter(r => r.patient === p.n && r.kind !== 'history').length;
    const open = invoices.filter(x => x.patient === p.n && x.status !== 'Paid'), owed = open.reduce((s, x) => s + balanceOf(x), 0);
    const notes = medicalRecords.filter(r => r.patient === p.n).length, orders = orderCountFor(p);
    const checkup = f.querySelector('input[name="checkup"]');
    if (checkup) { const keep = document.createElement('input'); keep.type = 'hidden'; keep.name = 'checkup'; keep.value = checkup.value; checkup.closest('label').replaceWith(keep); }
    f.querySelector('.detail-banner')?.insertAdjacentHTML('afterend', `<section class="chart-summary" aria-label="Patient chart summary">
      <div class="chart-grid">
        <div><small>Last visit</small><b>${esc(v.lastLabel)}</b></div>
        <div><small>Next appointment</small><b>${esc(v.nextLabel)}</b></div>
        <div><small>Active prescriptions</small><b>${meds}</b></div>
        <div><small>Open balance</small><b>${money(owed)}</b></div>
        <div><small>Visit notes</small><b>${notes}</b></div>
        <div><small>Open referrals / orders</small><b>${orders}</b></div>
      </div>
      <div class="wf-actions">
        <button type="button" class="secondary" data-chart="appointment">Schedule appointment</button>
        <button type="button" class="secondary" data-chart="note">Write visit note</button>
        <button type="button" class="secondary" data-chart="rx">New prescription</button>
        <button type="button" class="secondary" data-chart="invoice">Create invoice</button>
        ${q('.nav-item[data-page="referrals"]') ? '<button type="button" class="secondary" data-chart="referral">New referral / order</button>' : ''}
      </div>
    </section>`);
    const go = {
      appointment: () => openAppointmentFor({patient: p.n}),
      note: () => openNoteFor({patient: p.n, time: v.lastAppointment?.time, appointment: v.lastAppointment || undefined}),
      rx: () => openPrescriptionFor(p.n),
      invoice: () => openInvoiceFor({patient: p.n, appointment: v.lastAppointment || undefined}),
      referral: () => openReferralFor(p.n)
    };
    f.querySelectorAll('[data-chart]').forEach(b => b.onclick = () => { if (leaveModal()) go[b.dataset.chart](); });
    const upload = f.querySelector('input[name="patientFile"]')?.closest('label');
    if (upload) upload.insertAdjacentHTML('beforeend', '<small class="field-hint">PDF, JPG, PNG or Word, up to 10 MB. The file uploads when you choose it; click Save details to attach it.</small>');
    modalDirty = false;
  };
  // Sex and allergies are saved after app.js has saved the rest of the patient form.
  document.addEventListener('submit', e => {
    if (!e.target || e.target.id !== 'modalForm') return;
    const type = modalEl.dataset.type;
    if (type !== 'patient-insurance' && type !== 'edit-patient-insurance') return;
    const d = new FormData(e.target);
    if (!d.has('allergies')) return;
    const sex = String(d.get('sex') || ''), allergies = String(d.get('allergies') || '').trim(), id = modalEl.dataset.patientId, first = patients[0];
    setTimeout(() => {
      const p = type === 'edit-patient-insurance' ? patients.find(x => x.id === id) : (patients[0] !== first ? patients[0] : null);
      if (!p) return;
      p.sex = sex; p.allergies = allergies;
      savePatients();
    }, 0);
  }, true);

  function openPatientSearch(){
    openPanel('Find a patient', '<label>Search by name, ID, MRN, email or date of birth<input id="wfSearch" type="search" autocomplete="off" placeholder="Start typing a name…"></label><div id="wfSearchResults" class="wf-search-results"></div>');
    const input = q('#wfSearch'), results = q('#wfSearchResults');
    const draw = () => {
      const term = input.value.trim().toLowerCase();
      const found = (term ? patients.filter(p => [p.n, p.id, p.mrn, p.email, p.dob, formatDob(p.dob)].join(' ').toLowerCase().includes(term)) : patients.slice(0, 6)).slice(0, 8);
      results.innerHTML = found.map(p => `<button type="button" class="wf-result" data-name="${esc(p.n)}"><span class="avatar">${esc(p.i || initials(p.n))}</span><span><b>${esc(p.n)}</b><small>ID ${esc(p.id)} · ${esc(p.mrn || '')} · DOB ${esc(formatDob(p.dob))}</small></span><span class="wf-go">Open →</span></button>`).join('') || '<p class="empty-state">No patient matches that search.</p>';
      results.querySelectorAll('.wf-result').forEach(b => b.onclick = () => { closeModal(); openPatientDetails(b.dataset.name); });
    };
    input.oninput = draw; input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); results.querySelector('.wf-result')?.click(); } };
    draw(); setTimeout(() => input.focus(), 30);
  }
  const searchBtn = qa('.top-actions .icon-btn').find(b => !b.classList.contains('notification'));
  if (searchBtn) { searchBtn.onclick = openPatientSearch; searchBtn.title = 'Find a patient'; searchBtn.setAttribute('aria-label', 'Find a patient'); }
  const bell = q('.top-actions .notification');
  if (bell) { bell.onclick = openTaskPanel; bell.title = 'Tasks to review'; bell.setAttribute('aria-label', 'Tasks to review'); }
  q('#patientStatusFilter')?.addEventListener('change', () => renderPatients());

  /* ---------- help center ---------- */
  const helpBtn = qa('.side-bottom .nav-item').find(b => /help/i.test(b.textContent));
  if (helpBtn) helpBtn.onclick = () => openPanel('Help center', `
    <div class="wf-help">
      <p class="form-note">Sync2EHR is a training EHR. Every patient is fictional, and everyone in your class works in the same shared clinic.</p>
      <h4>Follow one patient visit</h4>
      <ol>
        <li><b>Register</b> — Patients → <i>+ Add patient</i>. Add insurance, allergies and any documents.</li>
        <li><b>Schedule</b> — Appointments → <i>+ New appointment</i>, or click an empty time on the calendar.</li>
        <li><b>Check in</b> — open the appointment and set Status to <i>Checked In</i>.</li>
        <li><b>Document</b> — <i>Write visit note</i> from the appointment to start a SOAP note for that visit.</li>
        <li><b>Order</b> — Prescriptions for medications; Referrals / Orders for specialists, labs, imaging and prior authorizations.</li>
        <li><b>Close the visit</b> — set the appointment to <i>Completed</i>. It becomes the patient's last visit, and a New patient becomes Established.</li>
        <li><b>Bill</b> — <i>Create invoice</i> from the appointment, add ICD-11 and CPT codes, then record the payment or claim result.</li>
        <li><b>Report</b> — Reports shows live counts; filter by date, patient, provider or status and export.</li>
      </ol>
      <h4>Good to know</h4>
      <ul>
        <li>Your work saves automatically. The label next to the search button shows <i>Saving…</i> and then <i>All changes saved</i>.</li>
        <li>The bell and <i>Tasks to review</i> list what still needs doing: visits to close out, notes to write, visits to bill, refills, pharmacy messages and claims.</li>
        <li>Use the search button at the top to open any patient's chart.</li>
        <li>Forgot your password or lost access? Ask your Sync2VA coach or administrator.</li>
      </ul>
    </div>`);

  /* ---------- billing: live totals and a status filter ---------- */
  const INVOICE_FILTERS = ['All', 'Unpaid', 'Draft', 'Pending', 'Partially Paid', 'Paid', 'Denied', 'Claims'];
  const filterLabel = f => ({All: 'All invoices', Unpaid: 'All unpaid', Claims: 'Insurance claims'}[f] || f);
  function setInvoiceFilter(f){
    const btn = q('#invoiceFilter'), select = q('#invoiceFilterSelect');
    if (btn) btn.dataset.status = f;
    if (select) select.value = f;
    renderInvoices(f);
  }
  const billingHead = q('.invoice-card .card-head'), oldFilter = q('#invoiceFilter');
  if (billingHead && oldFilter && !q('#invoiceFilterSelect')) {
    oldFilter.hidden = true; oldFilter.dataset.status = oldFilter.dataset.status || 'All';
    oldFilter.insertAdjacentHTML('afterend', `<label class="wf-select-label">Show<select id="invoiceFilterSelect">${INVOICE_FILTERS.map(f => `<option value="${f}">${filterLabel(f)}</option>`).join('')}</select></label>`);
    q('#invoiceFilterSelect').onchange = e => setInvoiceFilter(e.target.value);
  }
  function updateBillingStats(){
    const cards = qa('#billing .billing-stats article'); if (!cards.length) return;
    const now = new Date(), thisMonth = d => d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    let collected = 0;
    invoices.forEach(x => (x.payments || []).forEach(p => { if (thisMonth(parseDay(p.date))) collected += Number(p.amount || 0); }));
    const unpaid = invoices.filter(x => x.status !== 'Paid'), outstanding = unpaid.reduce((s, x) => s + balanceOf(x), 0);
    const claims = invoices.filter(x => x.claimStatus && !['Not Submitted', 'N/A'].includes(x.claimStatus));
    const paidClaims = claims.filter(x => x.claimStatus === 'Paid').length, deniedClaims = claims.filter(x => x.claimStatus === 'Denied').length;
    const rate = paidClaims + deniedClaims ? Math.round(paidClaims / (paidClaims + deniedClaims) * 100) : null;
    setCard(cards[0], 'Collected this month', money(collected), `${now.toLocaleString('en-US', {month: 'long'})} payments recorded`, 'muted', () => setInvoiceFilter('Paid'));
    setCard(cards[1], 'Outstanding', money(outstanding), plural(unpaid.length, 'unpaid invoice'), 'muted', () => setInvoiceFilter('Unpaid'));
    setCard(cards[2], 'Insurance claims', String(claims.length), rate == null ? 'No paid or denied claims yet' : `${rate}% paid without denial`, rate == null || rate >= 80 ? 'positive' : 'negative', () => setInvoiceFilter('Claims'));
  }
  const baseRenderInvoices = renderInvoices;
  renderInvoices = function(filter = q('#invoiceFilter')?.dataset.status || 'All'){
    if (q('#invoiceFilter')) q('#invoiceFilter').dataset.status = filter;
    if (q('#invoiceFilterSelect')) q('#invoiceFilterSelect').value = INVOICE_FILTERS.includes(filter) ? filter : 'All';
    baseRenderInvoices(filter);
    updateBillingStats();
  };

  // Billing entries are checked like a real claim scrubber before they are saved.
  const ICD11 = /^[0-9A-HJ-NP-Z][A-HJ-NP-Z][0-9][0-9A-HJ-NP-Z](\.[0-9A-HJ-NP-Z]{1,2})?$/;
  const CPT = /^(\d{4}[0-9A-Z]|[A-Z]\d{4})$/;
  document.addEventListener('submit', e => {
    if (!e.target || e.target.id !== 'modalForm' || !['billing-create', 'billing-edit'].includes(modalEl.dataset.type)) return;
    const f = e.target, field = n => f.querySelector(`[name="${n}"]`);
    const icd = field('icd10'), cpt = field('cpt'), reason = field('denialReason'), payerType = field('payerType'), payer = field('payer');
    [icd, cpt, reason, payer].forEach(x => x && x.setCustomValidity(''));
    if (icd) icd.value = icd.value.trim().toUpperCase();
    if (cpt) cpt.value = cpt.value.trim().toUpperCase();
    let bad = null;
    if (icd && !ICD11.test(icd.value)) { icd.setCustomValidity('Enter an ICD-11 code, for example QA00.0 or CA42.'); bad = bad || icd; }
    if (cpt && !CPT.test(cpt.value)) { cpt.setCustomValidity('Enter a 5-character CPT or HCPCS code, for example 99213.'); bad = bad || cpt; }
    const denied = field('status')?.value === 'Denied' || field('claimStatus')?.value === 'Denied';
    if (reason && denied && !reason.value.trim()) { reason.setCustomValidity('Add the denial reason so the claim can be corrected.'); bad = bad || reason; }
    if (payer && payerType?.value === 'Insurance' && /^self/i.test(payer.value.trim())) { payer.setCustomValidity('Insurance claims need the insurance company name as the payer.'); bad = bad || payer; }
    if (!bad) return;
    e.preventDefault(); e.stopImmediatePropagation();
    bad.reportValidity();
    const clear = () => [icd, cpt, reason, payer].forEach(x => x && x.setCustomValidity(''));
    f.addEventListener('input', clear, {once: true}); f.addEventListener('change', clear, {once: true});
  }, true);

  /* ---------- reports: live numbers that follow the filters ---------- */
  const APPT_STATUS = ['Scheduled', 'Confirmed', 'Checked In', 'Completed', 'Cancelled', 'No Show', 'Rescheduled'];
  const PATIENT_STATUS = ['New', 'Established', 'Referral', 'Terminated', 'Deceased'];
  const BILL_STATUS = ['Draft', 'Pending', 'Paid', 'Partially Paid', 'Denied', 'Submitted', 'Resubmitted', 'Not Submitted'];
  activeReportFilters = function(){
    const from = q('#reportFrom')?.value || '', to = q('#reportTo')?.value || '';
    const date = from || to ? `${from ? formatDay(from) : 'Any start'} – ${to ? formatDay(to) : 'today'}` : 'All dates';
    return {from, to, date, patient: (q('#reportPatientName')?.value || '').trim() || 'All patients', provider: q('#reportProvider')?.value || 'All providers', status: q('#reportStatus')?.value || 'All statuses'};
  };
  function inRange(value, f){
    if (!f.from && !f.to) return true;
    const d = parseDay(value) || (value ? new Date(value) : null);
    if (!d || Number.isNaN(d.getTime())) return false;
    const day = startOfDay(d);
    return !(f.from && day < new Date(f.from + 'T00:00')) && !(f.to && day > new Date(f.to + 'T00:00'));
  }
  let reportRecords = {};
  reportRows = function(){
    const f = activeReportFilters(), term = f.patient === 'All patients' ? '' : f.patient.toLowerCase(), st = f.status === 'All statuses' ? '' : f.status;
    const who = n => !term || String(n || '').toLowerCase().includes(term);
    const appts = appointments.filter(a => who(a.patient) && inRange(a.time, f) && (!st || !APPT_STATUS.includes(st) || a.status === st));
    const pts = patients.filter(p => who(p.n) && (!st || !PATIENT_STATUS.includes(st) || (p.status || 'New') === st));
    const inv = invoices.filter(x => who(x.patient) && inRange(x.dateOfService || x.date, f) && (f.provider === 'All providers' || x.provider === f.provider) && (!st || !BILL_STATUS.includes(st) || x.status === st || x.claimStatus === st));
    const by = (list, test) => list.filter(test);
    const established = p => ['Established', 'Complete', 'Checked in', 'In consultation'].includes(p.status);
    const paid = by(inv, x => x.status === 'Paid'), pending = by(inv, x => ['Pending', 'Draft'].includes(x.status)), partial = by(inv, x => x.status === 'Partially Paid'), denied = by(inv, x => x.status === 'Denied' || x.claimStatus === 'Denied');
    const collected = inv.reduce((s, x) => s + (x.payments || []).reduce((t, p) => t + Number(p.amount || 0), 0) || (x.status === 'Paid' ? currencyValue(x.amount) : 0), 0);
    const outstanding = by(inv, x => x.status !== 'Paid').reduce((s, x) => s + balanceOf(x), 0);
    const claim = s => by(inv, x => x.claimStatus === s);
    reportRecords = {
      'Total Appointments': appts, 'Completed Appointments': by(appts, a => a.status === 'Completed'), 'Cancelled Appointments': by(appts, a => a.status === 'Cancelled'), 'No-Show Appointments': by(appts, a => a.status === 'No Show'),
      'Total Patients': pts, 'New Patients': by(pts, p => (p.status || 'New') === 'New'), 'Established Patients': by(pts, established), 'Referral Patients': by(pts, p => p.status === 'Referral'), 'Terminated Patients': by(pts, p => p.status === 'Terminated'), 'Deceased Patients': by(pts, p => p.status === 'Deceased'),
      'Total Invoices': inv, 'Paid Invoices': paid, 'Pending Invoices': pending, 'Partially Paid Invoices': partial, 'Denied Invoices': denied, 'Total Amount Collected': by(inv, x => x.status === 'Paid' || (x.payments || []).length), 'Outstanding Balance': by(inv, x => x.status !== 'Paid'),
      'Submitted Claims': claim('Submitted'), 'Pending Claims': claim('Pending'), 'Paid Claims': claim('Paid'), 'Denied Claims': claim('Denied'), 'Resubmitted Claims': claim('Resubmitted')
    };
    const n = k => reportRecords[k].length;
    return {
      'Appointment Report': [['Total Appointments', n('Total Appointments'), 'Appointments in the selected period.'], ['Completed Appointments', n('Completed Appointments'), 'Visits marked Completed.'], ['Cancelled Appointments', n('Cancelled Appointments'), 'Appointments marked Cancelled.'], ['No-Show Appointments', n('No-Show Appointments'), 'Appointments marked No Show.']],
      'Patient Report': [['Total Patients', n('Total Patients'), 'Fictional patients in this training workspace.'], ['New Patients', n('New Patients'), 'Patients whose status is New.'], ['Established Patients', n('Established Patients'), 'Patients with status Established.'], ['Referral Patients', n('Referral Patients'), 'Patients marked as Referral.'], ['Terminated Patients', n('Terminated Patients'), 'Patients marked as Terminated.'], ['Deceased Patients', n('Deceased Patients'), 'Patients marked as Deceased.']],
      'Billing Report': [['Total Invoices', n('Total Invoices'), 'Invoices with a date of service in the period.'], ['Paid Invoices', n('Paid Invoices'), 'Invoices marked Paid.'], ['Pending Invoices', n('Pending Invoices'), 'Draft or pending invoices.'], ['Partially Paid Invoices', n('Partially Paid Invoices'), 'Invoices with a partial payment recorded.'], ['Denied Invoices', n('Denied Invoices'), 'Denied invoices or denied claims.'], ['Total Amount Collected', money(collected), 'Payments recorded on these invoices.'], ['Outstanding Balance', money(outstanding), 'Balance still owed on unpaid invoices.']],
      'Claims Report': [['Submitted Claims', n('Submitted Claims'), 'Claims sent to the payer.'], ['Pending Claims', n('Pending Claims'), 'Claims waiting for a payer response.'], ['Paid Claims', n('Paid Claims'), 'Claims paid by the payer.'], ['Denied Claims', n('Denied Claims'), 'Claims denied and ready to correct.'], ['Resubmitted Claims', n('Resubmitted Claims'), 'Corrected claims sent again.']]
    };
  };
  syncStudentReportCounts = function(){
    const values = {};
    Object.values(reportRows()).flat().forEach(r => values[r[0]] = r[1]);
    qa('#reports [data-report-metric]').forEach(btn => { const b = btn.querySelector('b'); if (b && values[btn.dataset.reportMetric] != null) b.textContent = values[btn.dataset.reportMetric]; });
  };
  function recordLine(metric, r){
    if (r.n !== undefined) return `<li><b>${esc(r.n)}</b><span>${esc(r.id)} · ${esc(r.status || 'New')}</span></li>`;
    if (r.time !== undefined) return `<li><b>${esc(r.patient)}</b><span>${esc(formatDateTime(r.time, {withYear: true}))} · ${esc(visitType(r))} · ${esc(r.status || 'Scheduled')}</span></li>`;
    return `<li><b>${esc(r.patient)}</b><span>${esc(r.id)} · ${esc(formatDay(r.dateOfService))} · ${esc(r.amount)} · ${esc(r.status)}${r.claimStatus && r.claimStatus !== 'N/A' ? ` · claim ${esc(r.claimStatus)}` : ''}</span></li>`;
  }
  const baseShowReport = showStudentReport;
  showStudentReport = function(report, metric){
    baseShowReport(report, metric);
    qa('#studentReportPreview .report-preview-item').forEach(btn => btn.onclick = () => {
      const metricName = btn.dataset.preview, list = reportRecords[metricName] || [];
      qa('#studentReportPreview .wf-report-detail').forEach(x => x.remove());
      btn.insertAdjacentHTML('afterend', `<div class="wf-report-detail">${list.length ? `<ul>${list.slice(0, 40).map(r => recordLine(metricName, r)).join('')}</ul>${list.length > 40 ? `<p class="form-note">Showing 40 of ${list.length}.</p>` : ''}` : '<p class="form-note">No records match this item with the current filters.</p>'}</div>`);
    });
  };
  ['#reportFrom', '#reportTo', '#reportProvider', '#reportStatus'].forEach(id => q(id)?.addEventListener('change', () => showStudentReport(activeStudentReport, activeStudentMetric)));
  q('#reportPatientName')?.addEventListener('input', () => showStudentReport(activeStudentReport, activeStudentMetric));

  /* ---------- keep everything fresh ---------- */
  const basePage = page;
  page = function(id){
    basePage(id);
    if (id === 'billing') updateBillingStats();
    if (id === 'reports') showStudentReport(activeStudentReport, activeStudentMetric);
  };
  const baseSync = syncConnectedViews;
  syncConnectedViews = function(){ baseSync(); if (q('#appointments.active')) renderAppointmentList(); };
  setInterval(() => { if (!document.hidden && q('#appView:not(.hidden)')) { updateDashboardStats(); renderSchedule(); } }, 60000);

  // First paint with live numbers.
  syncConnectedViews();
  updateBillingStats();
  if (typeof bindStudentReports === 'function') showStudentReport('Appointment Report');

  window.SyncWorkflow = {computeTasks, openTaskPanel, openPatientSearch, openNoteFor, openInvoiceFor, openAppointmentFor, openPrescriptionFor, openReferralFor, setApptFilter, setInvoiceFilter};
})();
