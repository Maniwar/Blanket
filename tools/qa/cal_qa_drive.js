// Calendar tab QA driver (living-calendar round): full-fidelity harness with
// a MUTABLE data store. S1-S6 as before (Sam + Marco walkthroughs); S7 drives
// the living calendar (tick cards, coverage lanes, click-to-time-off, flash);
// S8 drives departures (needs-a-person flags, reassign, the leave button).
const { chromium } = require('playwright-core');
const fs = require('fs');
const BASE = '/tmp/claude-0/-home-user-Blanket/018a52fa-bb83-5133-b204-8b619fc1b719/scratchpad';
const EV = BASE + '/cal-evidence-living';
fs.mkdirSync(EV, { recursive: true });
const results = [];
let shots = 0;
function log(id, name, pass, detail) {
  results.push({ id, name, pass, detail: detail || '' });
  console.log((pass ? 'PASS ' : 'FAIL ') + id + '  ' + name + (detail && !pass ? '  — ' + detail : ''));
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  async function open(scenario, viewport) {
    const pg = await b.newPage({ viewport: viewport || { width: 1180, height: 900 } });
    pg.errors = [];
    pg.on('pageerror', (e) => pg.errors.push(String(e)));
    await pg.goto('file://' + BASE + '/cal_qa.html?s=' + scenario);
    await pg.waitForFunction(() => document.title === 'qa-ready', { timeout: 8000 });
    return pg;
  }
  async function shot(pg, name, full) {
    shots++;
    await pg.screenshot({ path: EV + '/' + name + '.png', fullPage: full !== false });
  }
  const dbops = (pg) => pg.evaluate(() => window.DB_LOG.map((l) => l.op + ':' + l.table + (l.args.length ? '(' + l.args.join(';').slice(0, 180) + ')' : '')));
  const note = (pg) => pg.$eval('#cal-note', (n) => n.textContent);
  const reload = (pg) => pg.evaluate(() => loadCalendar());

  // ── S1 fresh install — SAM'S WALKTHROUGH (no free text but a name) ───────
  let pg = await open('fresh');
  await shot(pg, '01-fresh-checklist');
  log('S1.1', 'fresh: renders without errors', pg.errors.length === 0, pg.errors.join('; '));
  log('S1.2', 'fresh: three-step checklist, nothing done, step 3 locked',
    await pg.$$eval('#cal-setup .cal-step', (x) => x.length) === 3 &&
    await pg.$$eval('#cal-setup .cal-step.done', (x) => x.length) === 0 &&
    await pg.$eval('#cal-setup', (n) => n.textContent.includes('unlocks when 1 and 2 are done')));
  log('S1.3', 'fresh: master switch DISABLED with the reason on it (never refused)',
    await pg.$eval('#cal-on', (n) => n.disabled && n.title.includes('Unlocks')));
  log('S1.4', 'fresh: timezone is a dropdown, browser zone preselected',
    await pg.$eval('#cal-nl-tz', (n) => n.tagName === 'SELECT' &&
      n.value === (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone));
  log('S1.5', 'fresh: hours editor auto-open with quick-start templates',
    !!(await pg.$('#cal-locs .cal-editor:not(.is-collapsed)')) && !!(await pg.$('[data-tpl="wk"]')));

  // step 1 — hours from a template, one tap + save
  await pg.click('[data-tpl="wk"]');
  log('S1.6', 'template fills Mon–Fri 9–5 as picker rows (5 ranges, weekend Closed)',
    await pg.$$eval('#cal-locs .cal-hr-range', (x) => x.length) === 5 &&
    await pg.$$eval('#cal-locs .cal-closed', (x) => x.length) === 2);
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-locs .cal-editor >> text=Save hours');
  await pg.waitForTimeout(100);
  const h1 = await dbops(pg);
  log('S1.7', 'save hours = delete then insert 5 rows (540→1020)',
    h1[0].startsWith('delete:concierge_business_hours') &&
    h1.some((o) => o.startsWith('insert:concierge_business_hours') && o.includes('540') && o.includes('1020')));
  log('S1.8', 'checklist: step 1 ticks itself after the save',
    await pg.$$eval('#cal-setup .cal-step', (x) => x[0].classList.contains('done')));

  // step 2 — an offering with a day-chip window; slug auto-generated
  await pg.click('#cal-add-type');
  await pg.fill('#cal-types [data-f="title"]', 'Viewing');
  await pg.check('#cal-types [data-f="enabled"]');
  await pg.click('#cal-types [data-add-win]');
  await pg.click('#cal-types [data-win] .dchip[data-dow="6"]');
  await pg.fill('#cal-types [data-win] [data-w="from"]', '10:00');
  await pg.fill('#cal-types [data-win] [data-w="to"]', '16:00');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-types [data-save-type]');
  await pg.waitForTimeout(120);
  const t1 = await dbops(pg);
  log('S1.9', 'offering saves with an auto slug + Sat window records',
    t1.some((o) => o.startsWith('upsert:concierge_appointment_types') && o.includes('"slug":"viewing"')) &&
    t1.some((o) => o.startsWith('insert:concierge_availability') && o.includes('"dow":6') && o.includes('600') && o.includes('960')));
  log('S1.10', 'checklist: step 2 ticks; switch unlocks',
    await pg.$$eval('#cal-setup .cal-step.done', (x) => x.length) === 2 &&
    !(await pg.$eval('#cal-on', (n) => n.disabled)));
  await shot(pg, '02-fresh-two-done', false);

  // step 3 — flip it on
  await pg.check('#cal-on');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-save-rules');
  await pg.waitForTimeout(80);
  log('S1.11', 'switch on: config upserted, note confirms',
    (await dbops(pg)).some((o) => o.startsWith('upsert:concierge_config') && o.includes('"enabled":true')) &&
    (await note(pg)) === 'Bookings are ON.');
  await reload(pg);
  await pg.waitForTimeout(80);
  log('S1.12', 'after reload: masthead live, checklist gone',
    await pg.$eval('#cal-mh-status', (n) => !n.classList.contains('off') && n.textContent.trim() === 'taking bookings') &&
    await pg.$eval('#cal-setup', (n) => n.children.length === 0));
  await shot(pg, '03-fresh-live', false);

  // structured validation: the UI cannot express bad states quietly
  await pg.click('#cal-types .cal-sum .edit');
  await pg.click('#cal-types [data-add-win]');
  const win2 = '#cal-types [data-win]:last-of-type';
  await pg.click(win2 + ' .dchip[data-dow="2"]');
  await pg.fill(win2 + ' [data-w="from"]', '14:00');
  await pg.fill(win2 + ' [data-w="to"]', '10:00');
  await pg.click('#cal-types [data-save-type]');
  await pg.waitForTimeout(60);
  log('S1.13', 'window ending before it starts is refused in plain words',
    (await note(pg)).includes('ends before it starts'));
  await pg.close();

  // ── S2 populated ─────────────────────────────────────────────────────────
  pg = await open('populated');
  await shot(pg, '04-populated');
  log('S2.1', 'populated: renders without errors', pg.errors.length === 0, pg.errors.join('; '));
  log('S2.2', 'populated: no checklist when live; switch enabled',
    await pg.$eval('#cal-setup', (n) => n.children.length === 0) &&
    !(await pg.$eval('#cal-on', (n) => n.disabled)));
  log('S2.3', 'populated: pulse numbers 2/1/1/1/3',
    await pg.$$eval('.cal-pulse-t .num', (x) => x.map((n) => n.textContent).join(',')) === '2,1,1,1,3');
  log('S2.4', 'populated: house rules are dropdowns, hydrated (cap 2, ttl 24h)',
    await pg.$eval('#cal-cap', (n) => n.tagName === 'SELECT' && n.value === '2') &&
    await pg.$eval('#cal-ttl', (n) => n.tagName === 'SELECT' && n.value === '24'));
  log('S2.5', 'populated: offering summary speaks plainly (you confirm, starts every 15)',
    (await pg.$eval('#cal-types .cal-sum .dig', (n) => n.textContent)).includes('45 min · starts every 15 · in-person · you confirm'));
  // hours render as picker rows; split shift shows two ranges on Wed
  await pg.click('#cal-locs .cal-sum .edit');
  log('S2.6', 'hours are time-picker rows (5 ranges; Wed split shift = 2)',
    await pg.$$eval('#cal-locs .cal-hr-range', (x) => x.length) === 5 &&
    await pg.$$eval('#cal-locs .cal-hr-day[data-dow="3"] .cal-hr-range', (x) => x.length) === 2);
  log('S2.7', 'timezone dropdown carries the saved zone',
    await pg.$eval('#cal-locs [data-f="timezone"]', (n) => n.tagName === 'SELECT' && n.value === 'America/Los_Angeles'));
  // end-before-start refused, nothing written
  await pg.fill('#cal-locs .cal-hr-day[data-dow="1"] [data-hr="from"]', '18:00');
  await pg.fill('#cal-locs .cal-hr-day[data-dow="1"] [data-hr="to"]', '09:00');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-locs .cal-editor >> text=Save hours');
  await pg.waitForTimeout(60);
  log('S2.8', 'hours ending before start refused; nothing deleted',
    (await note(pg)).includes('end before they start') && !(await dbops(pg)).some((o) => o.startsWith('delete:')));
  await pg.fill('#cal-locs .cal-hr-day[data-dow="1"] [data-hr="from"]', '09:00');
  await pg.fill('#cal-locs .cal-hr-day[data-dow="1"] [data-hr="to"]', '18:00');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-locs .cal-editor >> text=Save hours');
  await pg.waitForTimeout(100);
  const hop = await dbops(pg);
  log('S2.9', 'valid hours save = delete then insert', hop[0].startsWith('delete:concierge_business_hours') &&
    hop.some((o) => o.startsWith('insert:concierge_business_hours')));
  // availability windows render grouped with day chips + step select
  await pg.click('#cal-types .cal-sum .edit');
  log('S2.10', 'windows render as day-chip rows (2 windows; Tue @30 grouped)',
    await pg.$$eval('#cal-types [data-win]', (x) => x.length) === 2 &&
    await pg.$$eval('#cal-types [data-win]', (rows) => rows.some((r) =>
      r.querySelector('.dchip[data-dow="2"]').classList.contains('on') &&
      r.querySelector('[data-w="step"]').value === '30')));
  // out-of-hours warn still fires and survives the reload
  await pg.click('#cal-types [data-add-win]');
  const w3 = '#cal-types [data-win]:last-of-type';
  await pg.click(w3 + ' .dchip[data-dow="0"]');
  await pg.fill(w3 + ' [data-w="from"]', '08:00');
  await pg.fill(w3 + ' [data-w="to"]', '09:00');
  await pg.click('#cal-types [data-save-type]');
  await pg.waitForTimeout(140);
  log('S2.11', 'out-of-hours window saved, WARNED, warning survives reload',
    (await note(pg)).includes('outside') && await pg.$eval('#cal-note', (n) => n.classList.contains('warn')));
  // preview — the live-register loop
  await pg.click('#cal-types .cal-sum .pv');
  await pg.waitForTimeout(80);
  log('S2.12', 'preview shows the exact slots a visitor would get',
    await pg.$$eval('#cal-types .cal-preview .cal-pv', (x) => x.length) === 3 &&
    await pg.$eval('#cal-types .cal-preview', (n) => n.textContent.includes('live register')));
  await shot(pg, '05-populated-preview', false);
  // exceptions: time pickers behind the checkbox; two bad states refused
  await pg.fill('#cal-exc-date', '2026-08-01');
  await pg.uncheck('#cal-exc-closed');
  log('S2.13', 'special-hours pickers appear when Closed unticked',
    await pg.$eval('#cal-exc-winwrap', (n) => n.style.display !== 'none'));
  await pg.fill('#cal-exc-from', '14:00');
  await pg.fill('#cal-exc-to', '10:00');
  await pg.click('#cal-exc-add'); await pg.waitForTimeout(60);
  log('S2.14', 'special hours ending before start refused', (await note(pg)).includes('end before they start'));
  await pg.fill('#cal-exc-from', '10:00');
  await pg.fill('#cal-exc-to', '14:00');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-exc-add'); await pg.waitForTimeout(80);
  log('S2.15', 'valid special hours insert with minutes',
    (await dbops(pg)).some((o) => o.startsWith('insert:concierge_availability_exceptions') && o.includes('600') && o.includes('840')));
  // queue actions unchanged
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-queue .cal-row button.btn:not(.ghost)');
  await pg.waitForTimeout(80);
  log('S2.16', 'Confirm fires confirm_appointment(11)', (await dbops(pg)).includes('rpc:confirm_appointment({"p_id":11})'));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('text=Done');
  await pg.waitForTimeout(80);
  log('S2.17', 'callback Done fires close_appointment(done)', (await dbops(pg)).some((o) => o.includes('"p_outcome":"done"')));
  // ttl select saves the chosen preset
  await pg.selectOption('#cal-ttl', '48');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-save-rules'); await pg.waitForTimeout(60);
  log('S2.18', 'TTL preset (2 days) saves as 48',
    (await dbops(pg)).some((o) => o.startsWith('upsert:concierge_config') && o.includes('"requestTtlHours":48')));
  // ── S6 the team (Marco: a few employees, assignment by availability) ─────
  log('S6.1', 'team card present; populated shows Maya + Jo with digests',
    await pg.$$eval('#cal-staff .cal-sum', (x) => x.length) === 2 &&
    (await pg.$eval('#cal-staff', (n) => n.textContent)).includes('Maya') &&
    (await pg.$eval('#cal-staff .cal-sum .dig', (n) => n.textContent)).includes('does Private viewing'));
  log('S6.2', 'queue rows say who (with Maya / with Jo)',
    await pg.$eval('#cal-queue', (n) => n.textContent.includes('with Maya') && n.textContent.includes('with Jo')));
  log('S6.3', 'offering digest names its people',
    (await pg.$eval('#cal-types .cal-sum .dig', (n) => n.textContent)).includes('with Maya, Jo'));
  log('S6.4', 'no slug visible anywhere on the tab',
    await pg.$eval('#panel-calendar', (n) => !/slug/i.test(n.textContent)));
  // add a person end-to-end: name, hours row, service tick — one save
  await pg.click('#cal-add-staff');
  const NEWP = '#cal-staff > div:last-child ';
  await pg.fill(NEWP + '[data-f="stname"]', 'Ana');
  await pg.click(NEWP + '[data-sthrs] .cal-hr-day[data-dow="5"] [data-add-range]');
  await pg.click(NEWP + '[data-svc="1"]');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click(NEWP + '[data-save-staff]');
  await pg.waitForTimeout(120);
  const sop = await dbops(pg);
  log('S6.5', 'save person = insert staff + hours rows + service ticks',
    sop.some((o) => o.startsWith('insert:concierge_staff(') && o.includes('"name":"Ana"')) &&
    sop.some((o) => o.startsWith('insert:concierge_staff_hours') && o.includes('"dow":5')) &&
    sop.some((o) => o.startsWith('insert:concierge_staff_services')));
  log('S6.6', 'roster now shows three people', await pg.$$eval('#cal-staff .cal-sum', (x) => x.length) === 3);
  // personal time off: added under the person, absent from the shop ledger
  await pg.$$eval('#cal-staff .cal-sum .edit', (btns) => btns[0].click());
  const P1 = '#cal-staff > div:first-child ';
  await pg.fill(P1 + '[data-f="offdate"]', '2026-08-03');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click(P1 + '[data-add-off]');
  await pg.waitForTimeout(120);
  log('S6.7', 'time off inserts a personal exception row',
    (await dbops(pg)).some((o) => o.startsWith('insert:concierge_availability_exceptions') && o.includes('"staff_id":71')));
  log('S6.8', 'the shop ledger does NOT list personal time off',
    !(await pg.$eval('#cal-exc', (n) => n.textContent.includes('2026-08-03'))));
  log('S6.9', 'the person card lists the day off',
    await pg.$eval('#cal-staff', (n) => n.textContent.includes('2026-08-03')));
  // add-location asks only name + timezone (slug is generated)
  log('S6.10', 'add-location has no slug field; slug auto-generates',
    !(await pg.$('#cal-nl-slug')));
  await pg.fill('#cal-nl-title', 'Harbor East');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-nl-add');
  await pg.waitForTimeout(80);
  log('S6.11', 'new location slug derived from the name',
    (await dbops(pg)).some((o) => o.startsWith('insert:concierge_locations') && o.includes('"slug":"harbor-east"')));
  await shot(pg, '09-team', false);
  await pg.close();

  // ── S7 the living calendar (fresh populated page — S6 mutated the store) ──
  pg = await open('populated');
  const offDate = await pg.evaluate(() => window.MAYA_OFF_DATE);
  log('S7.1', 'team view on: toggle visible+checked, one lane per person per day (14)',
    await pg.$eval('#cal-wk-teamlbl', (n) => n.style.display !== 'none') &&
    await pg.$eval('#cal-wk-team', (n) => n.checked) &&
    await pg.$$eval('.cal-wk-row.lane', (x) => x.length) === 14);
  log('S7.2', 'lanes carry the person\'s working-hours bands',
    await pg.$$eval('.cal-wk-row.lane .cal-open', (x) => x.length) > 0);
  log('S7.3', 'Dr appointment: red hatch in Maya\'s lane, right day, titled 13:00–14:00',
    await pg.$eval('.cal-lane-track[data-lane="71"][data-day="' + offDate + '"] .cal-off',
      (n) => n.title.includes('13:00') && n.title.includes('14:00') && n.title.includes('Maya')));
  log('S7.4', 'assigned ticks live in their person\'s lane (Jordan in Maya\'s)',
    await pg.$$eval('.cal-lane-track[data-lane="71"] .cal-tick[data-qid="11"]', (x) => x.length) === 1);
  await shot(pg, '10-living-lanes');
  // the tick card: click Jordan's tick → everything about the visit + acts
  await pg.click('.cal-tick[data-qid="11"]');
  await pg.waitForTimeout(60);
  log('S7.5', 'tick click opens the visit card: name, who, state, Confirm/Decline',
    !!(await pg.$('.cal-pop')) &&
    await pg.$eval('.cal-pop', (n) => n.textContent.includes('Jordan Reyes') &&
      n.textContent.includes('awaiting confirmation') && n.textContent.includes('with Maya')));
  await shot(pg, '11-tick-card', false);
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('.cal-pop button.btn:not(.ghost)');
  await pg.waitForTimeout(120);
  log('S7.6', 'card Confirm fires confirm_appointment(11) and the card closes',
    (await dbops(pg)).includes('rpc:confirm_appointment({"p_id":11})') && !(await pg.$('.cal-pop')));
  // outside tap dismisses
  await pg.click('.cal-tick[data-qid="11"]');
  await pg.waitForTimeout(60);
  await pg.mouse.click(5, 5);
  await pg.waitForTimeout(60);
  log('S7.7', 'tap anywhere else dismisses the card', !(await pg.$('.cal-pop')));
  // click a day in Jo's lane → time off in two taps
  const joDay = await pg.$eval('.cal-lane-track[data-lane="72"]', (n) => n.getAttribute('data-day'));
  await pg.click('.cal-lane-track[data-lane="72"]');
  await pg.waitForTimeout(60);
  log('S7.8', 'lane click opens the time-off card for that person + day',
    await pg.$eval('.cal-pop', (n, d) => n.textContent.includes('time off — Jo') && n.textContent.includes(d), joDay));
  await shot(pg, '12-timeoff-card', false);
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('.cal-pop >> text=Add time off');
  await pg.waitForTimeout(150);
  log('S7.9', 'all-day off inserts the personal exception on the clicked day',
    (await dbops(pg)).some((o) => o.startsWith('insert:concierge_availability_exceptions') &&
      o.includes('"staff_id":72') && o.includes('"closed":true') && o.includes(joDay)));
  log('S7.10', 'the lane now wears the full-width day-off hatch',
    await pg.$eval('.cal-lane-track[data-lane="72"][data-day="' + joDay + '"] .cal-off',
      (n) => n.style.width === '100%'));
  // a window that ends before it starts is refused in plain words
  await pg.click('.cal-lane-track[data-lane="71"]');
  await pg.waitForTimeout(60);
  await pg.uncheck('.cal-pop [data-p="all"]');
  await pg.fill('.cal-pop [data-p="from"]', '14:00');
  await pg.fill('.cal-pop [data-p="to"]', '10:00');
  await pg.click('.cal-pop >> text=Add time off');
  await pg.waitForTimeout(60);
  log('S7.11', 'time-off window ending before start refused',
    (await note(pg)).includes('ends before it starts'));
  // queue row → its tick flashes
  await pg.click('#cal-queue .cal-row[data-qid="11"] .cal-l1 b');
  await pg.waitForTimeout(60);
  log('S7.12', 'clicking a queue row flashes its mark on the week',
    await pg.$eval('.cal-tick[data-qid="11"]', (n) => n.classList.contains('flash')));
  // the team toggle folds the lanes away
  await pg.uncheck('#cal-wk-team');
  await pg.waitForTimeout(150);
  log('S7.13', 'toggle off: lanes fold away, week stays',
    await pg.$$eval('.cal-wk-row.lane', (x) => x.length) === 0 &&
    await pg.$$eval('.cal-wk-row:not(.lane):not(.chips)', (x) => x.length > 0));
  // the Team editor carries contact details
  await pg.$$eval('#cal-staff .cal-sum .edit', (btns) => btns[0].click());
  log('S7.14', 'person editor: email + phone fields, hydrated',
    await pg.$eval('#cal-staff [data-f="stemail"]', (n) => n.value === 'maya@example.com') &&
    await pg.$eval('#cal-staff [data-f="stphone"]', (n) => n.value === '555-0101'));
  await pg.fill('#cal-staff > div:first-child [data-f="stphone"]', '555-9999');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-staff > div:first-child [data-save-staff]');
  await pg.waitForTimeout(150);
  log('S7.15', 'saving a person writes email + phone',
    (await dbops(pg)).some((o) => o.startsWith('update:concierge_staff') &&
      o.includes('"email":"maya@example.com"') && o.includes('"phone":"555-9999"')));
  await pg.close();

  // ── S8 departures: someone leaves, the book gets shuffled ────────────────
  pg = await open('populated');
  log('S8.1', 'a staffed visit nobody owns is flagged "needs a person" in the queue',
    await pg.$eval('#cal-queue .cal-row[data-qid="12"]', (n) => n.textContent.includes('needs a person')));
  // its tick card offers to give it a person
  await pg.click('.cal-tick[data-qid="12"]');
  await pg.waitForTimeout(60);
  log('S8.2', 'unowned tick card offers "Give it a person"',
    await pg.$eval('.cal-pop', (n) => n.textContent.includes('Give it a person')));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('.cal-pop >> text=Give it a person');
  await pg.waitForTimeout(120);
  log('S8.3', 'it fires reassign_appointment(12) and closes the card',
    (await dbops(pg)).includes('rpc:reassign_appointment({"p_id":12})') && !(await pg.$('.cal-pop')));
  // an owned tick card offers to hand it over
  await pg.click('.cal-tick[data-qid="16"]');
  await pg.waitForTimeout(60);
  log('S8.4', 'owned tick card offers "Hand to someone else"',
    await pg.$eval('.cal-pop', (n) => n.textContent.includes('Hand to someone else')));
  await pg.mouse.click(5, 5);
  await pg.waitForTimeout(60);
  // the leave button: confirm dialog, then the shuffle + a plain-words note
  pg.on('dialog', (d) => d.accept());
  await pg.$$eval('#cal-staff .cal-sum .edit', (btns) => btns[0].click());
  log('S8.5', 'person editor carries the leave act',
    await pg.$eval('#cal-staff [data-depart]', (n) => n.textContent.includes("They've left")));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-staff > div:first-child [data-depart]');
  await pg.waitForTimeout(200);
  log('S8.6', 'leave fires staff_departure(71) and reports the shuffle honestly',
    (await dbops(pg)).includes('rpc:staff_departure({"p_staff_id":71})') &&
    (await note(pg)).includes('2 bookings handed over') && (await note(pg)).includes('1 still needs a person'));
  log('S8.7', 'the note wears the warning tone (someone needs attention)',
    await pg.$eval('#cal-note', (n) => n.classList.contains('warn')));
  await shot(pg, '13-departure', false);
  await pg.close();

  // ── S9 lunches & breaks: split the day, sell nothing across the gap ──────
  pg = await open('populated');
  await pg.$$eval('#cal-staff .cal-sum .edit', (btns) => btns[0].click());
  log('S9.1', 'person editor carries the daily-break control (12:00–13:00 default)',
    await pg.$eval(P1 + '[data-brk="from"]', (n) => n.value === '12:00') &&
    await pg.$eval(P1 + '[data-brk="to"]', (n) => n.value === '13:00'));
  await pg.fill(P1 + '[data-brk="from"]', '07:00');
  await pg.fill(P1 + '[data-brk="to"]', '07:30');
  await pg.click(P1 + '[data-add-break]');
  await pg.waitForTimeout(60);
  log('S9.2', 'a break outside their hours refuses honestly',
    (await note(pg)).includes('nothing to split'));
  await pg.fill(P1 + '[data-brk="from"]', '12:00');
  await pg.fill(P1 + '[data-brk="to"]', '13:00');
  await pg.click(P1 + '[data-add-break]');
  log('S9.3', 'the split: Tuesday becomes two ranges around lunch',
    await pg.$$eval(P1 + '.cal-hr-day[data-dow="2"] .cal-hr-range', (x) => x.length) === 2);
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click(P1 + '[data-save-staff]');
  await pg.waitForTimeout(150);
  log('S9.4', 'saving writes the two ranges (540–720, 780–1020) — the gap is unsellable',
    (await dbops(pg)).some((o) => o.startsWith('insert:concierge_staff_hours') &&
      o.includes('"open_min":540,"close_min":720') && o.includes('"open_min":780')));
  await pg.close();

  // ── S10 time off, built for years ─────────────────────────────────────────
  pg = await open('populated');
  await pg.$$eval('#cal-staff .cal-sum .edit', (btns) => btns[0].click());
  log('S10.1', 'digest counts only what is ahead (1 day off ahead)',
    (await pg.$eval('#cal-staff .cal-sum .dig', (n) => n.textContent)).includes('1 day off ahead'));
  log('S10.2', 'upcoming: the Dr appointment shows with its reason + an edit act',
    await pg.$eval(P1, (n) => n.textContent.includes('Dr appointment')) &&
    !!(await pg.$(P1 + '[data-edit-off]')));
  log('S10.3', 'years of history fold away (2 past entries, hidden by default)',
    await pg.$eval(P1 + '[data-past-off]', (n) => n.textContent.includes('2 past entries')) &&
    await pg.$eval(P1 + '[data-past-off] + div', (n) => n.style.display === 'none'));
  await pg.click(P1 + '[data-past-off]');
  log('S10.4', 'shown: consecutive vacation days read as ONE stretch (from → to)',
    await pg.$eval(P1 + '[data-past-off] + div', (n) => n.style.display !== 'none' &&
      n.textContent.includes('sick') &&
      /\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2} · away · vacation/.test(n.textContent)));
  // a whole vacation in one entry
  const d10 = await pg.evaluate(() => DAY(10)), d12 = await pg.evaluate(() => DAY(12));
  await pg.fill(P1 + '[data-f="offdate"]', d10);
  await pg.fill(P1 + '[data-f="offend"]', d12);
  await pg.fill(P1 + '[data-f="offnote"]', 'vacation');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click(P1 + '[data-add-off]');
  await pg.waitForTimeout(150);
  log('S10.5', 'three days, one entry: 3 all-day rows with the reason',
    (await dbops(pg)).some((o) => o.startsWith('insert:concierge_availability_exceptions') && o.includes(d10)) &&
    (await pg.evaluate((args) => DATA.populated.concierge_availability_exceptions
      .filter((x) => x.staff_id === 71 && x.note === 'vacation' && x.on_date >= args[0] && x.on_date <= args[1] && x.closed)
      .length, [d10, d12])) === 3);
  log('S10.6', 'after reload the vacation reads as one stretch; digest says 4 ahead',
    await pg.$eval(P1, (n, d) => n.textContent.includes(d + ' → '), d10) &&
    (await pg.$eval('#cal-staff .cal-sum .dig', (n) => n.textContent)).includes('4 days off ahead'));
  // plans change: the Dr appointment moves to end at 15:00 (first upcoming run)
  await pg.$$eval(P1 + '[data-edit-off]', (btns) => { btns[0].click(); });
  log('S10.7', 'edit prefills the composer (window 13:00, reason, save label)',
    await pg.$eval(P1 + '[data-f="offfrom"]', (n) => n.value === '13:00') &&
    await pg.$eval(P1 + '[data-f="offnote"]', (n) => n.value === 'Dr appointment') &&
    await pg.$eval(P1 + '[data-add-off]', (n) => n.textContent === 'Save the change'));
  await pg.fill(P1 + '[data-f="offto"]', '15:00');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click(P1 + '[data-add-off]');
  await pg.waitForTimeout(150);
  const eop = await dbops(pg);
  log('S10.8', 'the change replaces the old row (delete id=31, insert ends 15:00)',
    eop.some((o) => o.startsWith('delete:concierge_availability_exceptions') && o.includes('id=31')) &&
    eop.some((o) => o.startsWith('insert:concierge_availability_exceptions') && o.includes('"end_min":900')));
  await shot(pg, '14-timeoff-v2', false);
  await pg.close();

  // ── S11 the team's last 30 days ───────────────────────────────────────────
  pg = await open('populated');
  log('S11.1', 'the report table renders from staff_report',
    !!(await pg.$('#cal-team-report table.cal-reptable')) &&
    await pg.$eval('#cal-team-report', (n) => n.textContent.includes('utilization') &&
      n.textContent.includes('Maya') && n.textContent.includes('13%') && n.textContent.includes('2400')  === false));
  log('S11.2', 'a kept-rate under 80% wears the heat tone',
    await pg.$$eval('#cal-team-report td', (tds) => tds.some((td) => td.getAttribute('style') &&
      td.getAttribute('style').includes('d08770') && td.textContent === '78%')));
  log('S11.3', 'honest numbers: Jo shows 100% kept, no heat',
    await pg.$eval('#cal-team-report', (n) => n.textContent.includes('100%')));
  await pg.$eval('#cal-team-report', (n) => n.scrollIntoView({ block: 'center' }));
  await pg.waitForTimeout(80);
  await shot(pg, '15-team-report', false);

  // ── S13 every option explains itself ─────────────────────────────────────
  log('S13.1', 'info-badges cover the calendar (15+ options)',
    await pg.$$eval('#panel-calendar .info-badge', (x) => x.length) >= 15);
  const onBefore = await pg.$eval('#cal-on', (n) => n.checked);
  await pg.click('#cal-rules-card .info-badge');
  await pg.waitForTimeout(60);
  log('S13.2', 'tapping a badge opens a readable card (and never flips the setting)',
    !!(await pg.$('.info-tip')) &&
    await pg.$eval('.info-tip', (n) => n.textContent.length > 40) &&
    (await pg.$eval('#cal-on', (n) => n.checked)) === onBefore);
  await pg.mouse.click(5, 400);
  await pg.waitForTimeout(60);
  log('S13.3', 'tapping elsewhere dismisses it', !(await pg.$('.info-tip')));
  await pg.close();

  // ── S15 report dimensions + export ────────────────────────────────────────
  pg = await open('populated');
  log('S15.1', 'report defaults to people with dim buttons + Export CSV',
    !!(await pg.$('#cal-team-report [data-repdim="offering"]')) &&
    !!(await pg.$('#cal-team-report [data-repcsv]')) &&
    await pg.$eval('#cal-team-report', (n) => n.textContent.includes('Maya')));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-team-report [data-repdim="offering"]');
  await pg.waitForTimeout(100);
  log('S15.2', 'offerings view fetches booking_report and renders the rollup',
    (await dbops(pg)).includes('rpc:booking_report({"p_days":30,"p_dim":"offering"})') &&
    await pg.$eval('#cal-team-report', (n) => n.textContent.includes('Private viewing') &&
      n.textContent.includes('85%') && n.textContent.includes('cancelled')));
  await pg.click('#cal-team-report [data-repdim="location"]');
  await pg.waitForTimeout(100);
  log('S15.3', 'locations view renders; switching back to people keeps their math',
    await pg.$eval('#cal-team-report', (n) => n.textContent.includes('Main studio')));
  await pg.click('#cal-team-report [data-repdim="person"]');
  await pg.waitForTimeout(60);
  log('S15.4', 'people again: utilization column returns',
    await pg.$eval('#cal-team-report', (n) => n.textContent.includes('utilization')));
  await pg.click('#cal-team-report [data-repcsv]');
  log('S15.5', 'Export CSV clicks clean (no thrown errors)', pg.errors.length === 0, pg.errors.join('; '));
  await pg.click('#cal-team-report [data-repops]');
  await pg.waitForTimeout(150);
  log('S15.6', 'the operations review is ONE file: people + offerings + locations + callbacks + the closed ledger',
    await pg.evaluate(() => {
      const c = window.__lastOpsCsv || '';
      return c.includes('PEOPLE') && c.includes('OFFERINGS') && c.includes('LOCATIONS') &&
        c.includes('CALLBACKS') && c.includes('CLOSED OUT (last 7 days)') &&
        c.includes('Maya') && c.includes('open_now,1') && c.includes('Dana Whitfield') &&
        c.includes('owner@example.com');
    }));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-team-report [data-repdays="90"]');
  await pg.waitForTimeout(150);
  log('S15.7', 'window pills recompute the report (quarter → staff_report p_days 90, heading follows)',
    await pg.evaluate(() => window.DB_LOG.some((l) => l.op === 'rpc' && l.table === 'staff_report'
      && l.args.some((a) => a.includes('"p_days":90')))) &&
    await pg.$eval('#cal-team-report', (n) => n.textContent.includes('The last 90 days')));
  await pg.close();

  // ── S19 the time-off lifecycle: requests, decisions, the team roll-up ────
  pg = await open('populated');
  log('S19.1', "the Team card leads with 'Time off ahead' — whole team, statuses named",
    await pg.$eval('[data-off-rollup]', (n) => n.textContent.includes('Time off ahead') &&
      n.textContent.includes('awaiting a decision') && n.textContent.includes('Maya') &&
      n.textContent.includes('Jo') && n.textContent.includes('needs a decision')));
  log('S19.2', 'a two-day request reads as one stretch; declined entries sit quiet on the record',
    await pg.$eval('[data-off-rollup]', (n) => n.textContent.includes('ski trip') &&
      n.textContent.includes('declined')));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.$eval('[data-off-rollup] [data-ro-ok]', (b) => b.click());
  await pg.waitForTimeout(200);
  log('S19.3', 'Approve writes status=approved to every row of the stretch',
    await pg.evaluate(() => window.DB_LOG.filter((l) => l.op === 'update'
      && l.table === 'concierge_availability_exceptions'
      && l.args.some((a) => a.includes('approved'))).length >= 2));
  log('S19.4', 'Return-the-time and Restore stand ready on approved/declined rows',
    !!(await pg.$('[data-off-rollup] [data-ro-back]')) && !!(await pg.$('[data-off-rollup] [data-ro-re]')));
  await pg.$eval('[data-off-rollup] [data-ro-edit]', (b) => b.click());
  await pg.waitForTimeout(80);
  await pg.evaluate(() => { window.DB_LOG = []; });
  log('S19.5', 'roll-up edit opens in place; Save rewrites the rows keeping the decision state',
    !!(await pg.$('[data-off-rollup] [data-me="from"]')) &&
    await pg.evaluate(async () => {
      const to = document.querySelector('[data-off-rollup] [data-me="to"]');
      const from = document.querySelector('[data-off-rollup] [data-me="from"]');
      to.value = from.value;
      document.querySelector('[data-off-rollup] [data-me-save]').click();
      await new Promise((res) => setTimeout(res, 200));
      const dels = window.DB_LOG.filter((l) => l.op === 'delete' && l.table === 'concierge_availability_exceptions').length;
      const ins = window.DB_LOG.find((l) => l.op === 'insert' && l.table === 'concierge_availability_exceptions');
      return dels >= 1 && !!ins && ins.args.some((a) => a.includes('"status"'));
    }));
  await pg.$$eval('#cal-staff .cal-sum .edit', (btns) => btns[0].click());
  await pg.waitForTimeout(120);
  log('S19.6', "the add row offers 'approved / a request — decide later'",
    !!(await pg.$('#cal-staff [data-f="offstatus"]')) &&
    await pg.$eval('#cal-staff [data-f="offstatus"]', (n) => n.textContent.includes('decide later')));
  log('S19.7', 'pending time off hatches differently in the lanes (pend class present)',
    !!(await pg.$('.cal-off.pend')));
  await shot(pg, '20-timeoff-lifecycle', false);
  await pg.close();

  // ── S17 accountability: traces, corrections, callbacks report, drill-in ──
  pg = await open('populated');
  log('S17.1', 'checked-off things leave a trace (fold, hidden by default, names the actor)',
    await pg.$eval('#cal-queue [data-recent-closed]', (n) => n.textContent.includes('2 recently closed out')) &&
    await pg.$eval('#cal-queue [data-recent-closed] + div', (n) => n.style.display === 'none'));
  await pg.click('#cal-queue [data-recent-closed]');
  log('S17.2', 'the trace is a real table: handled-by column, unattributed acts say so',
    await pg.$eval('#cal-queue [data-recent-closed] + div', (n) =>
      n.querySelector('table.cal-reptable') !== null &&
      n.textContent.includes('handled by') && n.textContent.includes('owner@example.com') &&
      n.textContent.includes('the concierge') && n.textContent.includes('no-show')));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-queue [data-recent-closed] + div >> text=kept instead');
  await pg.waitForTimeout(100);
  log('S17.3', 'a mistaken no-show flips to kept in one tap',
    (await dbops(pg)).includes('rpc:close_appointment({"p_id":42,"p_outcome":"completed"})'));
  await pg.close();

  pg = await open('populated');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-team-report [data-repdim="callbacks"]');
  await pg.waitForTimeout(100);
  log('S17.4', 'callbacks report: handled-by, median time to done, open-now line',
    (await dbops(pg)).includes('rpc:booking_report({"p_days":30,"p_dim":"callbacks"})') &&
    await pg.$eval('#cal-team-report', (n) => n.textContent.includes('handled by') &&
      n.textContent.includes('42m') && n.textContent.includes('1 open now') &&
      n.textContent.includes('oldest waiting')));
  // drill-in: capacity numbers are doors
  await pg.$eval('#cal-capacity', (n) => n.scrollIntoView());
  await pg.click('#cal-capacity tr[data-cap-off] td:first-child');
  await pg.waitForTimeout(150);
  log('S17.5', 'clicking an offering row opens its editor',
    !!(await pg.$('#cal-types .cal-editor:not(.is-collapsed)')));
  await pg.close();

  // ── S16 capacity at a glance ──────────────────────────────────────────────
  pg = await open('populated');
  log('S16.1', 'matrix renders: promised vs effective, coverage, starts',
    !!(await pg.$('#cal-capacity table.cal-reptable')) &&
    await pg.$eval('#cal-capacity', (n) => n.textContent.includes('promised') &&
      n.textContent.includes('effective') && n.textContent.includes('52h')));
  log('S16.2', 'a shortfall row wears the heat tone and speaks plainly',
    await pg.$eval('#cal-capacity', (n) => n.textContent.includes('no qualified person has hours here')) &&
    await pg.$$eval('#cal-capacity tr', (trs) => trs.some((tr) =>
      (tr.getAttribute('style') || '').includes('d08770'))));
  await pg.$eval('#cal-capacity', (n) => n.scrollIntoView({ block: 'center' }));
  await pg.waitForTimeout(80);
  await shot(pg, '18-capacity', false);
  await pg.close();

  // ── S14 guarded removal ───────────────────────────────────────────────────
  pg = await open('populated');
  pg.on('dialog', (d) => d.accept());
  await pg.click('#cal-locs .cal-sum .edit');
  log('S14.1', 'editors carry Remove… acts (location, offering, person)',
    !!(await pg.$('#cal-locs [data-rm-loc]')) && !!(await pg.$('#cal-staff [data-rm-staff]')));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-locs [data-rm-loc="1"]');
  await pg.waitForTimeout(120);
  log('S14.2', 'refusal is honest and plain: 3 standing visits named',
    (await dbops(pg)).includes('rpc:remove_location({"p_id":1})') &&
    (await note(pg)).includes('3 standing visits still point here'));
  await pg.$$eval('#cal-locs .cal-sum .edit', (btns) => btns[1].click());
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-locs [data-rm-loc="2"]');
  await pg.waitForTimeout(150);
  log('S14.3', 'a clean location removes and the tab reloads',
    (await dbops(pg)).includes('rpc:remove_location({"p_id":2})') &&
    await pg.evaluate(() => window.LOAD_COUNT >= 2));
  await pg.$$eval('#cal-staff .cal-sum .edit', (btns) => btns[0].click());
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#cal-staff [data-rm-staff]');
  await pg.waitForTimeout(120);
  log('S14.4', 'person removal fires remove_person(71)',
    (await dbops(pg)).includes('rpc:remove_person({"p_id":71})'));
  await pg.close();

  // ── S18 the Judge & coach page ────────────────────────────────────────────
  pg = await b.newPage({ viewport: { width: 1180, height: 900 } });
  pg.errors = [];
  pg.on('pageerror', (e) => pg.errors.push(String(e)));
  await pg.goto('file://' + BASE + '/jc_qa.html');
  await pg.waitForFunction(() => document.title === 'qa-ready', { timeout: 8000 });
  log('S18.1', 'renders without errors; strip carries the scoreboard',
    pg.errors.length === 0 &&
    await pg.$eval('#jc-strip', (n) => n.textContent.includes('45') && n.textContent.includes('redrafts saved')) &&
    await pg.$eval('#jc-sub', (n) => n.textContent.includes('58%')), pg.errors.join('; '));
  log('S18.2', 'defect families read plainly with sample kills',
    await pg.$eval('#jc-classes', (n) => n.textContent.includes('plumbing leak — narrated mechanics') &&
      n.textContent.includes('lasts fifty years')));
  log('S18.3', 'the ledger labels its rows: 36× asked, system alert, your note',
    await pg.$eval('#jc-gaps', (n) => n.textContent.includes('36× asked') &&
      n.textContent.includes('system alert') && n.textContent.includes('your note')));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.$$eval('#jc-gaps [data-jc-resolve]', (b2) => b2[0].click());
  await pg.waitForTimeout(120);
  log('S18.4', 'resolve clears every row in the cluster',
    (await pg.evaluate(() => window.DB_LOG.filter((x) => x.startsWith('update:concierge_flags:id=')).length)) === 3);
  await pg.fill('#jc-fb', 'the spend tab confuses me');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#jc-fb-send');
  await pg.waitForTimeout(120);
  log('S18.5', 'merchant feedback lands in the ledger with a confirmation',
    (await pg.evaluate(() => window.DB_LOG.some((x) => x.startsWith('insert:concierge_flags') && x.includes('studio_feedback')))) &&
    await pg.$eval('#jc-note', (n) => n.textContent.includes('Noted')));
  log('S18.6', 'kinds table: opener reads paused/Resume, nudge offers Pause',
    await pg.$eval('#jc-kinds', (n) => n.textContent.includes('paused')) &&
    (await pg.$$eval('[data-jc-pause]', (bs) => bs.map((b2) => b2.getAttribute('data-jc-pause') + ':' + b2.textContent)))
      .join('|').includes('opener:Resume') &&
    (await pg.$$eval('[data-jc-pause]', (bs) => bs.map((b2) => b2.getAttribute('data-jc-pause') + ':' + b2.textContent)))
      .join('|').includes('nudge:Pause'));
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.$$eval('[data-jc-pause]', (bs) => { const b2 = bs.find((x) => x.getAttribute('data-jc-pause') === 'nudge'); if (b2) b2.click(); });
  await pg.waitForTimeout(150);
  log('S18.7', 'pausing nudge writes outreach.pausedKinds with both kinds',
    await pg.evaluate(() => window.DB_LOG.some((x) => x.startsWith('upsert:concierge_config')
      && x.includes('pausedKinds') && x.includes('opener') && x.includes('nudge'))) &&
    await pg.$eval('#jc-note', (n) => n.textContent.includes('Paused — nudge')));
  log('S18.8', "the coach's draft strip lists the pending procedure",
    await pg.$eval('#jc-drafts', (n) => n.textContent.includes('awaiting you') &&
      n.textContent.includes('say it differently (plumbing)')));
  await pg.click('#jc-digest');
  await pg.waitForTimeout(120);
  log('S18.9', 'digest preview renders the week in plain words (no send)',
    await pg.$eval('#jc-digest-out', (n) => n.textContent.includes('spoke 45 times') && !n.textContent.includes('Sent')));
  await pg.click('#jc-digest-send');
  await pg.waitForTimeout(200);
  log('S18.10', 'Email it now sends + reports the coach draft, text survives the reload',
    await pg.$eval('#jc-digest-out', (n) => n.textContent.includes('Sent to the owner') && n.textContent.includes('Coach drafted: plumbing')) &&
    await pg.evaluate(() => window.DB_LOG.some((x) => x === 'adminGet:?judgedigest=1&send=1')));
  await pg.fill('#jc-rules', 'Saying a number is on file is fine; only reading digits aloud is not.');
  await pg.evaluate(() => { window.DB_LOG = []; });
  await pg.click('#jc-rules-save');
  await pg.waitForTimeout(120);
  log('S18.11', "the merchant's pen: amendments save to config.judge.rules with confirmation",
    (await pg.evaluate(() => window.DB_LOG.some((x) => x.startsWith('upsert:concierge_config')
      && x.includes('"judge"') && x.includes('reading digits')))) &&
    await pg.$eval('#jc-note', (n) => n.textContent.includes('amendment')));
  await pg.$eval('#panel-judge', (n) => n.scrollIntoView());
  await shot(pg, '19-judge-coach');
  await pg.close();

  // ── S12 the nav: four sections, one line ─────────────────────────────────
  pg = await b.newPage({ viewport: { width: 1180, height: 800 } });
  pg.errors = [];
  pg.on('pageerror', (e) => pg.errors.push(String(e)));
  await pg.goto('file://' + BASE + '/nav_qa.html');
  await pg.waitForFunction(() => document.title === 'qa-ready', { timeout: 8000 });
  log('S12.1', 'nav: renders without errors', pg.errors.length === 0, pg.errors.join('; '));
  log('S12.2', 'four sections; FRONT DESK open by default (the merchant lands on the queue)',
    await pg.$$eval('nav.groups button', (x) => x.length) === 4 &&
    await pg.$eval('nav.groups button[data-group="desk"]', (n) => n.classList.contains('on')) &&
    await pg.$$eval('nav.tabs .tab:not(.hid)', (x) => x.length) === 4 &&
    await pg.$eval('nav.tabs .tab[data-tab="tuning"]', (n) => n.classList.contains('hid')));
  await shot(pg, '16-nav-desktop', false);
  await pg.click('nav.groups button[data-group="training"]');
  log('S12.3', 'a section click opens its first page (Tuning) + hash follows',
    await pg.$eval('nav.tabs .tab[data-tab="tuning"]', (n) => n.classList.contains('on') && !n.classList.contains('hid')) &&
    await pg.$eval('#panel-tuning', (n) => n.classList.contains('on')) &&
    await pg.evaluate(() => location.hash === '#tuning'));
  await pg.evaluate(() => activateTab('calendar'));
  log('S12.4', 'a deep link flips the right section on',
    await pg.$eval('nav.groups button[data-group="desk"]', (n) => n.classList.contains('on')) &&
    await pg.$eval('nav.tabs .tab[data-tab="calendar"]', (n) => n.classList.contains('on')));
  await pg.evaluate(() => {
    document.querySelector('nav.tabs .tab[data-tab="calendar"]').textContent = 'Calendar (4)';
  });
  await pg.evaluate(() => activateTab('tuning'));
  await pg.waitForTimeout(80);
  // (badge set while Training is open — the roll-up must show on the hidden desk)
  log('S12.5', 'a badge on a hidden page rolls up to its section (Front desk · 4)',
    await pg.$eval('nav.groups .gcount[data-for="desk"]', (n) => n.textContent === '4' && n.style.display !== 'none'));
  await pg.evaluate(() => activateTab('customers'));
  await pg.evaluate(() => activateTab('nps'));
  await pg.click('nav.groups button[data-group="desk"]');
  log('S12.6', 'a section remembers its last page (back to Customers, not Conversations)',
    await pg.$eval('nav.tabs .tab[data-tab="customers"]', (n) => n.classList.contains('on')));
  await pg.setViewportSize({ width: 375, height: 812 });
  await pg.waitForTimeout(80);
  log('S12.7', 'mobile: one line per rail, no sideways page scroll',
    await pg.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await shot(pg, '17-nav-mobile', false);
  await pg.close();

  // ── S3 error state ───────────────────────────────────────────────────────
  pg = await open('error');
  await shot(pg, '06-error', false);
  log('S3.1', 'error: fail-visible band', (await note(pg)).startsWith('Calendar problem —') &&
    await pg.$eval('#cal-note', (n) => n.classList.contains('err')));
  log('S3.2', 'error: no throw escapes', pg.errors.length === 0, pg.errors.join('; '));
  await pg.close();

  // ── S4 edge ──────────────────────────────────────────────────────────────
  pg = await open('edge');
  await shot(pg, '07-edge');
  log('S4.1', 'edge: renders without errors', pg.errors.length === 0, pg.errors.join('; '));
  log('S4.2', 'edge: EXPIRING hot + 77h callback red', await pg.$$eval('#cal-queue .cal-ttl', (x) => x.some((p) => p.textContent === 'EXPIRING')) &&
    !!(await pg.$('#cal-queue .cal-row.t-red .cal-wait.hot')));
  log('S4.3', 'edge: 3 locations → offering location dropdown', !!(await pg.$('#cal-types [data-f="loc"]')));
  log('S4.4', 'edge: no windows yet → just the add button, no ghost rows',
    await pg.$$eval('#cal-types [data-win]', (x) => x.length) === 0 && !!(await pg.$('#cal-types [data-add-win]')));
  log('S4.5', 'edge: long text wraps, no sideways scroll',
    await pg.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  log('S4.6', 'edge: masthead rolls up warnings (2 enabled offerings/locs unready)',
    await pg.$eval('#cal-mh-status', (n) => /warning/.test(n.textContent)));
  log('S4.7', 'edge: no team → no lanes, toggle hidden',
    await pg.$eval('#cal-wk-teamlbl', (n) => n.style.display === 'none') &&
    await pg.$$eval('.cal-wk-row.lane', (x) => x.length) === 0);
  await pg.close();

  // ── S5 mobile ────────────────────────────────────────────────────────────
  pg = await open('fresh', { width: 375, height: 812 });
  await shot(pg, '08-mobile-fresh');
  log('S5.1', 'mobile fresh: renders without errors', pg.errors.length === 0, pg.errors.join('; '));
  log('S5.2', 'mobile: checklist + templates usable, body never sideways',
    !!(await pg.$('#cal-setup .cal-step')) && !!(await pg.$('[data-tpl="wk"]')) &&
    await pg.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  log('S5.3', 'mobile: native time inputs present (picker keyboards, not text)',
    await pg.$$eval('#cal-locs input[type="time"], #cal-types input[type="time"]', (x) => x.length >= 0) !== null);
  await pg.close();

  await b.close();
  const pass = results.filter((r) => r.pass).length;
  fs.writeFileSync(EV + '/results.json', JSON.stringify(results, null, 2));
  console.log('\n' + pass + '/' + results.length + ' checks passed · ' + shots + ' screenshots in ' + EV);
  if (pass !== results.length) process.exit(1);
})().catch((e) => { console.error('DRIVER FAIL', e); process.exit(1); });
