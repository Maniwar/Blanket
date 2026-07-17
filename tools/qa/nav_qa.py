#!/usr/bin/env python3
"""Nav-grouping harness — REAL markup (navwrap), REAL nav CSS, REAL JS
(TAB_GROUPS + syncTabChrome + renderGroups IIFE + activateTab) extracted from
admin.html at run time; only panels and the tab loaders are stubbed."""
src = open('/home/user/Blanket/admin.html', encoding='utf-8').read()

mi = src.index('<div class="navwrap">')
mj = src.index('</div>', src.index('</nav>', src.index('<nav class="tabs"', mi))) + 6
markup = src[mi:mj]

ci = src.index('  /* Two-line nav')
end_css = "nav.tabs button{ flex:none; padding:12px 12px; }\n  }"
cj = src.index(end_css, ci) + len(end_css)
css = src[ci:cj]
assert '@media (max-width:700px)' in css, 'mobile nav rules missing from the slice'

ji = src.index('const TAB_NAMES = [')
jj = src.index('})();', ji) + 5
groups_js = src[ji:jj]
ai = src.index('function activateTab(name, fromHistory) {')
aj = src.index("  if (name === 'evals') autoGrowAll('#evals-list');\n}", ai)
activate_js = src[ai:aj] + "  if (name === 'evals') autoGrowAll('#evals-list');\n}"

TABS = ['tuning', 'knowledge', 'procedures', 'cache', 'judge', 'customers', 'conversations',
        'conversion', 'nps', 'spend', 'calendar', 'actions', 'website', 'tools', 'evals', 'edition']
panels = '\n'.join(f'<div id="panel-{t}" class="panel{" on" if t == "conversations" else ""}">{t}</div>' for t in TABS)

HTML = """<!doctype html><html><head><meta charset="utf-8"><title>nav-qa</title><style>
:root{ --loden:#26332B; --loden-deep:#171F1A; --wool:#F1ECE2; --brass:#A67C3D; --brass-soft:#C49B5B;
  --hairline:rgba(196,155,91,.35); --hairline-dim:rgba(196,155,91,.18);
  --wool-dim:rgba(241,236,226,.62); --wool-faint:rgba(241,236,226,.38); --ink-well:rgba(241,236,226,.04); }
*{ box-sizing:border-box; margin:0; padding:0; }
body{ background:var(--loden-deep); color:var(--wool); font-family:system-ui,sans-serif; }
.panel{ display:none; padding:30px; } .panel.on{ display:block; }
""" + css + """
</style></head><body>
""" + markup + """
""" + panels + """
<script>
function $(id){ return document.getElementById(id); }
function autoGrowAll(){}
function loadConversion(){ window.LOADED = (window.LOADED||[]).concat('conversion'); }
function loadSpend(){} function loadCalendar(){} function loadNps(){}
""" + groups_js + """
""" + activate_js + """
document.querySelectorAll('nav.tabs .tab').forEach(function (btn) {
  btn.addEventListener('click', function () { activateTab(btn.dataset.tab); });
});
document.title = 'qa-ready';
</script></body></html>"""

out = '/tmp/claude-0/-home-user-Blanket/018a52fa-bb83-5133-b204-8b619fc1b719/scratchpad/nav_qa.html'
open(out, 'w', encoding='utf-8').write(HTML)
print('nav harness written:', out)
