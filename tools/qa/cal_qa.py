#!/usr/bin/env python3
"""QA harness for the Calendar tab (Day Book edition) — FULL FIDELITY:
the real panel markup, the real .cal-* CSS, the real page helpers, and the
real JS region are all extracted from admin.html at run time; only the data
layer ($ + sb + state) is instrumented. window.SCENARIO picks the dataset
(fresh | populated | error | edge); window.DB_LOG records every rpc/mutation."""
src = open('/home/user/Blanket/admin.html', encoding='utf-8').read()

i = src.index("const CAL_DAYS = ['Sun'"); j = src.index('async function loadConversion')
region = src[i:j]
hi = src.index('function el(tag, cls, text) {')
hj = src.index('function nowIso() { return new Date().toISOString(); }', hi)
real_helpers = src[hi:hj] + 'function nowIso() { return new Date().toISOString(); }'
assert 'function esc(' in real_helpers, 'esc() missing from admin.html globals'
mi = src.index('<div id="panel-calendar" class="panel">')
mj = src.index('<div id="panel-spend" class="panel">')
real_markup = src[mi:mj]
ci = src.index('  /* Calendar tab')
cj = src.index('@media (max-width:640px){', ci)
cal_css = src[ci:src.index('}', src.index('.cal-sum .dig{ flex-basis:100%', cj)) + 3]
h1 = src[src.index("if ($('cal-save-rules'))"):src.index("if ($('cal-exc-add'))")]
h2 = src[src.index("if ($('cal-exc-add'))"):src.index("$('cv-wkstart')")]

HTML = """<!doctype html><html><head><meta charset="utf-8"><title>cal-qa</title><style>
:root{
  --loden:#26332B; --loden-deep:#171F1A; --wool:#F1ECE2; --brass:#A67C3D; --brass-soft:#C49B5B;
  --hairline:rgba(196,155,91,.35); --hairline-dim:rgba(196,155,91,.18);
  --wool-dim:rgba(241,236,226,.62); --wool-faint:rgba(241,236,226,.38);
  --ink-well:rgba(241,236,226,.04); --danger:#B4564A;
}
*{ box-sizing:border-box; margin:0; padding:0; }
body{ background:var(--loden-deep); color:var(--wool); font-family:system-ui,sans-serif; font-weight:300;
  font-size:15px; line-height:1.55; padding:20px; max-width:1140px; margin:0 auto; }
h2,h3,.cal-date{ font-family:Georgia,serif; font-weight:400; }
.micro{ font-family:ui-monospace,monospace; font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--brass-soft); }
.mono{ font-family:ui-monospace,monospace; }
a{ color:var(--brass-soft); }
input,select{ background:var(--ink-well); border:1px solid var(--hairline-dim); border-radius:2px;
  color:var(--wool); font-size:14px; padding:7px 10px; outline:none; }
input::placeholder{ color:var(--wool-faint); }
.btn{ background:var(--brass); color:#171F1A; border:1px solid var(--brass); border-radius:2px;
  padding:7px 14px; cursor:pointer; font-size:12px; letter-spacing:.06em; }
.btn.ghost{ background:transparent; color:var(--brass-soft); border-color:var(--hairline); }
.info-badge{ display:inline-flex; align-items:center; justify-content:center; width:15px; height:15px;
  border:1px solid var(--hairline); border-radius:50%; font-size:10px; color:var(--brass-soft);
  margin-left:6px; cursor:help; font-style:normal; }
.info-tip{ position:absolute; z-index:400; background:var(--loden); border:1px solid var(--hairline);
  color:var(--wool); font-size:12.5px; line-height:1.5; padding:10px 12px; border-radius:3px; }
.panel{ display:block; }
section.card{ border:1px solid var(--hairline-dim); border-radius:3px; padding:24px 26px 22px;
  margin-bottom:26px; background:rgba(38,51,43,.28); }
section.card > .card-head{ display:flex; align-items:baseline; justify-content:space-between; gap:14px;
  margin-bottom:20px; padding-bottom:12px; border-bottom:1px solid var(--hairline-dim); }
.panel-head{ margin-bottom:10px; } .note{ color:var(--wool-dim); font-size:13px; margin:8px 0 14px; }
h2{ font-size:28px; } h3{ font-size:19px; }
nav.tabs{ display:flex; gap:8px; margin-bottom:14px; } nav.tabs .tab{ background:none; border:1px solid var(--hairline-dim); color:var(--wool); border-radius:3px; padding:4px 10px; }
""" + cal_css + """
</style></head><body>
<nav class="tabs"><button class="tab" data-tab="calendar">Calendar</button></nav>
""" + real_markup + """
<script>
function $(id){ return document.getElementById(id); }
""" + real_helpers + """
const state = {};
const T = (h)=>new Date(Date.now()+h*36e5).toISOString();
const D = (d,hh,mm)=>{ const x=new Date(); x.setDate(x.getDate()+d); x.setHours(hh,mm||0,0,0); return x.toISOString(); };
const DAY = (d)=>{ const x=new Date(); x.setDate(x.getDate()+d);
  return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'); };
// first day this week Maya actually works (dow 2/3/6) — her Dr appointment
const MAYA_OFF = (()=>{ for (let k=1;k<7;k++){ const x=new Date(); x.setDate(x.getDate()+k);
  if ([2,3,6].includes(x.getDay())) return k; } return 3; })();
window.MAYA_OFF_DATE = DAY(MAYA_OFF);
window.DB_LOG = [];
window.LOAD_COUNT = 0;

// ── datasets ─────────────────────────────────────────────────────────────────
const LOC1 = { id:1, slug:'main', title:'Main studio', timezone:'America/Los_Angeles', address:'12 Alder Lane', enabled:true, sort_order:0 };
const DATA = {
  fresh: {
    concierge_locations: [ { id:1, slug:'main', title:'Main', timezone:'America/Los_Angeles', address:'', enabled:true, sort_order:0 } ],
    concierge_business_hours: [], concierge_appointment_types: [],
    concierge_availability: [], concierge_availability_exceptions: [],
    concierge_config: [],
    concierge_staff: [], concierge_staff_hours: [], concierge_staff_services: [],
    _queue: { requested:[], callbacks:[], today:[], needs_closing:[] }, _week: [],
  },
  populated: {
    concierge_locations: [ LOC1,
      { id:2, slug:'harbor', title:'Harbor annex', timezone:'America/New_York', address:'', enabled:false, sort_order:1 } ],
    concierge_business_hours: [
      { location_id:1, dow:1, open_min:540, close_min:1080 },{ location_id:1, dow:2, open_min:540, close_min:1080 },
      { location_id:1, dow:3, open_min:540, close_min:780 },{ location_id:1, dow:3, open_min:840, close_min:1080 },
      { location_id:1, dow:6, open_min:600, close_min:960 }],
    concierge_appointment_types: [
      { id:1, slug:'viewing', title:'Private viewing', duration_min:45, step_min:15, mode:'in-person', buffer_min:15,
        lead_time_min:240, horizon_days:21, capacity:2, max_party:4, confirm_mode:'manual', intake_prompt:'Anything you want ready?', enabled:true, sort_order:0 }],
    concierge_availability: [
      { type_id:1, location_id:1, dow:6, start_min:600, end_min:960, step_min:null },
      { type_id:1, location_id:1, dow:2, start_min:540, end_min:780, step_min:30 }],
    concierge_availability_exceptions: [
      { id:9, on_date:'2026-07-24', closed:true, note:'inventory day', location_id:1, type_id:null },
      { id:10, on_date:'2026-07-26', closed:false, start_min:600, end_min:840, location_id:null, type_id:null, note:'' },
      { id:31, on_date:window.MAYA_OFF_DATE, closed:false, start_min:780, end_min:840,
        location_id:null, type_id:null, staff_id:71, note:'Dr appointment' },
      { id:32, on_date:DAY(-30), closed:true, staff_id:71, note:'vacation', location_id:null, type_id:null },
      { id:33, on_date:DAY(-29), closed:true, staff_id:71, note:'vacation', location_id:null, type_id:null },
      { id:34, on_date:DAY(-100), closed:true, staff_id:71, note:'sick', location_id:null, type_id:null },
      { id:35, on_date:DAY(5), closed:true, staff_id:71, note:'ski trip', status:'requested', location_id:null, type_id:null },
      { id:36, on_date:DAY(6), closed:true, staff_id:71, note:'ski trip', status:'requested', location_id:null, type_id:null },
      { id:37, on_date:DAY(5), closed:true, staff_id:72, note:'', status:'approved', location_id:null, type_id:null },
      { id:38, on_date:DAY(2), closed:true, staff_id:72, note:'court', status:'denied', location_id:null, type_id:null }],
    concierge_config: [{ value:{ enabled:true, callbacks:{enabled:true}, ownerEmail:'owner@example.com', maxOpenPerContact:2, requestTtlHours:24 } }],
    concierge_staff: [
      { id:71, name:'Maya', email:'maya@example.com', phone:'555-0101', enabled:true, sort_order:0 },
      { id:72, name:'Jo', email:'jo@example.com', phone:'', enabled:true, sort_order:1 } ],
    concierge_staff_hours: [
      { staff_id:71, location_id:1, dow:2, open_min:540, close_min:1020 },
      { staff_id:71, location_id:1, dow:3, open_min:540, close_min:1020 },
      { staff_id:71, location_id:1, dow:6, open_min:540, close_min:1020 },
      { staff_id:72, location_id:1, dow:6, open_min:600, close_min:960 },
      { staff_id:72, location_id:1, dow:0, open_min:600, close_min:960 }],
    concierge_staff_services: [ { staff_id:71, type_id:1 }, { staff_id:72, type_id:1 } ],
    _queue: { requested:[
        { id:11, name:'Jordan Reyes', type:'Private viewing', staff:'Maya', starts_at:D(2,10,30), location:'Main studio', party:2,
          contact:'[contact on file]', notes:'saw the ad on Sunday', conversation_id:'c1', is_move:false, ttl_deadline:T(21) },
        { id:12, name:'Sam Okafor', type:'Private viewing', starts_at:D(3,14,0), location:'Main studio',
          contact:'[contact on file]', is_move:true, ttl_deadline:T(1.2) }],
      callbacks:[ { id:13, name:'Dana Whitfield', contact:'[contact on file]', window_pref:'tomorrow morning', age_min:2100, conversation_id:'c2' } ],
      today:[ { id:14, name:'Ana Sørensen', type:'Private viewing', staff:'Jo', starts_at:D(0,15,30), location:'Main studio', status:'booked',
          party:3, notes:'bringing a mechanic', open_notes:['send the service records'], conversation_id:'c3' } ],
      needs_closing:[ { id:15, name:'Lee Marsh', type:'Private viewing', starts_at:D(-1,11,0), conversation_id:null } ],
      recently_closed:[
        { id:41, kind:'callback', status:'done', name:'Dana Whitfield', contact:'[contact on file]',
          window_pref:'tomorrow morning', closed_at:D(-1,16,20), acted_by:'owner@example.com' },
        { id:42, kind:'appointment', status:'no_show', name:'Piet Larsen', type:'Private viewing',
          contact:'[contact on file]', starts_at:D(-2,11,0), closed_at:D(-2,12,5), acted_by:'' } ] },
    _week: [
      { id:14, conversation_id:'c3', staff:'Jo', starts_at:D(0,15,30), name:'Ana Sørensen', type:'Private viewing', location:'Main studio', location_tz:'America/Los_Angeles', status:'booked', contact:'[contact on file]' },
      { id:11, conversation_id:'c1', staff:'Maya', starts_at:D(2,10,30), name:'Jordan Reyes', type:'Private viewing', location:'Main studio', location_tz:'America/Los_Angeles', status:'requested', contact:'[contact on file]' },
      { id:16, staff:'Maya', starts_at:D(2,16,0), name:'Priya Nair', type:'Private viewing', location:'Main studio', location_tz:'America/Los_Angeles', status:'booked', contact:'[contact on file]' },
      { id:12, starts_at:D(3,14,0), name:'Sam Okafor', type:'Private viewing', location:'Main studio', location_tz:'America/Los_Angeles', status:'requested', contact:'[contact on file]' },
      { id:17, starts_at:D(5,12,0), name:'Chris Dole', type:'Private viewing', location:'Main studio', location_tz:'America/Los_Angeles', status:'booked', contact:'[contact on file]' }],
  },
  edge: {
    concierge_locations: [ LOC1,
      { id:2, slug:'harbor', title:'Harbor annex', timezone:'America/New_York', address:'9 Pier Rd', enabled:true, sort_order:1 },
      { id:3, slug:'tokyo', title:'Tokyo salon — 東京サロン (very long location name that keeps going)', timezone:'Asia/Tokyo', address:'', enabled:true, sort_order:2 }],
    concierge_business_hours: [ { location_id:1, dow:1, open_min:0, close_min:1440 } ],
    concierge_appointment_types: [
      { id:1, slug:'viewing', title:'Private viewing', duration_min:45, step_min:15, mode:'in-person', buffer_min:15, lead_time_min:240, horizon_days:21, capacity:2, max_party:4, confirm_mode:'manual', intake_prompt:'', enabled:true, sort_order:0 },
      { id:2, slug:'consult', title:'A deliberately very long offering title to see how the card copes with wrapping', duration_min:240, step_min:5, mode:'video', buffer_min:240, lead_time_min:0, horizon_days:365, capacity:50, max_party:50, confirm_mode:'auto', intake_prompt:'x', enabled:false, sort_order:1 }],
    concierge_availability: [], concierge_availability_exceptions: [],
    concierge_config: [{ value:{ enabled:true } }],
    concierge_staff: [], concierge_staff_hours: [], concierge_staff_services: [],
    _queue: { requested:[
        { id:21, name:'Maximiliano Barthélemy-Ravenscroft von Hohenlohe III', type:'A deliberately very long offering title to see how the card copes with wrapping',
          starts_at:D(1,9,0), location:'Tokyo salon — 東京サロン (very long location name that keeps going)', party:12,
          contact:'[contact on file]', notes:'An extremely long visitor note that rambles on and on about the provenance, the paperwork, whether the seats are original, and if the timing chain was ever replaced — testing wrap behavior end to end.',
          conversation_id:'c9', is_move:false, ttl_deadline:T(-2) }],
      callbacks:[ { id:22, name:'Kai', contact:'[contact on file]', window_pref:'', age_min:4620, conversation_id:null } ],
      today:[], needs_closing:[] },
    _week: (function(){ const out=[]; for (let k=0;k<6;k++) out.push(
      { starts_at:D(1,9+k,0), name:'Guest '+(k+1), type:'Private viewing', location:'Main studio', location_tz:'America/Los_Angeles', status:(k%2?'requested':'booked'), contact:'[contact on file]' }); return out; })(),
  },
};
DATA.error = null;   // scenario 'error': every call fails

// ── instrumented data layer ──────────────────────────────────────────────────
const SCENARIO = new URLSearchParams(location.search).get('s') || 'populated';
function ds(){ return DATA[SCENARIO]; }
window.SEQ = 900;
function chain(table){
  const log = { op:'select', table:table, args:[] };
  const fin = (op, arg)=>{ log.op = op; if (arg !== undefined) log.args.push(JSON.stringify(arg)); return o; };
  const o = {
    select:()=>o, order:()=>o,
    eq:(k,v)=>{ log.args.push(k+'='+v); return o; },
    insert:(rows)=>fin('insert', rows), update:(p)=>fin('update', p),
    upsert:(rows)=>fin('upsert', rows), delete:()=>fin('delete'),
    then:(a,b)=>{
      window.DB_LOG.push(log);
      if (SCENARIO === 'error') return Promise.resolve({ data:null, error:{ message:'boom: '+table } }).then(a,b);
      // a MUTABLE store: writes persist so reload-after-save reflects reality
      const store = ds();
      const eqs = log.args.filter((x)=>/^[a-z_]+=/.test(x)).map((x)=>x.split('='));
      const payload = (()=>{ try { return JSON.parse(log.args[log.args.length-1] || 'null'); } catch(e){ return null; } })();
      let data = [];
      if (log.op === 'select') data = store[table] || [];
      else if (log.op === 'delete' && store[table]) {
        store[table] = store[table].filter((r)=>!eqs.every(([k,v])=>String(r[k])===String(v)));
      } else if (log.op === 'insert' && Array.isArray(payload)) {
        const withIds = payload.map((r)=>({ id: ++window.SEQ, ...r }));
        (store[table] = store[table] || []).push(...withIds);
        data = withIds.map((r)=>({ id: r.id }));
      } else if (log.op === 'update' && store[table]) {
        store[table].forEach((r)=>{ if (eqs.every(([k,v])=>String(r[k])===String(v))) Object.assign(r, payload); });
      } else if (log.op === 'upsert' && Array.isArray(payload)) {
        if (table === 'concierge_config') {
          const v = payload[0] && payload[0].value;
          store.concierge_config = [{ value: v }];
        } else {
          payload.forEach((r)=>{
            const T = (store[table] = store[table] || []);
            const hit = T.find((x)=>x.slug === r.slug);
            if (hit) { Object.assign(hit, r); data = [{ id: hit.id }]; }
            else { const nr = { id: ++window.SEQ, ...r }; T.push(nr); data = [{ id: nr.id }]; }
          });
        }
      }
      return Promise.resolve({ data:data, error:null }).then(a,b);
    },
  };
  return o;
}
const sb = {
  from: chain,
  rpc: (fn, args)=>{
    window.DB_LOG.push({ op:'rpc', table:fn, args:[JSON.stringify(args||{})] });
    if (SCENARIO === 'error') return Promise.resolve({ data:null, error:{ message:'boom: '+fn } });
    if (fn === 'appointments_queue') return Promise.resolve({ data:ds()._queue, error:null });
    if (fn === 'appointments_week') return Promise.resolve({ data:ds()._week, error:null });
    if (fn === 'appointment_facets') return Promise.resolve({ data:[], error:null });
    if (fn === 'appointment_slots') return Promise.resolve({ data:{ ok:true, slots:[
      { shop_label:'Sat Jul 18, 10:00' }, { shop_label:'Sat Jul 18, 10:15' }, { shop_label:'Tue Jul 21, 09:30' }] }, error:null });
    if (fn === 'reassign_appointment') return Promise.resolve({ data:{ ok:true, id:(args||{}).p_id, staff_name:'Jo' }, error:null });
    if (fn === 'remove_location' || fn === 'remove_offering' || fn === 'remove_person') {
      // location 1 pretends to have standing visits; everything else removes
      if (fn === 'remove_location' && (args||{}).p_id === 1)
        return Promise.resolve({ data:{ ok:false, reason:'has_visits', count:3 }, error:null });
      return Promise.resolve({ data:{ ok:true, id:(args||{}).p_id }, error:null });
    }
    if (fn === 'capacity_matrix') return Promise.resolve({ data:{ ok:true, rows:[
      { offering:'Private viewing', location:'Main studio', capacity:2, duration_min:45, step_min:15,
        staffed:true, people:2, cover_min_week:3120, starts_week:52, peak_concurrent:2, effective:2, warn:null },
      { offering:'Private viewing', location:'Harbor annex', capacity:2, duration_min:45, step_min:15,
        staffed:true, people:0, cover_min_week:0, starts_week:12, peak_concurrent:0, effective:0,
        warn:'no qualified person has hours here' } ] }, error:null });
    if (fn === 'booking_report' && (args||{}).p_dim === 'callbacks') return Promise.resolve({ data:{
      ok:true, days:30, dim:'callbacks', open_now:1, oldest_open_min:135,
      rows:[ { name:'owner@example.com', done:5, cancelled:1, median_min:42 } ] }, error:null });
    if (fn === 'booking_report') return Promise.resolve({ data:{ ok:true, days:30, dim:(args||{}).p_dim, rows:
      (args||{}).p_dim === 'offering'
        ? [ { name:'Private viewing', booked_min:1620, done:22, no_show:4, cancelled:1, show_rate:85, upcoming:4 } ]
        : [ { name:'Main studio', booked_min:1620, done:22, no_show:4, cancelled:1, show_rate:85, upcoming:4 } ] }, error:null });
    if (fn === 'staff_report') return Promise.resolve({ data:{ ok:true, days:30, people:[
      { name:'Maya', enabled:true, sched_min:9600, booked_min:1260, utilization:13, done:14, no_show:4, cancelled:1, show_rate:78, days_off:2, upcoming:3 },
      { name:'Jo', enabled:true, sched_min:4800, booked_min:360, utilization:8, done:8, no_show:0, cancelled:0, show_rate:100, days_off:0, upcoming:1 } ] }, error:null });
    if (fn === 'staff_departure') return Promise.resolve({ data:{ ok:true, staff_name:'Maya', moved:2, needs_attention:1, details:[] }, error:null });
    return Promise.resolve({ data:{ ok:true }, error:null });
  },
};
</script>
<script>
""" + region + """
""" + h1 + h2 + """
const _load0 = loadCalendar;
loadCalendar = async function(){ window.LOAD_COUNT++; return _load0(); };
loadCalendar().then(()=>{ document.title = 'qa-ready'; });
</script></body></html>"""

out = '/tmp/claude-0/-home-user-Blanket/018a52fa-bb83-5133-b204-8b619fc1b719/scratchpad/cal_qa.html'
open(out, 'w', encoding='utf-8').write(HTML)
print('QA harness written (full fidelity):', out)
