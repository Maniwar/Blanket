#!/usr/bin/env python3
"""Judge & Coach harness — REAL panel markup, REAL loadJudge + helpers from
admin.html; only sb is stubbed (rpc judge_findings + flags insert/update)."""
src = open('/home/user/Blanket/admin.html', encoding='utf-8').read()
mi = src.index('<div id="panel-judge" class="panel">')
mj = src.index('<div id="panel-evals" class="panel">')
markup = src[mi:mj]
ji = src.index('/* ── Judge & coach — the loop')
jj = src.index('function calRow(tone, html, qid) {')
loader = src[ji:jj]
hi = src.index('function el(tag, cls, text) {')
hj = src.index('function nowIso() { return new Date().toISOString(); }', hi)
helpers = src[hi:hj]

HTML = """<!doctype html><html><head><meta charset="utf-8"><title>jc-qa</title><style>
:root{ --loden:#26332B; --loden-deep:#171F1A; --wool:#F1ECE2; --brass:#A67C3D; --brass-soft:#C49B5B;
  --hairline:rgba(196,155,91,.35); --hairline-dim:rgba(196,155,91,.18);
  --wool-dim:rgba(241,236,226,.62); --wool-faint:rgba(241,236,226,.38); --ink-well:rgba(241,236,226,.04); }
*{ box-sizing:border-box; margin:0; padding:0; }
body{ background:var(--loden-deep); color:var(--wool); font-family:system-ui,sans-serif; padding:20px; max-width:1100px; margin:0 auto; }
h2,h3{ font-family:Georgia,serif; font-weight:400; }
.micro{ font-family:ui-monospace,monospace; font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--brass-soft); }
.micro.warn{ color:#d3b88e; } .mono{ font-family:ui-monospace,monospace; }
.panel{ display:block; } section.card{ border:1px solid var(--hairline-dim); border-radius:3px; padding:22px; margin-bottom:22px; }
section.card > .card-head{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:14px; border-bottom:1px solid var(--hairline-dim); padding-bottom:10px; }
.note{ color:var(--wool-dim); font-size:13px; } .btn{ background:var(--brass); border:1px solid var(--brass); color:#171F1A; padding:6px 12px; border-radius:2px; cursor:pointer; }
.btn.ghost{ background:none; color:var(--brass-soft); border-color:var(--hairline); } .btn.mini{ font-size:11px; padding:3px 9px; }
input{ background:var(--ink-well); border:1px solid var(--hairline-dim); color:var(--wool); padding:7px 10px; border-radius:2px; }
.cal-frow{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.cal-empty{ color:var(--wool-faint); font-size:13px; padding:8px 0; }
.cal-reptable{ width:100%; border-collapse:collapse; font-family:ui-monospace,monospace; font-size:11px; }
.cal-reptable th{ text-align:left; color:var(--wool-faint); font-weight:400; padding:4px 10px 6px 0; border-bottom:1px solid var(--hairline-dim); }
.cal-reptable td{ padding:6px 10px 6px 0; border-bottom:1px solid var(--hairline-dim); color:var(--wool-dim); }
</style></head><body>
""" + markup + """
<script>
function $(id){ return document.getElementById(id); }
""" + helpers + """
const state = {};
window.DB_LOG = [];
const FINDINGS = { ok:true, days:14,
  totals:{ spoke:45, held:157, vetoed:62, prefilter:9, redraft_ok:11, redraft_blocked:7 },
  kinds:[ { kind:'nudge', spoke:40, held:91, vetoed:54 }, { kind:'bubble', spoke:5, held:65, vetoed:5 } ],
  classes:[
    { key:'plumbing', n:7, latest:new Date().toISOString(), samples:[
      { line:'Once you\\u2019re signed in, you\\u2019ll see the register', reason:'narrates sign-in mechanics', at:new Date().toISOString() } ] },
    { key:'invented', n:4, latest:new Date().toISOString(), samples:[
      { line:'It lasts fifty years', reason:'invents a durability claim', at:new Date().toISOString() } ] } ],
  gaps:[
    { q:'how many are actually left in the edition?', n:36, latest:new Date().toISOString(), system:false, feedback:false, ids:[1,2,3] },
    { q:'(system) semantic cache self-check', n:4, latest:new Date().toISOString(), system:true, feedback:false, ids:[4] },
    { q:'(merchant) studio feedback', n:1, latest:new Date().toISOString(), system:false, feedback:true, ids:[5] } ] };
const CFG = { outreach: { pausedKinds: ['opener'] }, judge: { rules: '' } };
const SOPS = [ { slug:'coach-draft-plumbing', title:'Coach draft \u2014 say it differently (plumbing)', enabled:false } ];
const sb = {
  rpc: (fn, args) => { window.DB_LOG.push('rpc:' + fn + ':' + JSON.stringify(args || {}));
    return Promise.resolve({ data: FINDINGS, error: null }); },
  from: (table) => ({
    insert: (rows) => { window.DB_LOG.push('insert:' + table + ':' + JSON.stringify(rows).slice(0, 160));
      return Promise.resolve({ data: null, error: null }); },
    update: (patch) => ({ eq: (k, v) => { window.DB_LOG.push('update:' + table + ':' + k + '=' + v + ':' + JSON.stringify(patch));
      return Promise.resolve({ data: null, error: null }); } }),
    upsert: (rows) => { window.DB_LOG.push('upsert:' + table + ':' + JSON.stringify(rows).slice(0, 220));
      if (table === 'concierge_config' && rows[0]) CFG[rows[0].key] = rows[0].value;
      return Promise.resolve({ data: null, error: null }); },
    select: () => ({
      eq: (k, v) => Promise.resolve({ data: table === 'concierge_config' ? [{ key: v, value: CFG[v] || {} }] : [], error: null }),
      like: () => Promise.resolve({ data: table === 'concierge_sops' ? SOPS : [], error: null }),
    }),
  }),
};
function nowIso() { return new Date().toISOString(); }
function activateTab(n) { window.DB_LOG.push('tab:' + n); }
async function adminGet(q) {
  window.DB_LOG.push('adminGet:' + q);
  const sendIt = q.indexOf('send=1') !== -1;
  return { ok: true, subject: 'Your concierge\u2019s week', lines: [
    'This week the concierge spoke 45 times, held back 157, and the review judge blocked 62 (9 by the deterministic guard).',
    'Repeat defect \u2014 plumbing: 7 block(s) this week.'],
    drafted: sendIt ? ['plumbing'] : [], sent: sendIt };
}
""" + loader + """
loadJudge().then(() => { document.title = 'qa-ready'; });
</script></body></html>"""
out = '/tmp/claude-0/-home-user-Blanket/018a52fa-bb83-5133-b204-8b619fc1b719/scratchpad/jc_qa.html'
open(out, 'w', encoding='utf-8').write(HTML)
print('jc harness written:', out)
