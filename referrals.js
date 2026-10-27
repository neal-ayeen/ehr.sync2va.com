/* ==========================================================================
   Sync2EHR · Referrals / Orders module
   --------------------------------------------------------------------------
   Load AFTER app.js and pharmacy.js. In index.html add a script tag with
   src="referrals.js" right after the pharmacy.js script tag, and a stylesheet
   link to referrals.css right after glass-v2.css. Remove those two lines to
   roll back. app.js is not modified.

   Four sections: Specialist Referrals, Diagnostic Orders, Procedure Orders and
   Service Prior Authorizations (non-medication; medication PAs stay under
   Prescriptions). Records are saved with the rest of the shared clinic data
   under the key "referralsOrders".

   Rules from the SynClinic spec:
   - Referral / order status and PA status are tracked separately. Approving a
     PA never changes the referral or order.
   - Provider order details lock once a record leaves Draft. Only an
     administrator can correct them, and corrections go into the history.
   - Follow-up notes and activity history are append-only and stamped with
     date, time and staff name.
   These checks run in the browser. The shared Supabase row is only protected
   if its row-level security rules say so.
   ========================================================================== */
(function(){
  'use strict';
  if (typeof currentCloudState !== 'function' || typeof applyCloudState !== 'function' || typeof page !== 'function') {
    console.warn('Referrals / Orders: referrals.js must load after app.js');
    return;
  }

  /* ---------- helpers ---------- */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad = n => String(n).padStart(2, '0');
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayIso = () => isoDay(new Date());
  const shiftDay = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); };
  const stamp = (n, h, m) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmtDate(iso){
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
  }
  function fmtStamp(iso){
    const d = new Date(iso); if (isNaN(d)) return '';
    let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${h}:${pad(d.getMinutes())} ${ap}`;
  }
  const isAdmin = () => typeof currentUserIsAdmin === 'function'
    ? currentUserIsAdmin()
    : Boolean(typeof cloudUser !== 'undefined' && cloudUser && typeof PERMANENT_ACCESS_USER_IDS !== 'undefined' && PERMANENT_ACCESS_USER_IDS.has(cloudUser.id));
  const myName = () => (typeof cloudProfile !== 'undefined' && cloudProfile && cloudProfile.name)
    || (typeof cloudUser !== 'undefined' && cloudUser && cloudUser.name) || 'Clinic user';
  const uid = prefix => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const unique = list => [...new Set(list.filter(Boolean).map(x => String(x).trim()).filter(Boolean))];
  const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

  /* ---------- reference lists ---------- */
  const PROVIDERS = ['Dr. Sync', 'Dr. Alex Morgan', 'Dr. Kim Santos'];
  const SPECIALTIES = ['Allergy & Immunology','Cardiology','Dermatology','Endocrinology','ENT (Otolaryngology)','Gastroenterology','Nephrology','Neurology','Obstetrics & Gynecology','Oncology','Ophthalmology','Orthopedic Surgery','Physical Therapy','Psychiatry','Pulmonology','Rheumatology','Urology','Other'];
  const FACILITIES = ['Bay Area Diagnostic Lab','Bayview Imaging Center','Harbor GI Endoscopy Center','Westside Surgery Center','Dr. Anthony Smith, City Ortho Center','Skin & Laser Clinic','Heart & Vascular Institute','Dr. Lisa Chen, NeuroCare Center'];
  const DX_TESTS = [
    ['CBC with Platelet Count','Laboratory','CPT 85027'], ['Lipid Panel','Laboratory','CPT 80061'], ['HbA1c','Laboratory','CPT 83036'],
    ['Urinalysis','Laboratory','CPT 81003 automated, without microscopy'], ['Comprehensive Metabolic Panel','Laboratory','CPT 80053'], ['TSH','Laboratory','CPT 84443'],
    ['X-ray Chest, 2 views','Imaging','CPT 71046'], ['Ultrasound Abdomen, complete','Imaging','CPT 76700'],
    ['CT Scan Abdomen','Imaging','CPT 74150 without contrast · 74160 with contrast'], ['MRI Lumbar Spine','Imaging','CPT 72148 without contrast'], ['Mammogram, screening','Imaging','CPT 77067']
  ];
  const PROCEDURES = [
    ['Colonoscopy','HCPCS G0121 screening · CPT 45378 diagnostic'], ['Endoscopy','CPT 43235 upper GI (EGD), diagnostic'], ['Echocardiogram','CPT 93306 transthoracic, complete'],
    ['Knee Arthroscopy','CPT 29870 diagnostic · 29881 with meniscectomy'], ['Cardiac stress test','CPT 93015'], ['Carpal tunnel release','CPT 64721'], ['Cataract surgery with lens implant','CPT 66984']
  ];
  const BASE_INSURERS = ['UnitedCare','BlueCross PPO','Allied Health'];
  const METHODS = ['Portal','Fax','Phone','Electronic PA'];
  const SERVICE_TYPES = [['Specialist','Specialist service'],['Diagnostic','Diagnostic test'],['Procedure','Procedure']];

  const T = {
    referrals: {tab:'Specialist Referrals', one:'Specialist referral', prefix:'REF', newBtn:'New Referral', create:'Create referral',
      blurb:'Referrals to specialists such as dermatology, cardiology and neurology.', search:'Search patient, specialty or provider',
      statuses:['Draft','Pending / Sent','Received by Specialist','Scheduled','Completed','Cancelled'], defaultStatus:'Draft',
      clinical:['patient','provider','specialty','reason','diagnosis','icd11','priority','date'],
      fields:['patientId','patient','provider','specialty','referredTo','priority','reason','diagnosis','icd11','date','status','assignedTo','insurance','memberId','authRequired']},
    diagnostic: {tab:'Diagnostic Orders', one:'Diagnostic order', prefix:'DX', newBtn:'New Diagnostic Order', create:'Create order',
      blurb:'Laboratory and imaging tests ordered by a provider.', search:'Search patient, test or provider',
      statuses:['Draft','Ordered','Sent to Facility','Pending Scheduling','Scheduled','Completed','Cancelled'], defaultStatus:'Ordered',
      clinical:['patient','provider','test','category','reason','diagnosis','icd11','cpt','priority','date'],
      fields:['patientId','patient','provider','category','test','priority','reason','diagnosis','icd11','cpt','date','facility','scheduledDate','status','assignedTo','insurance','memberId','authRequired']},
    procedures: {tab:'Procedure Orders', one:'Procedure order', prefix:'PROC', newBtn:'New Procedure Order', create:'Create procedure order',
      blurb:'Procedures ordered by a provider, from endoscopy to outpatient surgery.', search:'Search patient, procedure or facility',
      statuses:['Draft','Ordered','Pending Scheduling','Scheduled','Completed','Cancelled'], defaultStatus:'Ordered',
      clinical:['patient','provider','procedure','diagnosis','icd11','cpt','priority','date'],
      fields:['patientId','patient','provider','procedure','diagnosis','icd11','cpt','priority','date','facility','procedureDate','status','assignedTo','insurance','memberId','authRequired']},
    servicePAs: {tab:'Service Prior Authorizations', one:'Service prior authorization', prefix:'SPA', newBtn:'New Service PA', create:'Create PA',
      blurb:'Insurance prior authorizations for tests, procedures and specialist services. Medication PAs stay under Prescriptions.', search:'Search patient, service or reference #',
      statuses:['Draft','Pending','Additional Info Needed','Approved','Denied','Cancelled / Closed'], defaultStatus:'Draft',
      clinical:['patient','serviceType','service','provider','diagnosis','icd11','cpt'],
      fields:['patientId','patient','serviceType','service','provider','facility','diagnosis','icd11','cpt','insurance','memberId','link','paRef','method','submitted','status','assignedTo','followUp',
        'pendingCurrent','pendingRemarks','infoReceived','infoRequested','infoDeadline','infoAction','authNumber','approvalDate','effectiveDate','expirationDate','approvedService','denialDate','denialReason','appealInstructions']}
  };
  const ORDER = ['referrals','diagnostic','procedures','servicePAs'];
  const ORDER_TYPES = ['referrals','diagnostic','procedures'];
  const CLOSED = new Set(['Completed','Cancelled','Approved','Denied','Cancelled / Closed']);
  const SUBMITTED = new Set(['Pending','Additional Info Needed','Approved','Denied']);
  const TONE = {'Draft':'gray','Pending / Sent':'amber','Received by Specialist':'blue','Ordered':'blue','Sent to Facility':'blue','Pending Scheduling':'amber','Scheduled':'blue','Completed':'green','Cancelled':'red',
    'Pending':'amber','Additional Info Needed':'orange','Approved':'green','Denied':'red','Cancelled / Closed':'gray'};
  const LABELS = {patient:'patient',provider:'provider',specialty:'specialty',reason:'reason',diagnosis:'diagnosis',icd11:'ICD-11 code',cpt:'CPT / HCPCS code',priority:'priority',date:'order date',test:'test',category:'category',procedure:'procedure',serviceType:'service type',service:'requested service'};
  const mainOf = (type, r) => type === 'referrals' ? r.specialty : type === 'diagnostic' ? r.test : type === 'procedures' ? r.procedure : r.service;

  /* ---------- sample cases (spec section 7), dated relative to the first load ---------- */
  function seedStore(){
    const y = new Date().getFullYear();
    const num = (p, i) => `${p}-${y}-${String(i).padStart(4, '0')}`;
    const ev = (day, h, m, by, text) => ({at: stamp(day, h, m), by, text});
    const base = (id, i, prefix, patientId, patient, createdDay, by) => ({id, number: num(prefix, i), patientId, patient, createdAt: stamp(createdDay, 9, 0), createdBy: by});
    return {
      referrals: [
        {...base('REF-S1', 1, 'REF', '00000001', 'Jordan Olsen', -9, 'Care Team'), provider:'Dr. Sync', specialty:'Dermatology', referredTo:'Skin & Laser Clinic', priority:'Routine',
          reason:'Atopic eczema on both forearms, not controlled after 8 weeks of topical steroids. Evaluate for systemic therapy or phototherapy.', diagnosis:'Atopic eczema', icd11:'EA80',
          date:shiftDay(-9), status:'Pending / Sent', assignedTo:'Care Team', insurance:'Allied Health', memberId:'AH-448210937', authRequired:true, paId:'SPA-S4',
          notes:[ev(-9, 9, 40, 'Care Team', 'Referral faxed to Skin & Laser Clinic with the last two visit notes. Allied Health requires prior authorization for specialist visits, so a Service PA was submitted.')],
          history:[ev(-9, 9, 41, 'Care Team', 'Follow-up note added'), ev(-9, 9, 35, 'Care Team', `Linked to Service PA PA-${y}-0105`), ev(-9, 9, 30, 'Care Team', 'Status changed from Draft to Pending / Sent'), ev(-9, 9, 0, 'Care Team', 'Specialist referral created as Draft')]},
        {...base('REF-S2', 2, 'REF', '00000005', 'David Kim', -12, 'Alex Morgan'), provider:'Dr. Sync', specialty:'Cardiology', referredTo:'Heart & Vascular Institute', priority:'Routine',
          reason:'Blood pressure above goal on two medications. Evaluate for secondary causes and overall cardiac risk.', diagnosis:'Essential hypertension', icd11:'BA00',
          date:shiftDay(-12), status:'Scheduled', assignedTo:'Alex Morgan', insurance:'UnitedCare', memberId:'UC-302118845', authRequired:false,
          notes:[ev(-4, 14, 10, 'Alex Morgan', `Heart & Vascular Institute confirmed the appointment for ${fmtDate(shiftDay(5))} at 9:30 AM. Patient notified by phone.`)],
          history:[ev(-4, 14, 11, 'Alex Morgan', 'Follow-up note added'), ev(-4, 14, 10, 'Alex Morgan', 'Status changed from Received by Specialist to Scheduled'), ev(-8, 11, 0, 'Alex Morgan', 'Status changed from Pending / Sent to Received by Specialist'), ev(-12, 9, 20, 'Alex Morgan', 'Status changed from Draft to Pending / Sent'), ev(-12, 9, 0, 'Alex Morgan', 'Specialist referral created as Draft')]},
        {...base('REF-S3', 3, 'REF', '00000004', 'Elena Rossi', -30, 'Care Team'), provider:'Dr. Sync', specialty:'Neurology', referredTo:'Dr. Lisa Chen, NeuroCare Center', priority:'Routine',
          reason:'Migraine with increasing frequency (8 to 10 days a month) despite preventive therapy.', diagnosis:'Migraine', icd11:'8A80',
          date:shiftDay(-30), status:'Completed', assignedTo:'Care Team', insurance:'BlueCross PPO', memberId:'BCP-77120456', authRequired:false,
          notes:[ev(-6, 10, 5, 'Care Team', 'Consult note received from Dr. Lisa Chen and sent to Dr. Sync for review.')],
          history:[ev(-6, 10, 6, 'Care Team', 'Status changed from Scheduled to Completed'), ev(-6, 10, 5, 'Care Team', 'Follow-up note added'), ev(-21, 15, 0, 'Care Team', 'Status changed from Pending / Sent to Scheduled'), ev(-30, 9, 30, 'Care Team', 'Status changed from Draft to Pending / Sent'), ev(-30, 9, 0, 'Care Team', 'Specialist referral created as Draft')]}
      ],
      diagnostic: [
        {...base('DX-S1', 1, 'DX', '00000003', 'Marcus Chen', -2, 'Alex Morgan'), provider:'Dr. Sync', category:'Laboratory', test:'CBC with Platelet Count', priority:'Routine',
          reason:'Routine blood work for annual physical.', diagnosis:'General adult medical examination', icd11:'QA00.0', cpt:'85027', date:shiftDay(-2),
          facility:'Bay Area Diagnostic Lab', scheduledDate:'', status:'Ordered', assignedTo:'Alex Morgan', insurance:'UnitedCare', memberId:'UC-118204563', authRequired:false,
          notes:[], history:[ev(-2, 9, 0, 'Alex Morgan', 'Diagnostic order created (status: Ordered)')]},
        {...base('DX-S2', 2, 'DX', '00000003', 'Marcus Chen', -8, 'Alex Morgan'), provider:'Dr. Sync', category:'Imaging', test:'MRI Lumbar Spine', priority:'Routine',
          reason:'Low back pain radiating to the left leg for 8 weeks, no improvement after 6 weeks of physical therapy. MRI without contrast.', diagnosis:'Low back pain', icd11:'ME84.2', cpt:'72148', date:shiftDay(-8),
          facility:'Bayview Imaging Center', scheduledDate:'', status:'Pending Scheduling', assignedTo:'Alex Morgan', insurance:'UnitedCare', memberId:'UC-118204563', authRequired:true, paId:'SPA-S1',
          notes:[ev(-8, 10, 0, 'Alex Morgan', 'Checked UnitedCare requirements: outpatient MRI needs prior authorization. Imaging center will schedule once the PA is approved.')],
          history:[ev(-7, 11, 0, 'Alex Morgan', `Linked to Service PA PA-${y}-0101`), ev(-8, 10, 1, 'Alex Morgan', 'Follow-up note added'), ev(-8, 9, 50, 'Alex Morgan', 'Status changed from Ordered to Pending Scheduling'), ev(-8, 9, 0, 'Alex Morgan', 'Diagnostic order created (status: Ordered)')]},
        {...base('DX-S3', 3, 'DX', '00000002', 'Samira Patel', -6, 'Care Team'), provider:'Dr. Sync', category:'Imaging', test:'CT Scan Abdomen', priority:'Urgent',
          reason:'Persistent upper abdominal pain for 3 weeks. CT with contrast to rule out gallbladder or pancreatic cause.', diagnosis:'Pain localised to upper abdomen', icd11:'MD81.10', cpt:'74160', date:shiftDay(-6),
          facility:'Bayview Imaging Center', scheduledDate:shiftDay(3), status:'Scheduled', assignedTo:'Care Team', insurance:'BlueCross PPO', memberId:'BCP-55031872', authRequired:true, paId:'SPA-S2',
          notes:[ev(-3, 13, 30, 'Care Team', `Imaging center booked the scan for ${fmtDate(shiftDay(3))}. The PA is still open, so the date may need to move if it is not approved in time.`)],
          history:[ev(-3, 13, 31, 'Care Team', 'Follow-up note added'), ev(-3, 13, 30, 'Care Team', `Scheduled for ${fmtDate(shiftDay(3))}`), ev(-3, 13, 29, 'Care Team', 'Status changed from Sent to Facility to Scheduled'), ev(-5, 10, 0, 'Care Team', `Linked to Service PA PA-${y}-0112`), ev(-6, 9, 0, 'Care Team', 'Diagnostic order created (status: Sent to Facility)')]}
      ],
      procedures: [
        {...base('PROC-S1', 1, 'PROC', '00000005', 'David Kim', -5, 'Care Team'), provider:'Dr. Sync', procedure:'Colonoscopy', diagnosis:'Screening for neoplasm of intestinal tract', icd11:'QA09.1', cpt:'G0121', priority:'Routine', date:shiftDay(-5),
          facility:'Harbor GI Endoscopy Center', procedureDate:'', status:'Pending Scheduling', assignedTo:'Care Team', insurance:'UnitedCare', memberId:'UC-302118845', authRequired:false,
          notes:[ev(-4, 11, 15, 'Care Team', 'UnitedCare confirmed no prior authorization is needed for screening colonoscopy. Left a voicemail for the patient to choose a date.')],
          history:[ev(-4, 11, 16, 'Care Team', 'Follow-up note added'), ev(-5, 9, 30, 'Care Team', 'Status changed from Ordered to Pending Scheduling'), ev(-5, 9, 0, 'Care Team', 'Procedure order created (status: Ordered)')]},
        {...base('PROC-S2', 2, 'PROC', '00000004', 'Elena Rossi', -14, 'Alex Morgan'), provider:'Dr. Kim Santos', procedure:'Knee Arthroscopy', diagnosis:'Tear of meniscus, current (right knee)', icd11:'NC93.3', cpt:'29881', priority:'Routine', date:shiftDay(-14),
          facility:'Dr. Anthony Smith, City Ortho Center', procedureDate:shiftDay(10), status:'Scheduled', assignedTo:'Alex Morgan', insurance:'BlueCross PPO', memberId:'BCP-77120456', authRequired:true, paId:'SPA-S3',
          notes:[ev(-3, 16, 0, 'Alex Morgan', `PA approved. Surgery center booked the procedure for ${fmtDate(shiftDay(10))}; pre-op instructions sent to the patient.`)],
          history:[ev(-3, 16, 1, 'Alex Morgan', 'Follow-up note added'), ev(-3, 16, 0, 'Alex Morgan', `Scheduled for ${fmtDate(shiftDay(10))}`), ev(-3, 15, 59, 'Alex Morgan', 'Status changed from Pending Scheduling to Scheduled'), ev(-13, 10, 0, 'Alex Morgan', `Linked to Service PA PA-${y}-0108`), ev(-14, 9, 0, 'Alex Morgan', 'Procedure order created (status: Ordered)')]},
        {...base('PROC-S3', 3, 'PROC', '00000002', 'Samira Patel', -40, 'Care Team'), provider:'Dr. Sync', procedure:'Endoscopy', diagnosis:'Gastro-oesophageal reflux disease', icd11:'DA22', cpt:'43235', priority:'Routine', date:shiftDay(-40),
          facility:'Harbor GI Endoscopy Center', procedureDate:shiftDay(-21), status:'Completed', assignedTo:'Care Team', insurance:'BlueCross PPO', memberId:'BCP-55031872', authRequired:false,
          notes:[ev(-20, 10, 0, 'Care Team', 'Procedure report received from Harbor GI Endoscopy Center and attached to the chart for Dr. Sync.')],
          history:[ev(-20, 10, 1, 'Care Team', 'Status changed from Scheduled to Completed'), ev(-20, 10, 0, 'Care Team', 'Follow-up note added'), ev(-35, 9, 0, 'Care Team', `Scheduled for ${fmtDate(shiftDay(-21))}`), ev(-40, 9, 0, 'Care Team', 'Procedure order created (status: Ordered)')]}
      ],
      servicePAs: [
        {...base('SPA-S1', 1, 'SPA', '00000003', 'Marcus Chen', -8, 'Alex Morgan'), serviceType:'Diagnostic', service:'MRI Lumbar Spine', provider:'Dr. Sync', facility:'Bayview Imaging Center',
          diagnosis:'Low back pain', icd11:'ME84.2', cpt:'72148', insurance:'UnitedCare', memberId:'UC-118204563', link:{type:'diagnostic', id:'DX-S2'},
          paRef:`PA-${y}-0101`, method:'Portal', submitted:shiftDay(-7), status:'Pending', assignedTo:'Alex Morgan', followUp:shiftDay(6),
          pendingCurrent:'In clinical review', pendingRemarks:'No additional documents requested at this time.',
          notes:[ev(-2, 10, 15, 'Alex Morgan', `Called UnitedCare to follow up. The representative confirmed the request is still under clinical review and no documents are needed yet. Follow-up set for ${fmtDate(shiftDay(6))}.`),
                 ev(-7, 14, 30, 'Alex Morgan', `Submitted the PA through the payer portal with the physical therapy notes attached. Reference # PA-${y}-0101.`)],
          history:[ev(-2, 10, 16, 'Alex Morgan', `Next follow-up set for ${fmtDate(shiftDay(6))}`), ev(-2, 10, 15, 'Alex Morgan', 'Follow-up note added'), ev(-7, 14, 31, 'Alex Morgan', 'Follow-up note added'),
                   ev(-7, 14, 30, 'Alex Morgan', `PA submitted via Portal. Reference # PA-${y}-0101`), ev(-7, 11, 0, 'Alex Morgan', `Linked to Diagnostic order ${num('DX', 2)}`), ev(-8, 9, 0, 'Alex Morgan', 'Service prior authorization created as Draft')]},
        {...base('SPA-S2', 2, 'SPA', '00000002', 'Samira Patel', -5, 'Care Team'), serviceType:'Diagnostic', service:'CT Scan Abdomen', provider:'Dr. Sync', facility:'Bayview Imaging Center',
          diagnosis:'Pain localised to upper abdomen', icd11:'MD81.10', cpt:'74160', insurance:'BlueCross PPO', memberId:'BCP-55031872', link:{type:'diagnostic', id:'DX-S3'},
          paRef:`PA-${y}-0112`, method:'Fax', submitted:shiftDay(-5), status:'Additional Info Needed', assignedTo:'Care Team', followUp:shiftDay(1),
          infoReceived:shiftDay(-1), infoRequested:'Most recent office visit note and the abdominal ultrasound report.', infoDeadline:shiftDay(4), infoAction:'Requested the ultrasound report from Bayview Imaging Center. Office visit note is ready to fax.',
          notes:[ev(-1, 15, 20, 'Care Team', 'BlueCross PPO faxed a request for more information. Requested the ultrasound report from the imaging center and prepared the office visit note.')],
          history:[ev(-1, 15, 21, 'Care Team', 'Follow-up note added'), ev(-1, 15, 20, 'Care Team', 'Status changed from Pending to Additional Info Needed'), ev(-1, 15, 19, 'Care Team', 'Insurance response received: additional information requested'),
                   ev(-5, 10, 30, 'Care Team', `PA submitted via Fax. Reference # PA-${y}-0112`), ev(-5, 10, 0, 'Care Team', `Linked to Diagnostic order ${num('DX', 3)}`), ev(-5, 9, 0, 'Care Team', 'Service prior authorization created as Draft')]},
        {...base('SPA-S3', 3, 'SPA', '00000004', 'Elena Rossi', -13, 'Alex Morgan'), serviceType:'Procedure', service:'Knee Arthroscopy', provider:'Dr. Kim Santos', facility:'Dr. Anthony Smith, City Ortho Center',
          diagnosis:'Tear of meniscus, current (right knee)', icd11:'NC93.3', cpt:'29881', insurance:'BlueCross PPO', memberId:'BCP-77120456', link:{type:'procedures', id:'PROC-S2'},
          paRef:`PA-${y}-0108`, method:'Electronic PA', submitted:shiftDay(-13), status:'Approved', assignedTo:'Alex Morgan', followUp:'',
          authNumber:'AUTH-7731942', approvalDate:shiftDay(-4), effectiveDate:shiftDay(-4), expirationDate:shiftDay(86), approvedService:'Knee arthroscopy with meniscectomy (CPT 29881), 1 unit, at City Ortho Center',
          notes:[ev(-4, 11, 0, 'Alex Morgan', 'BlueCross PPO approved the request. Authorization number sent to City Ortho Center so they can schedule.')],
          history:[ev(-4, 11, 1, 'Alex Morgan', 'Follow-up note added'), ev(-4, 11, 0, 'Alex Morgan', 'Status changed from Pending to Approved'), ev(-4, 10, 59, 'Alex Morgan', `Insurance response received: PA approved. Authorization # AUTH-7731942, valid ${fmtDate(shiftDay(-4))} – ${fmtDate(shiftDay(86))}`),
                   ev(-13, 10, 0, 'Alex Morgan', `PA submitted via Electronic PA. Reference # PA-${y}-0108`), ev(-13, 9, 30, 'Alex Morgan', `Linked to Procedure order ${num('PROC', 2)}`), ev(-13, 9, 0, 'Alex Morgan', 'Service prior authorization created as Draft')]},
        {...base('SPA-S4', 4, 'SPA', '00000001', 'Jordan Olsen', -9, 'Care Team'), serviceType:'Specialist', service:'Dermatology Consultation', provider:'Dr. Sync', facility:'Skin & Laser Clinic',
          diagnosis:'Atopic eczema', icd11:'EA80', cpt:'99204', insurance:'Allied Health', memberId:'AH-448210937', link:{type:'referrals', id:'REF-S1'},
          paRef:`PA-${y}-0105`, method:'Portal', submitted:shiftDay(-9), status:'Denied', assignedTo:'Care Team', followUp:'',
          denialDate:shiftDay(-3), denialReason:'Out-of-network specialist. The plan covers dermatology visits only with in-network providers.',
          appealInstructions:'Request reconsideration within 60 days with an in-network dermatologist, or submit a letter of medical necessity from Dr. Sync.',
          notes:[ev(-3, 9, 45, 'Care Team', 'Denial received. Asked Dr. Sync whether to refer to an in-network dermatologist or appeal with a letter of medical necessity.')],
          history:[ev(-3, 9, 46, 'Care Team', 'Follow-up note added'), ev(-3, 9, 45, 'Care Team', 'Status changed from Pending to Denied'), ev(-3, 9, 44, 'Care Team', 'Insurance response received: PA denied. Out-of-network specialist.'),
                   ev(-9, 9, 35, 'Care Team', `PA submitted via Portal. Reference # PA-${y}-0105`), ev(-9, 9, 34, 'Care Team', `Linked to Specialist referral ${num('REF', 1)}`), ev(-9, 9, 30, 'Care Team', 'Service prior authorization created as Draft')]}
      ]
    };
  }

  function normalizeStore(raw){
    const out = {};
    ORDER.forEach(k => {
      out[k] = (Array.isArray(raw && raw[k]) ? raw[k] : []).filter(r => r && r.id)
        .map(r => ({...r, notes: Array.isArray(r.notes) ? r.notes : [], history: Array.isArray(r.history) ? r.history : []}));
    });
    return out;
  }
  let store = normalizeStore(seedStore());
  let ctx = null;
  const state = {tab:'referrals', filters:{}};
  ORDER.forEach(k => { state.filters[k] = {q:'', status:'', extra:''}; });
  const isVisible = () => { const el = document.getElementById('referrals'); return Boolean(el && el.classList.contains('active')); };
  const findRec = (type, id) => (store[type] || []).find(r => r.id === id) || null;
  const allRecords = () => ORDER.flatMap(k => store[k].map(r => ({...r, _type: k})));

  /* ---------- saved with the rest of the shared data ---------- */
  const baseCloudState = currentCloudState;
  currentCloudState = function(){ return {...baseCloudState(), referralsOrders: cloneCloud(store)}; };
  const baseApplyCloudState = applyCloudState;
  applyCloudState = function(data = {}){
    baseApplyCloudState(data);
    // Saved data without this module (first run, or saved by an older copy of the page): keep this browser's records.
    if (data && data.referralsOrders && typeof data.referralsOrders === 'object') {
      store = normalizeStore(repairSharedText(data.referralsOrders));
      if (isVisible() && !ctx) renderList();
    }
  };
  function persist(){
    if (typeof queueCloudSave === 'function') queueCloudSave();
    return typeof cloudReady !== 'undefined' && cloudReady;
  }
  function savedToast(message){
    toast(persist() ? message : `${message} — on this device only. Shared data isn't connected, so it will be lost when the page reloads.`);
  }

  /* ---------- people, insurers and other lists ---------- */
  const allPatients = () => (typeof patients !== 'undefined' && Array.isArray(patients)) ? patients : [];
  function findPatient(id, name){
    const list = allPatients();
    return list.find(p => id && String(p.id) === String(id)) || list.find(p => name && p.n === name) || null;
  }
  function patientInsurance(p){
    if (!p) return {insurance:'', memberId:''};
    let insurance = (p.insurance && p.insurance.provider) || p.insuranceProvider || '';
    let memberId = (p.insurance && p.insurance.memberId) || p.memberId || '';
    if (!insurance) {
      const prior = allRecords().find(r => (r.patientId === p.id || r.patient === p.n) && r.insurance);
      if (prior) { insurance = prior.insurance; memberId = memberId || prior.memberId || ''; }
    }
    if (!insurance && typeof invoices !== 'undefined' && Array.isArray(invoices)) {
      const inv = invoices.find(x => x && x.patient === p.n && x.payer && !/self/i.test(x.payer));
      if (inv) insurance = inv.payer;
    }
    return {insurance, memberId};
  }
  function staffOptions(){
    const me = myName();
    const profiles = typeof cloudProfiles !== 'undefined' && cloudProfiles ? Object.values(cloudProfiles).map(p => p && p.name) : [];
    const rest = unique([...profiles, 'Care Team', ...allRecords().map(r => r.assignedTo)]).filter(n => n !== me).sort((a, b) => a.localeCompare(b));
    return [me, ...rest];
  }
  const providerOptions = () => unique([...PROVIDERS, ...allRecords().map(r => r.provider)]);
  const insurerOptions = () => {
    const fromPatients = allPatients().map(p => (p.insurance && p.insurance.provider) || p.insuranceProvider);
    const fromInvoices = typeof invoices !== 'undefined' && Array.isArray(invoices) ? invoices.map(x => x && x.payer).filter(x => x && !/self/i.test(x)) : [];
    return unique([...BASE_INSURERS, ...fromPatients, ...fromInvoices, ...allRecords().map(r => r.insurance)]).sort((a, b) => a.localeCompare(b));
  };
  const facilityOptions = () => unique([...FACILITIES, ...allRecords().map(r => r.facility || r.referredTo)]).sort((a, b) => a.localeCompare(b));

  /* ---------- code checks ---------- */
  const ICD11_STEM = /^[0-9A-HJ-NP-Z][A-HJ-NP-Z][0-9][0-9A-HJ-NP-Z](\.[0-9A-HJ-NP-Z]{1,2})?$/;
  function validIcd11(code){
    const parts = String(code).toUpperCase().split(/[&/]/);
    return parts.every((part, i) => ICD11_STEM.test(part) || (i > 0 && /^X[0-9A-Z]{2,6}$/.test(part)));
  }
  const looksIcd10 = code => /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/i.test(String(code));
  const validCpt = code => /^(\d{4}[0-9FTU]|[A-V]\d{4})(-[0-9A-Z]{2})*$/i.test(String(code));
  function nextNumber(type){
    const y = new Date().getFullYear(), prefix = `${T[type].prefix}-${y}-`;
    const max = Math.max(0, ...store[type].map(r => String(r.number || '').startsWith(prefix) ? Number(String(r.number).slice(prefix.length)) || 0 : 0));
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }
  function nextPaRef(){
    const y = new Date().getFullYear(), prefix = `PA-${y}-`;
    const max = Math.max(100, ...store.servicePAs.map(r => String(r.paRef || '').startsWith(prefix) ? Number(String(r.paRef).slice(prefix.length)) || 0 : 0));
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }

  /* ---------- page, sidebar item and dialog shell ---------- */
  const navAnchor = document.querySelector('.nav-item[data-page="prescriptions"]');
  if (navAnchor && !document.querySelector('.nav-item[data-page="referrals"]')) {
    navAnchor.insertAdjacentHTML('afterend', '<button class="nav-item" data-page="referrals"><span>⇄</span>Referrals / Orders</button>');
    navAnchor.nextElementSibling.addEventListener('click', () => page('referrals'));
  }
  const contentEl = document.querySelector('.content');
  contentEl.insertAdjacentHTML('beforeend', `<div class="page" id="referrals">
    <div class="page-intro"><div><p class="eyebrow teal">CARE COORDINATION</p><h1>Referrals / Orders</h1><p>Track specialist referrals, provider orders and service prior authorizations.</p></div><button class="primary" type="button" id="roNew">+ New Referral</button></div>
    <div class="erx-subtabs ro-tabs" id="roTabs" role="tablist" aria-label="Referrals and orders sections"></div>
    <section class="card ro-panel" role="tabpanel" aria-labelledby="roPanelTitle">
      <div class="ro-panel-head"><h3 id="roPanelTitle"></h3><p id="roPanelBlurb"></p></div>
      <div class="ro-filters" id="roFilters"></div>
      <div class="ro-table" id="roTable"></div>
    </section>
    <p class="ro-sim-note">Simulated cases for student practice. Real insurance requirements vary by plan and service.</p>
  </div>`);
  document.body.insertAdjacentHTML('beforeend', `<div id="roModal" class="modal hidden ro-modal" role="dialog" aria-modal="true" aria-labelledby="roModalTitle">
    <div class="modal-box ro-box" id="roBox">
      <button type="button" class="ro-x" id="roX" aria-label="Close">×</button>
      <div class="ro-box-head"><p class="eyebrow teal" id="roModalEyebrow"></p><h2 id="roModalTitle"></h2><p class="ro-sub" id="roModalSub"></p></div>
      <form id="roForm" novalidate><div id="roFormBody"></div>
        <div class="ro-actions"><button type="button" class="filter" id="roClose">Close</button><button type="submit" class="primary" id="roSubmit">Save changes</button></div>
      </form>
    </div></div>`);

  const basePage = page;
  page = function(id){
    basePage(id);
    if (id === 'referrals') {
      const title = document.getElementById('pageTitle'); if (title) title.textContent = 'Referrals / Orders';
      renderAll();
    }
  };

  /* ---------- list view ---------- */
  function renderAll(){
    document.getElementById('roNew').textContent = `+ ${T[state.tab].newBtn}`;
    document.getElementById('roPanelTitle').textContent = T[state.tab].tab;
    document.getElementById('roPanelBlurb').textContent = T[state.tab].blurb;
    renderTabs(); renderFilters(); renderTable();
  }
  function renderList(){ renderTabs(); renderTable(); }
  function renderTabs(){
    const el = document.getElementById('roTabs');
    el.innerHTML = ORDER.map(k => {
      const open = store[k].filter(r => !CLOSED.has(r.status)).length;
      return `<button type="button" role="tab" id="roTab-${k}" data-ro-tab="${k}" aria-selected="${k === state.tab}" class="${k === state.tab ? 'active' : ''}">${esc(T[k].tab)} <span class="ro-count">${open} open</span></button>`;
    }).join('');
    el.querySelectorAll('[data-ro-tab]').forEach(b => b.onclick = () => { state.tab = b.dataset.roTab; renderAll(); });
  }
  function extraFilter(type){
    if (type === 'referrals') return {label:'All specialties', values: unique(store.referrals.map(r => r.specialty)).sort()};
    if (type === 'diagnostic') return {label:'All categories', values:['Laboratory','Imaging']};
    if (type === 'servicePAs') return {label:'All insurance', values: unique(store.servicePAs.map(r => r.insurance)).sort()};
    return null;
  }
  function renderFilters(){
    const type = state.tab, f = state.filters[type], extra = extraFilter(type);
    const opt = (v, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`;
    document.getElementById('roFilters').innerHTML = `
      <div class="search"><span aria-hidden="true">⌕</span><input type="search" id="roSearch" placeholder="${esc(T[type].search)}" aria-label="${esc(T[type].search)}" value="${esc(f.q)}"></div>
      <select class="filter" id="roStatus" aria-label="Filter by status"><option value="">All statuses</option>${T[type].statuses.map(s => opt(s, f.status)).join('')}</select>
      ${extra ? `<select class="filter" id="roExtra" aria-label="${esc(extra.label)}"><option value="">${esc(extra.label)}</option>${extra.values.map(v => opt(v, f.extra)).join('')}</select>` : ''}`;
    document.getElementById('roSearch').oninput = e => { f.q = e.target.value; renderTable(); };
    document.getElementById('roStatus').onchange = e => { f.status = e.target.value; renderTable(); };
    const ex = document.getElementById('roExtra'); if (ex) ex.onchange = e => { f.extra = e.target.value; renderTable(); };
  }
  const pill = status => `<span class="ro-pill" data-tone="${TONE[status] || 'gray'}">${esc(status || 'Draft')}</span>`;
  const cell = (label, html, cls = '') => `<span class="${cls}" data-label="${esc(label)}">${html}</span>`;
  function paLine(r){
    if (!r.authRequired) return '';
    const pa = r.paId ? findRec('servicePAs', r.paId) : null;
    return pa ? `<small class="ro-pa-line">PA: ${esc(pa.status)}</small>` : '<small class="ro-pa-line ro-warn">PA needed, not started</small>';
  }
  function followUpCell(r){
    if (!r.followUp || CLOSED.has(r.status) || r.status === 'Draft') return r.followUp && r.status === 'Draft' ? esc(fmtDate(r.followUp)) : '—';
    const t = todayIso();
    const tag = r.followUp < t ? ' <span class="ro-due" data-due="overdue">Overdue</span>' : r.followUp === t ? ' <span class="ro-due" data-due="today">Today</span>' : '';
    return `${esc(fmtDate(r.followUp))}${tag}`;
  }
  const HEADS = {
    referrals: ['Patient','Specialty','Referred to','Referring provider','Referral date','Status','Assigned to',''],
    diagnostic: ['Patient','Diagnostic test','Ordering provider','Order date','Priority','Status','Assigned to',''],
    procedures: ['Patient','Procedure','Ordering provider','Facility','Order date','Status','Assigned to',''],
    servicePAs: ['Patient','Service / procedure','Insurance','PA reference #','Status','Date submitted','Next follow-up','Assigned to','']
  };
  function rowCells(type, r){
    const who = cell('Patient', `<b>${esc(r.patient)}</b><small>${esc(r.number)}</small>`, 'ro-cell-main');
    const status = cell('Status', `${pill(r.status)}${type === 'servicePAs' ? '' : paLine(r)}`, 'ro-cell-status');
    const assigned = cell('Assigned to', esc(r.assignedTo || '—'));
    if (type === 'referrals') return [who, cell('Specialty', esc(r.specialty)), cell('Referred to', esc(r.referredTo)), cell('Referring provider', esc(r.provider)), cell('Referral date', esc(fmtDate(r.date))), status, assigned];
    if (type === 'diagnostic') return [who, cell('Diagnostic test', `${esc(r.test)}<small>${esc(r.category)}</small>`), cell('Ordering provider', esc(r.provider)), cell('Order date', esc(fmtDate(r.date))), cell('Priority', `<span class="ro-prio" data-prio="${esc(r.priority)}">${esc(r.priority)}</span>`), status, assigned];
    if (type === 'procedures') return [who, cell('Procedure', esc(r.procedure)), cell('Ordering provider', esc(r.provider)), cell('Facility', esc(r.facility)), cell('Order date', esc(fmtDate(r.date))), status, assigned];
    const stype = (SERVICE_TYPES.find(s => s[0] === r.serviceType) || [, r.serviceType])[1];
    return [who, cell('Service', `${esc(r.service)}<small>${esc(stype || '')}</small>`), cell('Insurance', esc(r.insurance)), cell('PA reference #', r.paRef ? esc(r.paRef) : '<span class="ro-muted">Not submitted</span>'), status,
      cell('Date submitted', r.submitted ? esc(fmtDate(r.submitted)) : '—'), cell('Next follow-up', followUpCell(r)), assigned];
  }
  function sortKey(type, r){ return type === 'servicePAs' ? (r.submitted || (r.createdAt || '').slice(0, 10)) : (r.date || ''); }
  function renderTable(){
    const type = state.tab, f = state.filters[type], q = f.q.trim().toLowerCase();
    const rows = store[type].filter(r => {
      if (f.status && r.status !== f.status) return false;
      if (f.extra && (type === 'referrals' ? r.specialty : type === 'diagnostic' ? r.category : r.insurance) !== f.extra) return false;
      if (!q) return true;
      return [r.patient, r.number, mainOf(type, r), r.provider, r.facility, r.referredTo, r.paRef, r.insurance, r.assignedTo, r.authNumber, r.category]
        .some(v => String(v || '').toLowerCase().includes(q));
    }).sort((a, b) => sortKey(type, b).localeCompare(sortKey(type, a)) || String(b.number).localeCompare(String(a.number)));
    const el = document.getElementById('roTable');
    if (!rows.length) {
      const filtered = f.q || f.status || f.extra;
      el.innerHTML = `<div class="ro-empty"><p>${filtered ? `No ${esc(T[type].tab.toLowerCase())} match these filters.` : `No ${esc(T[type].tab.toLowerCase())} yet.`}</p>${filtered ? '<button type="button" class="filter" id="roClear">Clear filters</button>' : ''}</div>`;
      const c = document.getElementById('roClear'); if (c) c.onclick = () => { state.filters[type] = {q:'', status:'', extra:''}; renderFilters(); renderTable(); };
      return;
    }
    el.innerHTML = `<div class="ro-head ro-cols-${type}" role="row">${HEADS[type].map(h => `<span role="columnheader">${esc(h)}</span>`).join('')}</div>`
      + rows.map(r => `<div class="ro-row ro-cols-${type}" role="row" data-ro-row="${esc(r.id)}">${rowCells(type, r).join('')}<span class="ro-cell-action"><button type="button" class="ro-review" data-ro-open="${esc(r.id)}" aria-label="Review ${esc(r.number)} for ${esc(r.patient)}">Review <span aria-hidden="true">→</span></button></span></div>`).join('');
    el.querySelectorAll('[data-ro-row]').forEach(row => row.onclick = e => { if (!e.target.closest('button')) openForm(type, row.dataset.roRow); });
    el.querySelectorAll('[data-ro-open]').forEach(b => b.onclick = () => openForm(type, b.dataset.roOpen));
  }
  document.getElementById('roNew').onclick = () => openForm(state.tab, null);

  /* ---------- dialog: new + review forms ---------- */

  function newDraft(type, opts){
    const d = {status: T[type].defaultStatus, assignedTo: myName(), insurance:'', memberId:''};
    if (type !== 'servicePAs') Object.assign(d, {priority:'Routine', date: todayIso(), authRequired:false});
    if (type === 'diagnostic') d.category = 'Laboratory';
    if (type === 'servicePAs') Object.assign(d, {method:'Portal', serviceType:''});
    if (opts.fromSource) { const src = findRec(opts.fromSource.type, opts.fromSource.id); if (src) applySource(d, opts.fromSource.type, src); }
    return d;
  }
  function applySource(d, srcType, src){
    d.link = {type: srcType, id: src.id};
    d.patientId = src.patientId; d.patient = src.patient;
    d.serviceType = srcType === 'referrals' ? 'Specialist' : srcType === 'diagnostic' ? 'Diagnostic' : 'Procedure';
    d.service = srcType === 'referrals' ? `${src.specialty} Consultation` : mainOf(srcType, src);
    d.provider = src.provider; d.facility = src.referredTo || src.facility || d.facility || '';
    d.diagnosis = src.diagnosis; d.icd11 = src.icd11; d.cpt = src.cpt || d.cpt || '';
    d.insurance = src.insurance || d.insurance || ''; d.memberId = src.memberId || d.memberId || '';
  }
  function lockedSet(){
    const {type, mode, draft} = ctx, s = new Set(), rec = ctx.id ? findRec(type, ctx.id) : null;
    ctx.linkLocked = new Set();
    if (mode === 'review' && rec && rec.status !== 'Draft' && !isAdmin()) T[type].clinical.forEach(f => s.add(f));
    if (type === 'servicePAs' && draft.link) {
      const add = f => { if (!s.has(f)) ctx.linkLocked.add(f); s.add(f); };
      ['patient','serviceType','service','provider','diagnosis','icd11'].forEach(add);
      const src = findRec(draft.link.type, draft.link.id);
      if (src && src.cpt) add('cpt');
      if (src && (src.referredTo || src.facility)) add('facility');
    }
    if (type !== 'servicePAs' && mode === 'review' && draft.paId) s.add('patient');
    return s;
  }

  function openForm(type, id, opts = {}){
    const rec = id ? findRec(type, id) : null;
    if (id && !rec) { toast('This record is no longer available. The list has been refreshed.'); renderList(); return; }
    const opener = opts.opener || (ctx ? ctx.opener : document.activeElement);
    ctx = {type, mode: rec ? 'review' : 'new', id: rec ? rec.id : null, original: rec ? JSON.parse(JSON.stringify(rec)) : null,
      draft: rec ? JSON.parse(JSON.stringify(rec)) : newDraft(type, opts), fromSource: opts.fromSource || null, opener, defs: [], locked: new Set()};
    const modal = document.getElementById('roModal');
    modal.classList.remove('hidden'); document.body.classList.add('ro-modal-open');
    renderModal(false);
    ctx.baseline = serializeForm();
    // New forms start at the first field; review screens start at the title so the whole record is read top-down.
    const first = ctx.mode === 'new' && document.querySelector('#roForm select:not([disabled]), #roForm input:not([readonly]):not([type=hidden]):not([type=radio]), #roForm textarea:not([readonly])');
    if (first) first.focus(); else { const t = document.getElementById('roModalTitle'); t.setAttribute('tabindex', '-1'); t.focus(); }
    document.getElementById('roBox').scrollTop = 0;
  }

  function closeModal(force = false){
    if (!ctx) return;
    if (!force && serializeForm() !== ctx.baseline && !window.confirm('Discard your unsaved changes?')) return;
    const opener = ctx.opener; ctx = null;
    document.getElementById('roModal').classList.add('hidden'); document.body.classList.remove('ro-modal-open');
    renderList();
    if (opener && document.body.contains(opener)) opener.focus();
  }
  document.getElementById('roX').onclick = () => closeModal();
  document.getElementById('roClose').onclick = () => closeModal();
  document.getElementById('roModal').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key !== 'Tab') return;
    const items = [...document.querySelectorAll('#roBox button:not([disabled]), #roBox input:not([disabled]):not([type=hidden]), #roBox select:not([disabled]), #roBox textarea:not([disabled])')].filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  function serializeForm(){
    const form = document.getElementById('roForm');
    return form ? JSON.stringify([...new FormData(form).entries()]) : '';
  }

  /* field rendering */
  function options(list, current){
    return list.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(current ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
  }
  function fld(def){
    ctx.defs.push(def);
    const d = ctx.draft, locked = ctx.locked.has(def.name), id = `ro-f-${def.name}`;
    const v = def.value !== undefined ? def.value : (d[def.name] ?? '');
    const req = def.required && !locked;
    const star = req ? ' <span class="ro-req" aria-hidden="true">*</span>' : '';
    const tag = locked ? ' <small class="ro-locked-tag">Locked</small>' : '';
    const hint = def.hint ? `<small class="ro-hint" id="${id}-hint">${esc(def.hint)}</small>` : '';
    const describedBy = def.hint ? ` aria-describedby="${id}-hint"` : '';
    const cls = def.full ? 'ro-field ro-full' : 'ro-field';
    if (def.kind === 'radio') {
      const radios = def.options.map(([val, lab]) => `<label class="ro-radio"><input type="radio" name="${def.name}" value="${esc(val)}" ${String(val) === String(v) ? 'checked' : ''} ${locked ? 'disabled' : ''} ${req ? 'required' : ''}> ${esc(lab)}</label>`).join('');
      return `<div class="${cls}" role="radiogroup" aria-labelledby="${id}-l"${describedBy}><span class="ro-label" id="${id}-l">${esc(def.label)}${star}${tag}</span><div class="ro-radio-row">${radios}</div>${hint}</div>`;
    }
    let control;
    if (def.kind === 'display') control = `<input id="${id}" value="${esc(v)}" readonly class="ro-display" tabindex="-1">`;
    else if (locked) control = def.kind === 'textarea'
      ? `<textarea id="${id}" readonly class="ro-locked" aria-readonly="true" rows="3">${esc(def.show ? def.show(v) : v)}</textarea>`
      : `<input id="${id}" value="${esc(def.show ? def.show(v) : (def.kind === 'date' ? fmtDate(v) : v))}" readonly class="ro-locked" aria-readonly="true">`;
    else if (def.kind === 'select') {
      const has = def.options.some(o => String(Array.isArray(o) ? o[0] : o) === String(v));
      if (v && !has && def.name !== 'patient' && def.name !== 'link') def.options = [...def.options, [v, v]];
      control = `<select id="${id}" name="${def.name}"${req ? ' required' : ''}${describedBy}>${def.placeholder !== undefined ? `<option value="">${esc(def.placeholder)}</option>` : ''}${options(def.options, v)}</select>`;
    }
    else if (def.kind === 'textarea') control = `<textarea id="${id}" name="${def.name}" rows="${def.rows || 3}" maxlength="${def.max || 2000}"${req ? ' required' : ''}${describedBy} placeholder="${esc(def.placeholder || '')}">${esc(v)}</textarea>`;
    else if (def.kind === 'date') control = `<input id="${id}" type="date" name="${def.name}" value="${esc(v)}"${req ? ' required' : ''}${describedBy}>`;
    else control = `<input id="${id}" type="text" name="${def.name}" value="${esc(v)}" maxlength="${def.max || 160}"${def.list ? ` list="${def.list}"` : ''}${req ? ' required' : ''}${describedBy} placeholder="${esc(def.placeholder || '')}" autocomplete="off"${def.code ? ' spellcheck="false" autocapitalize="characters"' : ''}>`;
    return `<label class="${cls}" for="${id}"><span class="ro-label">${esc(def.label)}${star}${tag}</span>${control}${hint}</label>`;
  }
  let stepNo = 0;
  const sec = (title, inner, cls = '') => `<section class="ro-section ${cls}"><h3 class="ro-section-title"><span class="ro-step" aria-hidden="true">${++stepNo}</span>${esc(title)}</h3>${inner}</section>`;
  const grid = (...parts) => `<div class="ro-grid">${parts.join('')}</div>`;
  const infoBox = (title, text) => `<div class="ro-info"><b>${esc(title)}</b><p>${esc(text)}</p></div>`;

  function patientOptions(){
    const list = [...allPatients()].sort((a, b) => String(a.n).localeCompare(String(b.n))).map(p => [p.id, `${p.n}${p.mrn ? ` · ${p.mrn}` : ''}`]);
    if (ctx.draft.patientId && !list.some(o => String(o[0]) === String(ctx.draft.patientId))) list.unshift([ctx.draft.patientId, ctx.draft.patient || 'Unknown patient']);
    return list;
  }
  function patientFields(){
    const p = findPatient(ctx.draft.patientId, ctx.draft.patient);
    return [
      fld({name:'patient', label:'Patient', kind:'select', options: patientOptions(), value: ctx.draft.patientId || '', required:true, placeholder:'Select patient', show: () => ctx.draft.patient}),
      fld({name:'dob', label:'Date of birth', kind:'display', value: p ? (p.dob ? (fmtDate(p.dob) || p.dob) : 'Not on file') : '—', hint: p && !p.dob ? "Add it in the patient's record." : 'From the patient record.'})
    ];
  }
  function lockNote(){
    const rec = ctx.id ? findRec(ctx.type, ctx.id) : null;
    if (ctx.mode === 'new') return ctx.type === 'servicePAs' ? '' : '<p class="ro-note-line">Enter the order exactly as the provider wrote it. These details lock once the record leaves Draft.</p>';
    if (!rec || rec.status === 'Draft') return '';
    return isAdmin()
      ? '<p class="ro-note-line ro-admin-line">You are an administrator, so these provider details are editable. Any correction is written to the activity history.</p>'
      : '<p class="ro-note-line ro-lock-line">Provider order details are locked. Only an administrator can correct them.</p>';
  }

  function detailSections(){
    const t = ctx.type, codeHint = 'ICD-11, for example ME84.2';
    if (t === 'referrals') return [sec('Referral details', grid(
      fld({name:'provider', label:'Referring provider', kind:'select', options: providerOptions(), required:true, placeholder:'Select provider'}),
      fld({name:'specialty', label:'Specialty', kind:'select', options: SPECIALTIES, required:true, placeholder:'Select specialty'}),
      fld({name:'referredTo', label:'Referred to (specialist or facility)', kind:'text', list:'roFacilities', required:true, placeholder:'e.g. Skin & Laser Clinic'}),
      fld({name:'priority', label:'Priority', kind:'select', options:['Routine','Urgent'], required:true}),
      fld({name:'reason', label:'Reason for referral', kind:'textarea', required:true, full:true, placeholder:"As written in the provider's referral"}),
      fld({name:'diagnosis', label:'Diagnosis', kind:'text', required:true, placeholder:'e.g. Atopic eczema'}),
      fld({name:'icd11', label:'ICD-11 code', kind:'text', required:true, code:true, placeholder: codeHint, max:40}),
      fld({name:'date', label:'Referral date', kind:'date', required:true})
    ) + lockNote())];
    if (t === 'diagnostic') return [
      sec('Order details', grid(
        fld({name:'provider', label:'Ordering provider', kind:'select', options: providerOptions(), required:true, placeholder:'Select provider'}),
        fld({name:'category', label:'Order category', kind:'radio', options:[['Laboratory','Laboratory'],['Imaging','Imaging']], required:true}),
        fld({name:'test', label:'Diagnostic test / order name', kind:'text', list:'roDxTests', required:true, full:true, placeholder:'e.g. CBC with Platelet Count, MRI Lumbar Spine'}),
        fld({name:'reason', label:'Reason for order', kind:'textarea', required:true, full:true, placeholder:"As written in the provider's order"}),
        fld({name:'diagnosis', label:'Diagnosis', kind:'text', required:true}),
        fld({name:'icd11', label:'ICD-11 code', kind:'text', required:true, code:true, placeholder: codeHint, max:40}),
        fld({name:'cpt', label:'CPT / HCPCS code (if applicable)', kind:'text', code:true, placeholder:'e.g. 72148', max:20}),
        fld({name:'priority', label:'Priority', kind:'select', options:['Routine','Urgent','STAT'], required:true}),
        fld({name:'date', label:'Order date', kind:'date', required:true})
      ) + lockNote()),
      sec('Facility / laboratory', grid(
        fld({name:'facility', label:'Performing laboratory / facility', kind:'text', list:'roFacilities', required:true, placeholder:'e.g. Bay Area Diagnostic Lab'}),
        fld({name:'scheduledDate', label:'Scheduled date (if scheduled)', kind:'date', hint:'Lab orders can be completed without a scheduled appointment.'})
      ))
    ];
    return [
      sec('Procedure details', grid(
        fld({name:'provider', label:'Ordering provider', kind:'select', options: providerOptions(), required:true, placeholder:'Select provider'}),
        fld({name:'priority', label:'Priority', kind:'select', options:['Routine','Urgent'], required:true}),
        fld({name:'procedure', label:'Procedure name', kind:'text', list:'roProcedures', required:true, full:true, placeholder:'e.g. Colonoscopy'}),
        fld({name:'diagnosis', label:'Diagnosis / indication', kind:'text', required:true, full:true}),
        fld({name:'icd11', label:'ICD-11 code', kind:'text', required:true, code:true, placeholder: codeHint, max:40}),
        fld({name:'cpt', label:'CPT / HCPCS code (if applicable)', kind:'text', code:true, placeholder:'e.g. 45378', max:20}),
        fld({name:'date', label:'Order date', kind:'date', required:true})
      ) + lockNote()),
      sec('Performing provider / facility', grid(
        fld({name:'facility', label:'Performing provider / facility', kind:'text', list:'roFacilities', required:true, placeholder:'e.g. Harbor GI Endoscopy Center'}),
        fld({name:'procedureDate', label:'Procedure date (if scheduled)', kind:'date'})
      ))
    ];
  }

  function linkedPaCard(){
    const d = ctx.draft, pa = d.paId ? findRec('servicePAs', d.paId) : null;
    if (pa) {
      const approved = pa.status === 'Approved';
      const reopen = pa.status === 'Denied' || pa.status === 'Cancelled / Closed';
      return `<div class="ro-link-card"><div class="ro-link-top"><span>Service PA <b>${esc(pa.paRef || pa.number)}</b></span>${pill(pa.status)}</div>
        ${approved ? `<dl class="ro-auth"><div><dt>Authorization #</dt><dd>${esc(pa.authNumber || '—')}</dd></div><div><dt>Approved</dt><dd>${esc(fmtDate(pa.approvalDate) || '—')}</dd></div><div><dt>Valid</dt><dd>${pa.effectiveDate || pa.expirationDate ? `${esc(fmtDate(pa.effectiveDate) || '—')} – ${esc(fmtDate(pa.expirationDate) || '—')}` : 'Dates not provided'}</dd></div></dl>` : ''}
        ${pa.status === 'Denied' && pa.denialReason ? `<p class="ro-link-text">Denied: ${esc(pa.denialReason)}</p>` : ''}
        ${!approved && !reopen && pa.followUp ? `<p class="ro-link-text">Next follow-up ${esc(fmtDate(pa.followUp))}</p>` : ''}
        <p class="ro-link-text ro-muted">Order status and PA status are tracked separately.</p>
        <div class="ro-link-actions"><button type="button" class="filter" data-ro-goto="servicePAs:${esc(pa.id)}">Open PA</button>${reopen ? '<button type="button" class="secondary" data-ro-action="create-pa">Start a new Service PA</button>' : ''}</div></div>`;
    }
    const free = store.servicePAs.filter(p => !p.link && (p.patientId === d.patientId || p.patient === d.patient));
    return `<div class="ro-link-card ro-link-empty"><p class="ro-link-text"><b>No Service PA linked yet.</b> Create one from this ${ctx.type === 'referrals' ? 'referral' : 'order'}, or link one already started for this patient.</p>
      <div class="ro-link-actions"><button type="button" class="secondary" data-ro-action="create-pa">Create Service PA</button></div>
      ${free.length ? grid(fld({name:'linkPa', label:'Or link an existing Service PA', kind:'select', options: free.map(p => [p.id, `${p.paRef || p.number} · ${p.service} (${p.status})`]), placeholder:'Choose a Service PA', full:true})) : ''}</div>`;
  }
  function authSection(){
    const d = ctx.draft, linked = Boolean(d.paId && findRec('servicePAs', d.paId));
    if (linked) ctx.locked.add('authRequired');
    const html = grid(
      fld({name:'insurance', label:'Insurance', kind:'text', list:'roInsurers', required: Boolean(d.authRequired), placeholder:'e.g. UnitedCare'}),
      fld({name:'memberId', label:'Member ID', kind:'text', max:40}),
      fld({name:'authRequired', label:'Insurance prior authorization required?', kind:'radio', options:[['yes','Yes'],['no','No']], value: d.authRequired ? 'yes' : 'no', full:true,
        hint: linked ? 'Linked to a Service PA.' : ctx.type === 'referrals' ? 'A referral and a prior authorization are different things. Not every referral needs one.' : 'Check the plan’s requirements for this service.'})
    );
    let extra = '';
    if (d.authRequired && ctx.mode === 'review') extra = linkedPaCard();
    else if (d.authRequired && ctx.mode === 'new') extra = '<p class="ro-note-line">After you create this record, its review screen lets you start a linked Service PA.</p>';
    return sec('Insurance / authorization', html + extra);
  }
  function statusSection(title){
    return sec(title, grid(
      fld({name:'status', label:'Status', kind:'select', options: T[ctx.type].statuses, required:true}),
      fld({name:'assignedTo', label:'Assigned to', kind:'select', options: staffOptions(), required:true})
    ));
  }
  function notesSection(){
    const d = ctx.draft;
    if (ctx.mode === 'new') return sec('Notes', grid(fld({name:'newNote', label:'Notes (optional)', kind:'textarea', full:true, rows:2, placeholder:'Saved as the first follow-up note, with your name and the time.'})));
    const rec = findRec(ctx.type, ctx.id) || {notes:[]};
    const list = rec.notes.length ? `<ol class="ro-notes">${rec.notes.map(n => `<li><div class="ro-note-meta"><b>${esc(n.by)}</b><span>${esc(fmtStamp(n.at))}</span></div><p>${esc(n.text)}</p></li>`).join('')}</ol>` : '<p class="ro-muted ro-small">No follow-up notes yet.</p>';
    const example = ctx.type === 'servicePAs' ? 'e.g. Called UnitedCare about the pending MRI authorization. Still under review; follow-up set for Oct 30.' : 'e.g. Faxed the referral to the specialist office and confirmed they received it.';
    return sec('Follow-up notes', `<div class="ro-note-add">${fld({name:'newNote', label:'Add a follow-up note', kind:'textarea', rows:2, placeholder: example, value: d.newNote || ''})}<button type="button" class="secondary" data-ro-action="add-note">Add note</button></div>${list}`);
  }
  function historySection(){
    const rec = findRec(ctx.type, ctx.id) || {history:[]};
    return sec('Activity history', rec.history.length ? `<ol class="ro-history">${rec.history.map(h => `<li><span class="ro-hist-when">${esc(fmtStamp(h.at))}</span><span>${esc(h.text)}${h.by ? ` <span class="ro-muted">— ${esc(h.by)}</span>` : ''}</span></li>`).join('')}</ol>` : '<p class="ro-muted ro-small">No activity yet.</p>');
  }

  /* Service PA parts */
  function linkOptionsFor(d){
    if (!d.patientId && !d.patient) return [];
    return ORDER_TYPES.flatMap(t => store[t].filter(r => (r.patientId === d.patientId || r.patient === d.patient) && r.status !== 'Cancelled')
      .filter(r => { if (!r.paId || r.paId === ctx.id) return true; const pa = findRec('servicePAs', r.paId); return !pa || pa.status === 'Denied' || pa.status === 'Cancelled / Closed'; })
      .map(r => [`${t}:${r.id}`, `${T[t].one} ${r.number} · ${mainOf(t, r)} (${r.status})`]));
  }
  function paServiceSection(){
    const d = ctx.draft;
    let linkHtml;
    const src = d.link ? findRec(d.link.type, d.link.id) : null;
    if (d.link && (ctx.mode === 'review' && ctx.original && ctx.original.link || ctx.fromSource)) {
      linkHtml = `<div class="ro-link-card ro-full"><div class="ro-link-top"><span>Linked to ${esc(T[d.link.type].one.toLowerCase())} <b>${esc(src ? src.number : 'not found')}</b>${src ? ` · ${esc(mainOf(d.link.type, src))}` : ''}</span>${src ? pill(src.status) : ''}</div>
        <p class="ro-link-text ro-muted">Service details come from the ${d.link.type === 'referrals' ? 'referral' : 'order'}. Approving this PA does not complete it.</p>
        ${src ? `<div class="ro-link-actions"><button type="button" class="filter" data-ro-goto="${esc(d.link.type)}:${esc(src.id)}">Open ${d.link.type === 'referrals' ? 'referral' : 'order'}</button></div>` : ''}</div>`;
    } else {
      const opts = linkOptionsFor(d);
      linkHtml = fld({name:'link', label:'Link to an existing referral or order (optional)', kind:'select', options: opts, value: d.link ? `${d.link.type}:${d.link.id}` : '', full:true,
        placeholder: (d.patientId || d.patient) ? (opts.length ? 'Not linked' : 'No referrals or orders for this patient') : 'Select a patient first',
        hint:'Linking fills in the service details from the referral or order.'});
    }
    return sec('Patient & service information', grid(
      ...patientFields(), linkHtml,
      fld({name:'serviceType', label:'Service type', kind:'select', options: SERVICE_TYPES, required:true, placeholder:'Select type', show: v => (SERVICE_TYPES.find(s => s[0] === v) || [, v])[1]}),
      fld({name:'service', label:'Requested service / procedure', kind:'text', required:true, list:'roServices', placeholder:'e.g. MRI Lumbar Spine'}),
      fld({name:'provider', label:'Ordering / referring provider', kind:'select', options: providerOptions(), required:true, placeholder:'Select provider'}),
      fld({name:'facility', label:'Facility / specialist (if applicable)', kind:'text', list:'roFacilities'}),
      fld({name:'diagnosis', label:'Diagnosis', kind:'text', required:true}),
      fld({name:'icd11', label:'ICD-11 code', kind:'text', required:true, code:true, placeholder:'ICD-11, for example ME84.2', max:40}),
      fld({name:'cpt', label:'CPT / HCPCS code (if applicable)', kind:'text', code:true, placeholder:'e.g. 72148', max:20})
    ) + (ctx.mode === 'review' && !d.link ? lockNote() : ''));
  }
  const paInsuranceSection = () => sec('Insurance information', grid(
    fld({name:'insurance', label:'Insurance company', kind:'text', list:'roInsurers', required:true, placeholder:'e.g. UnitedCare'}),
    fld({name:'memberId', label:'Insurance member ID', kind:'text', max:40})
  ));
  function paStatusSection(title){
    return sec(title, grid(
      fld({name:'status', label:'PA status', kind:'select', options: T.servicePAs.statuses, required:true}),
      fld({name:'followUp', label:'Next follow-up date', kind:'date'}),
      fld({name:'assignedTo', label:'Assigned to', kind:'select', options: staffOptions(), required:true}),
      fld({name:'method', label:'Submission method', kind:'select', options: METHODS, required:true}),
      fld({name:'paRef', label:'PA reference #', kind:'text', code:true, max:40, placeholder:'Assigned on submission if left blank'}),
      fld({name:'submitted', label:'Date submitted', kind:'date'})
    ));
  }
  function responseSection(){
    const st = ctx.draft.status;
    let inner;
    if (st === 'Draft') inner = infoBox('Not submitted yet', 'Insurance response fields appear after the PA is submitted. Set the status to Pending once you send it.');
    else if (st === 'Pending') inner = infoBox('No decision yet', 'Follow up with the insurance on or before the next follow-up date.') + grid(
      fld({name:'pendingCurrent', label:'Current status from insurance', kind:'text', full:true, placeholder:'e.g. In clinical review'}),
      fld({name:'pendingRemarks', label:'Insurance remarks', kind:'textarea', full:true, rows:2}));
    else if (st === 'Additional Info Needed') inner = grid(
      fld({name:'infoReceived', label:'Date request received', kind:'date', required:true}),
      fld({name:'infoDeadline', label:'Response deadline (if provided)', kind:'date'}),
      fld({name:'infoRequested', label:'Information / documents requested', kind:'textarea', required:true, full:true, rows:2}),
      fld({name:'infoAction', label:'Action taken', kind:'textarea', full:true, rows:2}));
    else if (st === 'Approved') inner = grid(
      fld({name:'authNumber', label:'Authorization number', kind:'text', required:true, code:true, max:40}),
      fld({name:'approvalDate', label:'Approval date', kind:'date', required:true}),
      fld({name:'effectiveDate', label:'Effective date', kind:'date'}),
      fld({name:'expirationDate', label:'Expiration date', kind:'date'}),
      fld({name:'approvedService', label:'Approved service / procedure', kind:'text', full:true, max:200, placeholder:'As written in the approval, including units if given'}));
    else if (st === 'Denied') inner = grid(
      fld({name:'denialDate', label:'Denial date', kind:'date', required:true}),
      fld({name:'denialReason', label:'Denial reason', kind:'textarea', required:true, full:true, rows:2}),
      fld({name:'appealInstructions', label:'Appeal / reconsideration instructions', kind:'textarea', full:true, rows:2}));
    else inner = infoBox('Closed', 'No insurance response is tracked for cancelled or closed requests.');
    return sec('Insurance response', inner);
  }

  function datalists(){
    return `<datalist id="roFacilities">${facilityOptions().map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      <datalist id="roInsurers">${insurerOptions().map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      <datalist id="roDxTests">${DX_TESTS.map(([v, , l]) => `<option value="${esc(v)}" label="${esc(l)}">`).join('')}</datalist>
      <datalist id="roProcedures">${PROCEDURES.map(([v, l]) => `<option value="${esc(v)}" label="${esc(l)}">`).join('')}</datalist>
      <datalist id="roServices">${unique([...DX_TESTS.map(x => x[0]), ...PROCEDURES.map(x => x[0]), ...SPECIALTIES.filter(s => s !== 'Other').map(s => `${s} Consultation`)]).map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
  }

  function renderModal(keepScroll){
    const box = document.getElementById('roBox'), scroll = keepScroll ? box.scrollTop : 0;
    const focusName = keepScroll && document.activeElement && document.activeElement.name;
    ctx.defs = []; ctx.locked = lockedSet(); stepNo = 0;
    const {type, mode, draft} = ctx, one = T[type].one, rec = ctx.id ? findRec(type, ctx.id) : null;
    document.getElementById('roModalEyebrow').textContent = mode === 'new' ? 'NEW RECORD' : `${one.toUpperCase()} · ${rec.number}`;
    document.getElementById('roModalTitle').textContent = mode === 'new' ? `New ${one.toLowerCase()}` : `${one} — review`;
    document.getElementById('roModalSub').textContent = mode === 'new'
      ? (type === 'servicePAs' ? 'Create the authorization request. Status starts as Draft until you submit it.' : 'Create the record from the provider’s instructions.')
      : `${draft.patient} · created by ${rec.createdBy || 'unknown'} on ${fmtDate((rec.createdAt || '').slice(0, 10)) || 'unknown date'}`;
    document.getElementById('roSubmit').textContent = mode === 'new' ? T[type].create : 'Save changes';
    box.classList.toggle('ro-wide', mode === 'review');

    let main, side;
    if (type === 'servicePAs') {
      main = [paServiceSection(), paInsuranceSection()];
      side = mode === 'new' ? [paStatusSection('PA request details'), responseSection(), notesSection()] : [paStatusSection('PA status & submission'), responseSection(), notesSection(), historySection()];
    } else {
      main = [sec('Patient information', grid(...patientFields())), ...detailSections()];
      side = mode === 'new' ? [authSection(), statusSection('Tracking'), notesSection()] : [statusSection('Status & assignment'), authSection(), notesSection(), historySection()];
    }
    document.getElementById('roFormBody').innerHTML = datalists() + (mode === 'review'
      ? `<div class="ro-columns"><div class="ro-col">${main.join('')}</div><div class="ro-col">${side.join('')}</div></div>`
      : main.join('') + side.join(''));
    box.scrollTop = scroll;
    if (focusName) { const el = document.querySelector(`#roForm [name="${focusName}"]`); if (el) el.focus({preventScroll:true}); }
  }

  /* read the visible, unlocked fields back into the draft */
  function collectDraft(){
    const form = document.getElementById('roForm'), fd = new FormData(form), d = ctx.draft;
    ctx.defs.forEach(def => {
      if (def.kind === 'display' || ctx.locked.has(def.name)) return;
      if (def.name === 'link' || def.name === 'linkPa') return;
      const raw = fd.get(def.name);
      if (def.kind === 'radio') { if (raw !== null) d[def.name] = def.name === 'authRequired' ? raw === 'yes' : raw; return; }
      let v = String(raw ?? '').trim();
      if (def.code) v = v.toUpperCase().replace(/\s+/g, '');
      if (def.name === 'patient') { const p = findPatient(v); if (p) { d.patientId = p.id; d.patient = p.n; } else if (!v) { d.patientId = ''; d.patient = ''; } return; }
      d[def.name] = v;
    });
    d.linkPa = String(fd.get('linkPa') || '');
  }

  // Clear a field's custom error as soon as it is edited (checks run again on save).
  document.getElementById('roForm').addEventListener('input', e => { if (e.target.setCustomValidity) e.target.setCustomValidity(''); });
  document.getElementById('roForm').addEventListener('change', e => {
    if (!ctx) return;
    const name = e.target.name;
    if (name === 'test' || name === 'procedure') return autoCategory(e.target);
    if (!['patient','authRequired','link'].includes(name) && !(name === 'status' && ctx.type === 'servicePAs')) return;
    const before = {insurance: ctx.draft.insurance, memberId: ctx.draft.memberId, patientId: ctx.draft.patientId};
    collectDraft();
    const d = ctx.draft;
    if (name === 'patient' && d.patientId !== before.patientId) {
      const ins = patientInsurance(findPatient(d.patientId));
      if (ins.insurance && (!before.insurance || before.insurance === ctx.autoInsurance)) { d.insurance = ins.insurance; d.memberId = ins.memberId || ''; ctx.autoInsurance = ins.insurance; }
      if (ctx.type === 'servicePAs') d.link = null;
    }
    if (name === 'link') {
      const val = e.target.value;
      if (val) { const [t, id] = val.split(':'); const src = findRec(t, id); if (src) applySource(d, t, src); }
      else d.link = null;
    }
    if (name === 'status' && ctx.type === 'servicePAs' && SUBMITTED.has(d.status) && !d.submitted) d.submitted = todayIso();
    renderModal(true);
  });
  function autoCategory(input){
    if (ctx.type !== 'diagnostic' || input.name !== 'test') return;
    const hit = DX_TESTS.find(x => x[0].toLowerCase() === input.value.trim().toLowerCase());
    if (!hit) return;
    const radio = document.querySelector(`#roForm input[name="category"][value="${hit[1]}"]`);
    if (radio && !radio.disabled) radio.checked = true;
  }

  /* ---------- validation ---------- */
  function validate(){
    const form = document.getElementById('roForm'), d = ctx.draft, t = ctx.type;
    form.querySelectorAll('input, select, textarea').forEach(el => el.setCustomValidity && el.setCustomValidity(''));
    const flag = (name, msg) => { const el = form.querySelector(`[name="${name}"]`); if (el) el.setCustomValidity(msg); };
    if (!ctx.locked.has('icd11') && d.icd11 && !validIcd11(d.icd11))
      flag('icd11', looksIcd10(d.icd11) ? `${d.icd11} looks like an ICD-10 code. SynClinic uses ICD-11 codes, for example ME84.2 or BA00.` : 'Enter an ICD-11 code, for example ME84.2, BA00 or 8A80.');
    if (!ctx.locked.has('cpt') && d.cpt && !validCpt(d.cpt)) flag('cpt', 'CPT codes are 5 characters (for example 72148). HCPCS codes are a letter and 4 digits (for example G0121).');
    if ((t === 'diagnostic' || t === 'procedures') && d.status === 'Scheduled') {
      const f = t === 'diagnostic' ? 'scheduledDate' : 'procedureDate';
      if (!d[f]) flag(f, 'Add the scheduled date, or choose a different status.');
    }
    if (t === 'servicePAs') {
      if (d.status === 'Approved' && d.effectiveDate && d.expirationDate && d.expirationDate < d.effectiveDate) flag('expirationDate', 'The expiration date must be on or after the effective date.');
      if (!d.patientId && !d.patient) flag('patient', 'Select the patient.');
    }
    return form.reportValidity();
  }

  /* ---------- saving ---------- */
  const pick = (obj, keys) => keys.reduce((o, k) => { if (obj[k] !== undefined) o[k] = obj[k]; return o; }, {});
  function linkHistoryName(t, r){ return `${T[t].one} ${t === 'servicePAs' ? (r.paRef || r.number) : r.number}`; }

  function diffHistory(type, before, after, out){
    const changed = f => !same(before[f], after[f]);
    if (changed('status')) {
      if (type === 'servicePAs') {
        if (before.status === 'Draft' && SUBMITTED.has(after.status)) out.push(`PA submitted via ${after.method}. Reference # ${after.paRef}`);
        responseHistory(after, out);
      }
      out.push(`Status changed from ${before.status} to ${after.status}`);
    } else if (type === 'servicePAs' && ['pendingCurrent','pendingRemarks','infoReceived','infoRequested','infoDeadline','infoAction','authNumber','approvalDate','effectiveDate','expirationDate','approvedService','denialDate','denialReason','appealInstructions'].some(changed)) {
      out.push('Insurance response details updated');
    }
    if (changed('assignedTo')) out.push(`Assigned to ${after.assignedTo}`);
    if (type === 'servicePAs' && changed('followUp') && after.followUp) out.push(`Next follow-up set for ${fmtDate(after.followUp)}`);
    if (type === 'servicePAs' && changed('paRef') && after.paRef && !(before.status === 'Draft' && SUBMITTED.has(after.status))) out.push(`PA reference # recorded: ${after.paRef}`);
    ['scheduledDate','procedureDate'].forEach(f => { if (changed(f)) out.push(after[f] ? `Scheduled for ${fmtDate(after[f])}` : 'Scheduled date cleared'); });
    if (type !== 'servicePAs' && changed('authRequired')) out.push(`Prior authorization marked as ${after.authRequired ? 'required' : 'not required'}`);
    if (changed('referredTo')) out.push(`Referred to changed to ${after.referredTo}`);
    if (type !== 'servicePAs' && changed('facility')) out.push(`Facility changed to ${after.facility}`);
    if (changed('insurance')) out.push(`Insurance updated to ${after.insurance || 'none'}`);
    const corrected = T[type].clinical.filter(f => f !== 'patient' ? changed(f) : changed('patientId'));
    if (corrected.length && before.status !== 'Draft' && isAdmin() && !(ctx && ctx.linkNew)) out.push(`Provider details corrected by administrator: ${corrected.map(f => LABELS[f] || f).join(', ')}`);
  }
  function responseHistory(r, out){
    if (r.status === 'Additional Info Needed') out.push(`Insurance response received: additional information requested${r.infoRequested ? ` (${r.infoRequested})` : ''}`);
    else if (r.status === 'Approved') out.push(`Insurance response received: PA approved. Authorization # ${r.authNumber}${r.effectiveDate && r.expirationDate ? `, valid ${fmtDate(r.effectiveDate)} – ${fmtDate(r.expirationDate)}` : ''}`);
    else if (r.status === 'Denied') out.push(`Insurance response received: PA denied. ${r.denialReason || ''}`.trim());
    else if (r.status === 'Cancelled / Closed') out.push('PA cancelled / closed');
  }
  function addHistory(rec, items, at, by){ items.forEach(text => rec.history.unshift({at, by, text})); }

  function save(){
    collectDraft();
    if (!validate()) return null;
    const type = ctx.type, d = ctx.draft, at = new Date().toISOString(), by = myName(), hist = [];
    let rec;
    const fields = T[type].fields;
    if (ctx.mode === 'new') {
      rec = {...pick(d, fields), id: uid(T[type].prefix), number: nextNumber(type), createdAt: at, createdBy: by, notes: [], history: []};
      if (type === 'servicePAs' && SUBMITTED.has(rec.status)) {
        if (!rec.paRef) rec.paRef = nextPaRef();
        if (!rec.submitted) rec.submitted = todayIso();
      }
      hist.push(`${T[type].one} created${rec.status === 'Draft' ? ' as Draft' : ` (status: ${rec.status})`}`);
      if (type === 'servicePAs' && SUBMITTED.has(rec.status)) { hist.push(`PA submitted via ${rec.method}. Reference # ${rec.paRef}`); responseHistory(rec, hist); }
      store[type].unshift(rec);
    } else {
      rec = findRec(type, ctx.id);
      if (!rec) { toast('This record was removed by someone else, so your changes could not be saved.'); closeModal(true); return null; }
      const before = JSON.parse(JSON.stringify(rec));
      // Only write fields this person changed, so edits made elsewhere since the form opened are kept.
      const linkNew = type === 'servicePAs' && Boolean(d.link) && !ctx.original.link;
      const isLocked = f => { const key = f === 'patientId' ? 'patient' : f; return ctx.locked.has(key) && !(linkNew && (ctx.linkLocked.has(key) || ['insurance','memberId','link'].includes(f))); };
      fields.forEach(f => { if (!isLocked(f) && !same(d[f], ctx.original[f])) rec[f] = d[f]; });
      ctx.linkNew = linkNew;
      if (type === 'servicePAs' && before.status === 'Draft' && SUBMITTED.has(rec.status)) {
        if (!rec.paRef) rec.paRef = nextPaRef();
        if (!rec.submitted) rec.submitted = todayIso();
      }
      diffHistory(type, before, rec, hist);
    }
    if (d.newNote) { rec.notes.unshift({at, by, text: d.newNote}); hist.push('Follow-up note added'); }
    rec.updatedAt = at;
    // links between PAs and referrals / orders (both sides keep their own status)
    if (type === 'servicePAs' && rec.link && (ctx.mode === 'new' || !ctx.original.link)) {
      const src = findRec(rec.link.type, rec.link.id);
      if (src) {
        src.paId = rec.id; src.authRequired = true; src.updatedAt = at;
        addHistory(src, [`Linked to Service PA ${rec.paRef || rec.number}`], at, by);
        hist.unshift(`Linked to ${linkHistoryName(rec.link.type, src)}`);
      }
    }
    if (type !== 'servicePAs' && d.linkPa) {
      const pa = findRec('servicePAs', d.linkPa);
      if (pa && !pa.link) {
        pa.link = {type, id: rec.id}; pa.updatedAt = at; rec.paId = pa.id; rec.authRequired = true;
        addHistory(pa, [`Linked to ${linkHistoryName(type, rec)}`], at, by);
        hist.push(`Linked to Service PA ${pa.paRef || pa.number}`);
      }
    }
    addHistory(rec, hist, at, by);
    d.newNote = '';
    return rec;
  }

  document.getElementById('roForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!ctx) return;
    const wasNew = ctx.mode === 'new', type = ctx.type, fromSource = ctx.fromSource;
    const rec = save(); if (!rec) return;
    const label = wasNew ? `${T[type].one} ${type === 'servicePAs' && rec.paRef ? rec.paRef : rec.number} created` : 'Changes saved';
    if (wasNew && type === 'servicePAs' && rec.link) {
      savedToast(`${label} and linked to ${findRec(rec.link.type, rec.link.id)?.number || 'the order'}`);
      if (fromSource) { const op = ctx.opener; ctx = null; openForm(rec.link.type, rec.link.id, {opener: op}); return; }
    } else savedToast(label);
    if (wasNew && type !== 'servicePAs' && rec.authRequired) { const op = ctx.opener; ctx = null; openForm(type, rec.id, {opener: op}); return; }
    if (state.tab !== type) state.tab = type;
    closeModal(true);
    if (isVisible()) renderAll();
  });

  /* buttons inside the dialog */
  document.getElementById('roFormBody').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn || !ctx) return;
    if (btn.dataset.roAction === 'add-note') return addNote();
    if (btn.dataset.roAction === 'create-pa') {
      const src = {type: ctx.type, id: ctx.id};
      if (serializeForm() !== ctx.baseline) { if (!save()) return; persist(); }
      const op = ctx.opener; ctx = null; openForm('servicePAs', null, {fromSource: src, opener: op});
      return;
    }
    if (btn.dataset.roGoto) {
      const [t, id] = btn.dataset.roGoto.split(':');
      if (serializeForm() !== ctx.baseline) { if (!save()) return; savedToast('Changes saved'); }
      const op = ctx.opener; ctx = null; openForm(t, id, {opener: op});
    }
  });
  function addNote(){
    collectDraft();
    const box = document.querySelector('#roForm [name="newNote"]');
    if (!ctx.draft.newNote) { if (box) { box.setCustomValidity('Write the note first.'); box.reportValidity(); box.setCustomValidity(''); } return; }
    const rec = findRec(ctx.type, ctx.id);
    if (!rec) { toast('This record is no longer available.'); return; }
    const at = new Date().toISOString(), by = myName();
    rec.notes.unshift({at, by, text: ctx.draft.newNote});
    rec.history.unshift({at, by, text: 'Follow-up note added'});
    rec.updatedAt = at;
    ctx.draft.newNote = '';
    savedToast('Follow-up note added');
    renderModal(true);
    const fresh = document.querySelector('#roForm [name="newNote"]'); if (fresh) fresh.focus();
  }

  renderAll();
})();
