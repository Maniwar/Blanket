/* ============================================================
   FEIERABEND — DECKE 01
   The Commission · assets/checkout.js
   Self-contained. No dependencies. Loaded with defer, after
   assets/concierge.js. All classes and ids are prefixed 'ck-'.
   Public API: window.FeierabendCheckout = { open(), close() }

   One sheet, three acts, a register card at the end.
   This is a concept demonstration — no payment is ever taken,
   no product exists, nothing will ship. The sheet says so.
   ============================================================ */
(function () {
  'use strict';

  if (window.FeierabendCheckout) { return; }
  if (!document || !document.createElement) { return; }

  /* ----------------------------------------------------------
     0. Configuration & defensive reads
  ---------------------------------------------------------- */
  function cfg() {
    var c = window.FEIER_CONCIERGE_CONFIG;
    return (c && typeof c === 'object') ? c : {};
  }
  function conciergeEndpoint() {
    var e = cfg().endpoint;
    return (typeof e === 'string') ? e.replace(/^\s+|\s+$/g, '') : '';
  }
  function commissionEndpoint() {
    var e = conciergeEndpoint();
    if (!e) { return ''; }
    if (/concierge$/.test(e)) { return e.replace(/concierge$/, 'commission'); }
    return e;
  }
  function isDemo() { return !commissionEndpoint(); }
  function visitKey() {
    try {
      var k = window.localStorage.getItem('feier-visit');
      return (k && /^[A-Za-z0-9_-]{8,64}$/.test(k)) ? k : '';
    } catch (eK) { return ''; }
  }
  /* the concierge's session, only when a conversation actually happened */
  function chatKey() {
    try {
      var h = JSON.parse(window.sessionStorage.getItem('cx-history') || '[]');
      if (!h || !h.length) { return ''; }
      var k = window.sessionStorage.getItem('cx-skey');
      return (k && /^[A-Za-z0-9_-]{8,64}$/.test(k)) ? k : '';
    } catch (eC) { return ''; }
  }
  /* Attribution tier for this order. 'concierge' = the sheet was opened from the
     concierge's own commission button (the marker concierge.js stamps on that
     click, honoured for 2 hours so a slow, considered checkout still counts);
     'ambient' = a conversation existed this tab session but the sheet was opened
     from a page button. Distinguishes "the chat drove this" from "a chat
     happened" — the number the merchant optimizes on. */
  function chatVia() {
    if (!chatKey()) { return ''; }
    try {
      var m = JSON.parse(window.sessionStorage.getItem('cx-commission-via') || 'null');
      if (m && typeof m.ts === 'number' && (Date.now() - m.ts) < 2 * 3600000) { return 'concierge'; }
    } catch (eV) { /* fall through */ }
    return 'ambient';
  }
  /* Context captured at the commission-button click (entry beat, page section,
     conversation depth) — only meaningful for a 'concierge' attribution. */
  function chatMeta() {
    if (chatVia() !== 'concierge') { return null; }
    try {
      var m = JSON.parse(window.sessionStorage.getItem('cx-commission-via') || 'null');
      if (!m) { return null; }
      return {
        entry: (typeof m.entry === 'string') ? m.entry.slice(0, 40) : undefined,
        section: (typeof m.section === 'string') ? m.section.slice(0, 32) : undefined,
        turns: (typeof m.turns === 'number') ? m.turns : undefined
      };
    } catch (eM) { return null; }
  }
  /* One order, one click: once an order is recorded the marker must not leak
     onto a later, unrelated commission made from a page button. */
  function clearChatVia() {
    try { window.sessionStorage.removeItem('cx-commission-via'); } catch (eX) { /* ignore */ }
  }
  /* Funnel beacon: the register sheet opened (?track=1, PII-free — see
     ATTRIBUTION.md). via records whether the concierge's own button opened it.
     Fire-and-forget; a beacon must never affect checkout. */
  function trackOpen() {
    try {
      var url = conciergeEndpoint();
      if (!url) { return; }
      var body = { kind: 'checkout_open', visit_key: visitKey(), via: chatVia() === 'concierge' ? 'concierge' : 'page' };
      var k = chatKey(); if (k) { body.session_key = k; }
      fetch(url + (url.indexOf('?') === -1 ? '?track=1' : '&track=1'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        keepalive: true, body: JSON.stringify(body)
      })['catch'](function () { /* nothing to recover */ });
    } catch (eT) { /* never breaks checkout */ }
  }
  /* re-confirm the visit's held number whenever the sheet opens */
  function refreshHold() {
    var e = commissionEndpoint();
    var k = visitKey();
    if (!e || !k) { return; }
    try {
      fetch(e + '?hold=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_key: k })
      })['catch'](function () { /* the page's own cycle will retry */ });
    } catch (eH) { /* ignore */ }
  }

  /* Sold out: record the visitor on the waitlist (their entry is already filled). */
  function joinWaitlist(btn, sysline) {
    if (!btn || btn.disabled) { return; }
    var e = commissionEndpoint();
    if (!e) { return; }
    btn.disabled = true;
    try {
      fetch(e + '?waitlist=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: order.email, name: order.name,
          colorway: order.colorway, source: 'sold_out'
        })
      }).then(function (res) {
        if (res.ok) {
          if (sysline) { sysline.textContent = 'You’re on the waitlist — I’ll write to ' + (order.email || 'you') + ' when the next edition opens.'; }
          if (btn.parentNode) { btn.parentNode.removeChild(btn); }
        } else {
          btn.disabled = false;
          if (sysline) { sysline.textContent = 'Could not add you just now — try once more.'; }
        }
      })['catch'](function () { btn.disabled = false; });
    } catch (eW) { btn.disabled = false; }
  }

  function feierState() {
    var s = window.__feierState;
    return (s && typeof s === 'object') ? s : {};
  }
  function slotLabel() {
    var s = feierState();
    return (s.slot != null && String(s.slot)) ? String(s.slot) : '14,215';
  }
  function demoSerial() {
    var n = parseInt(String(feierState().slot).replace(/,/g, ''), 10);
    return n || 14215;
  }
  function ordinal(n) {
    var v = n % 100;
    if (v >= 11 && v <= 13) { return n + 'th'; }
    switch (n % 10) {
      case 1: return n + 'st';
      case 2: return n + 'nd';
      case 3: return n + 'rd';
      default: return n + 'th';
    }
  }
  function tierFor(n) {
    if (n >= 5) { return 'Stifter'; }
    if (n >= 3) { return 'Hausfreund'; }
    if (n === 2) { return 'Wiederkehr'; }
    return 'Eintrag';
  }
  function fmtSerial(n) {
    var s = String(n), out = '', i, c = 0;
    for (i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      c++;
      if (c % 3 === 0 && i > 0) { out = ',' + out; }
    }
    return out;
  }

  var REDUCED = false;
  try {
    var mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq) {
      REDUCED = !!mq.matches;
      var onMq = function (e) { REDUCED = !!e.matches; syncReduced(); };
      if (mq.addEventListener) { mq.addEventListener('change', onMq); }
      else if (mq.addListener) { mq.addListener(onMq); }
    }
  } catch (e0) { /* ignore */ }

  /* ----------------------------------------------------------
     0b. Fixed data — colorways & states. Client-side truth.
  ---------------------------------------------------------- */
  var STAMP_SRC = 'assets/concierge-stamp.webp';
  var PRICE_LINE = '$589 — demo, not charged';
  var DEMO_LINE = 'Concept demonstration — no payment is taken, no product exists, nothing will ship.';
  var ERR_LINE = 'The register is briefly unavailable. Nothing was recorded — try again.';

  var COLORWAYS = [
    { id: 'ungefaerbt', name: 'Ungefärbt', desc: 'Undyed fleece', tone: '#E8E2D4' },
    { id: 'loden',      name: 'Loden',     desc: 'Alder-bark dye', tone: '#26332B' },
    { id: 'graphit',    name: 'Graphit',   desc: 'Walnut-hull dye', tone: '#3A3D3A' }
  ];
  /* Each cloth carries its own certificate frame, seal photograph, and light */
  var CARD_ART = {
    ungefaerbt: { frame: 'img/card-ungefaerbt.webp', seal: 'img/seal-ungefaerbt.webp',
                  film: 'img/seal-ungefaerbt.mp4',
                  bg: '#1B1712', mote: '233,226,212', flare: '232,226,212' },
    loden:      { frame: 'img/card-engraving.webp',  seal: 'img/seal-loden.webp',
                  film: 'img/seal-loden.mp4',
                  bg: '#141b16', mote: '214,178,122', flare: '196,155,91' },
    graphit:    { frame: 'img/card-graphit.webp',    seal: 'img/seal-graphit.webp',
                  film: 'img/seal-graphit.mp4',
                  bg: '#131514', mote: '168,173,169', flare: '186,191,187' }
  };
  function cardArt() { return CARD_ART[order.colorway] || CARD_ART.loden; }

  function colorwayById(id) {
    var i;
    for (i = 0; i < COLORWAYS.length; i++) {
      if (COLORWAYS[i].id === id) { return COLORWAYS[i]; }
    }
    return null;
  }

  var STATES = [
    ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
    ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
    ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
    ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
    ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
    ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
    ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
    ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
    ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
    ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
    ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'],
    ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
    ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming']
  ];
  function stateName(code) {
    var i;
    for (i = 0; i < STATES.length; i++) {
      if (STATES[i][0] === code) { return STATES[i][1]; }
    }
    return code;
  }
  function isValidState(code) {
    var i;
    for (i = 0; i < STATES.length; i++) {
      if (STATES[i][0] === code) { return true; }
    }
    return false;
  }

  /* ----------------------------------------------------------
     1. Styles — glass loden, above the concierge (z 90+)
  ---------------------------------------------------------- */
  function injectStyle() {
    var css = [
      ':root{--ck-glass:rgba(23,31,26,.94);--ck-hair:rgba(196,155,91,.35);--ck-hair-soft:rgba(196,155,91,.18);',
      '--ck-ink:var(--wool,#F1ECE2);--ck-brass:var(--brass,#A67C3D);--ck-brass-soft:var(--brass-soft,#C49B5B);}',

      /* ---------- scrim ---------- */
      '.ck-scrim{position:fixed;inset:0;z-index:90;background:rgba(23,31,26,.4);',
      'opacity:0;pointer-events:none;transition:opacity .35s ease;}',
      '.ck-scrim.ck-on{opacity:1;pointer-events:auto;}',

      /* ---------- panel ---------- */
      '.ck-panel{position:fixed;z-index:91;display:flex;flex-direction:column;',
      'background:var(--ck-glass);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);',
      'color:var(--ck-ink);visibility:hidden;}',
      '.ck-panel:focus{outline:none;}',

      '@media (max-width:899px){',
      '.ck-panel{left:0;right:0;bottom:0;height:86svh;max-height:100svh;border-radius:14px 14px 0 0;',
      'border-top:1px solid var(--ck-hair);transform:translateY(105%);',
      'transition:transform .5s cubic-bezier(.22,.8,.28,1),visibility 0s linear .5s;}',
      '.ck-panel.ck-open{transform:translateY(0);visibility:visible;',
      'transition:transform .5s cubic-bezier(.22,.8,.28,1);}',
      '.ck-panel.ck-dragging{transition:none;}',
      '.ck-handle{flex:0 0 auto;padding:.55rem 0 .2rem;display:flex;justify-content:center;cursor:grab;touch-action:none;}',
      '.ck-handle::before{content:"";width:38px;height:3px;border-radius:2px;background:rgba(196,155,91,.45);}',
      '.ck-head{padding:.3rem 1.4rem .7rem;}',
      '}',

      '@media (min-width:900px){',
      '.ck-panel{top:0;right:0;bottom:0;width:460px;border-left:1px solid var(--ck-hair);',
      'transform:translateX(105%);transition:transform .5s cubic-bezier(.22,.8,.28,1),visibility 0s linear .5s;}',
      '.ck-panel.ck-open{transform:translateX(0);visibility:visible;',
      'transition:transform .5s cubic-bezier(.22,.8,.28,1);}',
      '.ck-handle{display:none;}',
      '.ck-head{padding:1.15rem 1.6rem .8rem;}',
      '}',

      /* ---------- header ---------- */
      '.ck-head{flex:0 0 auto;display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;}',
      '.ck-headleft{flex:1 1 auto;min-width:0;}',
      '.ck-title{font-family:"Gloock",serif;font-weight:400;font-size:1.28rem;line-height:1.2;',
      'color:var(--ck-ink);margin:0;}',
      '.ck-sub{display:flex;align-items:center;gap:.5rem;margin-top:.35rem;',
      'font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.22em;',
      'text-transform:uppercase;color:rgba(241,236,226,.55);white-space:nowrap;overflow:hidden;}',
      '.ck-close{flex:0 0 auto;width:44px;height:44px;margin:-.45rem -.7rem 0 0;',
      'display:flex;align-items:center;justify-content:center;background:none;border:none;',
      'color:rgba(241,236,226,.65);font-size:1.25rem;line-height:1;cursor:pointer;',
      'font-family:"Hanken Grotesk",sans-serif;}',
      '.ck-close:hover{color:var(--ck-ink);}',
      '.ck-close:focus-visible{outline:1px solid var(--ck-brass-soft);outline-offset:2px;}',

      /* ---------- progress thread — brass line, three knots ---------- */
      '.ck-thread{flex:0 0 auto;display:flex;align-items:center;padding:.35rem 1.6rem .9rem;}',
      '.ck-seg{flex:1 1 auto;height:1px;background:var(--ck-hair-soft);transition:background .5s ease;}',
      '.ck-seg.ck-done{background:var(--ck-hair);}',
      '.ck-knot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;',
      'border:1px solid var(--ck-hair);background:transparent;',
      'transition:background .5s ease,border-color .5s ease,box-shadow .5s ease;}',
      '.ck-knot.ck-done{border-color:var(--ck-brass-soft);background:var(--ck-brass-soft);}',
      '.ck-knot.ck-now{border-color:var(--ck-brass-soft);background:var(--ck-brass-soft);',
      'box-shadow:0 0 8px rgba(196,155,91,.55);}',
      '.ck-threadcap{flex:0 0 auto;margin-left:.8rem;font-family:"IBM Plex Mono",monospace;',
      'font-size:.56rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(241,236,226,.45);}',

      /* ---------- body / acts ---------- */
      '.ck-body{flex:1 1 auto;position:relative;overflow-y:auto;overflow-x:hidden;',
      '-webkit-overflow-scrolling:touch;overscroll-behavior:contain;}',
      '.ck-act{padding:.4rem 1.6rem calc(1.6rem + env(safe-area-inset-bottom,0px));outline:none;}',
      '.ck-act.ck-slide{transition:transform .38s cubic-bezier(.22,.8,.28,1),opacity .38s ease;}',
      '.ck-act.ck-out{position:absolute;top:0;left:0;right:0;pointer-events:none;}',
      '.ck-kicker{font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.26em;',
      'text-transform:uppercase;color:rgba(241,236,226,.5);margin:.6rem 0 .4rem;}',
      '.ck-lede{font-family:"Hanken Grotesk",sans-serif;font-weight:300;font-size:.92rem;',
      'line-height:1.6;color:rgba(241,236,226,.78);margin:0 0 1.2rem;}',

      /* allocation line */
      '.ck-alloc{display:flex;align-items:center;gap:.55rem;margin:.2rem 0 1rem;',
      'font-family:"IBM Plex Mono",monospace;font-size:.62rem;letter-spacing:.22em;',
      'text-transform:uppercase;color:var(--ck-brass-soft);}',
      '.ck-alloc i{font-style:normal;font-size:.8rem;line-height:1;}',

      /* ---------- act 1 — swatches ---------- */
      '.ck-swatches{display:flex;flex-direction:column;gap:.85rem;margin:0 0 1.4rem;}',
      '.ck-swatch{position:relative;display:flex;align-items:center;gap:1rem;width:100%;',
      'min-height:44px;padding:.85rem;background:rgba(241,236,226,.02);text-align:left;',
      'border:1px solid var(--ck-hair-soft);border-radius:2px;cursor:pointer;',
      'color:var(--ck-ink);transition:border-color .3s ease,background .3s ease;}',
      '.ck-swatch:hover{border-color:var(--ck-hair);}',
      '.ck-swatch:focus-visible{outline:1px solid var(--ck-brass-soft);outline-offset:3px;}',
      '.ck-swatch.ck-sel{border-color:var(--ck-brass-soft);background:rgba(196,155,91,.06);}',
      '.ck-swimg{position:relative;flex:0 0 auto;width:84px;height:64px;',
      'background-size:cover;background-position:center;border:1px solid var(--ck-hair-soft);}',
      '.ck-swimg::after{content:"";position:absolute;inset:6px;',
      'border:1px dashed rgba(241,236,226,.4);mix-blend-mode:overlay;pointer-events:none;}',
      '.ck-swtext{flex:1 1 auto;min-width:0;}',
      '.ck-swname{font-family:"Hanken Grotesk",sans-serif;font-weight:300;font-size:1.02rem;',
      'line-height:1.3;color:var(--ck-ink);}',
      '.ck-swdesc{margin-top:.3rem;font-family:"IBM Plex Mono",monospace;font-size:.58rem;',
      'letter-spacing:.2em;text-transform:uppercase;color:rgba(241,236,226,.5);}',
      '.ck-swmark{flex:0 0 auto;width:1.1rem;color:var(--ck-brass-soft);font-size:.85rem;',
      'line-height:1;text-align:center;opacity:0;transition:opacity .3s ease;}',
      '.ck-swatch.ck-sel .ck-swmark{opacity:1;}',

      /* ---------- buttons ---------- */
      '.ck-primary{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;',
      'min-height:52px;padding:1.05rem 1.4rem;background:var(--ck-brass-soft);color:#171F1A;',
      'border:1px solid var(--ck-brass-soft);border-radius:2px;cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.68rem;letter-spacing:.22em;',
      'text-transform:uppercase;transition:background .3s ease,border-color .3s ease,opacity .3s ease;}',
      '.ck-primary:hover:not(:disabled){background:#D3AC6F;border-color:#D3AC6F;}',
      '.ck-primary:disabled{opacity:.4;cursor:default;}',
      '.ck-primary:focus-visible{outline:1px solid var(--ck-brass-soft);outline-offset:3px;}',
      '.ck-backrow{display:flex;align-items:center;gap:1rem;margin-top:.9rem;}',
      '.ck-back{background:none;border:none;min-height:44px;padding:.6rem .2rem;cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.2em;',
      'text-transform:uppercase;color:rgba(241,236,226,.55);}',
      '.ck-back:hover{color:var(--ck-ink);}',
      '.ck-back:focus-visible{outline:1px solid var(--ck-brass-soft);outline-offset:2px;}',

      /* weaving dots (streaming state on the confirm button) */
      '.ck-dots{display:inline-flex;gap:6px;align-items:center;}',
      '.ck-dots i{width:3px;height:3px;border-radius:50%;background:#171F1A;',
      'animation:ckWeave 1.1s ease-in-out infinite;}',
      '.ck-dots i:nth-child(2){animation-delay:.18s;}',
      '.ck-dots i:nth-child(3){animation-delay:.36s;}',
      '@keyframes ckWeave{0%,100%{transform:translateY(0);opacity:.4;}50%{transform:translateY(-4px);opacity:1;}}',

      /* ---------- act 2 — fields ---------- */
      '.ck-fields{display:flex;flex-direction:column;gap:1.15rem;margin:0 0 1.2rem;}',
      '.ck-field{display:flex;flex-direction:column;}',
      '.ck-label{font-family:"IBM Plex Mono",monospace;font-size:.58rem;letter-spacing:.22em;',
      'text-transform:uppercase;color:rgba(241,236,226,.55);margin-bottom:.3rem;}',
      '.ck-input,.ck-select{width:100%;background:transparent;border:none;',
      'border-bottom:1px solid var(--ck-hair-soft);border-radius:0;color:var(--ck-ink);',
      'font-family:"Hanken Grotesk",sans-serif;font-weight:300;font-size:16px;line-height:1.4;',
      'padding:.45rem 0;min-height:44px;}',
      '.ck-input:focus,.ck-select:focus{outline:none;border-bottom-color:var(--ck-hair);}',
      '.ck-input::placeholder{font-family:"IBM Plex Mono",monospace;font-size:.66rem;',
      'letter-spacing:.14em;text-transform:uppercase;color:rgba(241,236,226,.3);}',
      '.ck-select{color-scheme:dark;-webkit-appearance:none;appearance:none;cursor:pointer;',
      'background-image:linear-gradient(45deg,transparent 50%,rgba(196,155,91,.7) 50%),',
      'linear-gradient(135deg,rgba(196,155,91,.7) 50%,transparent 50%);',
      'background-position:calc(100% - 11px) 55%,calc(100% - 6px) 55%;',
      'background-size:5px 5px,5px 5px;background-repeat:no-repeat;}',
      '.ck-select option{background:#1A231E;color:#F1ECE2;}',
      '.ck-select.ck-empty{color:rgba(241,236,226,.45);}',
      '.ck-err{display:none;margin-top:.35rem;font-family:"IBM Plex Mono",monospace;',
      'font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;line-height:1.6;',
      'color:var(--danger,#B4564A);}',
      '.ck-err.ck-on{display:block;}',
      '.ck-field.ck-invalid .ck-input,.ck-field.ck-invalid .ck-select{',
      'border-bottom-color:rgba(180,86,74,.55);}',

      /* saved-address book (returning patron) */
      '.ck-book{margin:0 0 1.5rem;}',
      '.ck-book-lbl{font-family:"IBM Plex Mono",monospace;font-size:.58rem;letter-spacing:.22em;',
      'text-transform:uppercase;color:rgba(241,236,226,.55);margin-bottom:.6rem;}',
      '.ck-book-row{display:flex;flex-wrap:wrap;gap:.5rem;}',
      '.ck-book-chip{display:flex;flex-direction:column;gap:3px;text-align:left;cursor:pointer;',
      'background:rgba(196,155,91,.06);border:1px solid var(--ck-hair-soft);border-radius:11px;',
      'padding:.55rem .75rem;min-width:130px;max-width:210px;color:var(--ck-ink);',
      'font-family:"Hanken Grotesk",sans-serif;transition:border-color .25s ease,background .25s ease;}',
      '.ck-book-chip:hover{border-color:var(--ck-hair);background:rgba(196,155,91,.12);}',
      '.ck-book-chip.ck-on{border-color:var(--ck-brass,#A67C3D);background:rgba(196,155,91,.17);}',
      '.ck-book-tag{font-family:"IBM Plex Mono",monospace;font-size:.56rem;letter-spacing:.14em;',
      'text-transform:uppercase;color:var(--ck-brass-soft);}',
      '.ck-book-line{font-size:.78rem;line-height:1.35;color:rgba(241,236,226,.82);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px;}',
      '.ck-book-new .ck-book-tag{color:rgba(241,236,226,.5);}',
      '.ck-book-rm{margin-top:.5rem;background:none;border:none;cursor:pointer;padding:0;',
      'font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.12em;text-transform:uppercase;',
      'color:rgba(180,86,74,.85);border-bottom:1px solid transparent;}',
      '.ck-book-rm:hover{border-bottom-color:rgba(180,86,74,.85);}',

      /* notice-at-collection + demo line */
      '.ck-notice{margin:.2rem 0 0;font-family:"IBM Plex Mono",monospace;font-size:.62rem;',
      'letter-spacing:.08em;line-height:1.8;color:var(--ck-ink);opacity:.55;}',
      '.ck-notice a{color:var(--ck-brass-soft);text-decoration:none;',
      'border-bottom:1px solid var(--ck-hair);}',
      '.ck-notice a:hover{border-bottom-color:var(--ck-brass-soft);}',
      '.ck-demoline{margin:.7rem 0 1.2rem;font-family:"IBM Plex Mono",monospace;font-size:.62rem;',
      'letter-spacing:.08em;line-height:1.8;color:var(--ck-brass-soft);}',

      /* ---------- act 3 — review plate (sewn-in label) ---------- */
      '.ck-plate{border:1px solid var(--ck-hair);padding:.4rem 1.1rem;margin:0 0 1.2rem;',
      'background:rgba(241,236,226,.02);}',
      '.ck-row{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;',
      'padding:.7rem 0;border-bottom:1px solid var(--ck-hair-soft);}',
      '.ck-row:last-child{border-bottom:none;}',
      '.ck-rk{flex:0 0 auto;font-family:"IBM Plex Mono",monospace;font-size:.56rem;',
      'letter-spacing:.22em;text-transform:uppercase;color:rgba(241,236,226,.5);}',
      '.ck-rv{flex:1 1 auto;min-width:0;text-align:right;font-family:"Hanken Grotesk",sans-serif;',
      'font-weight:300;font-size:.9rem;line-height:1.5;color:var(--ck-ink);',
      'overflow-wrap:break-word;word-break:break-word;}',
      '.ck-rv.ck-rv-soft{color:rgba(241,236,226,.6);}',

      /* calm error line */
      '.ck-sysline{margin:.9rem 0 0;font-family:"IBM Plex Mono",monospace;font-size:.62rem;',
      'letter-spacing:.14em;text-transform:uppercase;line-height:1.8;color:rgba(241,236,226,.6);}',

      /* the gift line */
      '.ck-giftrow{margin:.2rem 0 1rem;}',
      '.ck-giftline{display:flex;align-items:center;gap:10px;cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.62rem;letter-spacing:.14em;',
      'text-transform:uppercase;color:rgba(241,236,226,.7);margin-bottom:.7rem;',
      'user-select:none;-webkit-user-select:none;}',
      '.ck-giftline input{accent-color:var(--ck-brass,#A67C3D);width:15px;height:15px;',
      'flex:0 0 auto;cursor:pointer;}',

      /* the key gate: the figures from the letter (or one long pasted key).
         The input takes the full row — a 6-10 figure code with wide spacing
         never clips — and the button sits on its own line below. */
      '.ck-otprow{display:flex;flex-wrap:wrap;gap:.7rem;margin-top:.7rem;align-items:stretch;}',
      '.ck-otp{flex:1 1 100%;min-width:0;text-align:center;font-family:"IBM Plex Mono",monospace;',
      'font-size:1.1rem;letter-spacing:.4em;text-indent:.4em;}',
      '.ck-otp.ck-otp-long{letter-spacing:.05em;text-indent:0;font-size:.85rem;}',
      '.ck-otpbtn{flex:1 1 auto;margin-top:0;}',

      /* ---------- act 4 — the register card ---------- */
      '.ck-card{position:relative;overflow:hidden;border:1px solid var(--ck-brass-soft);',
      'aspect-ratio:840/1042;display:flex;flex-direction:column;justify-content:center;',
      'padding:24% 25% 25%;margin:.6rem 0 .9rem;text-align:center;',
      'background-color:#141b16;',
      'background-size:100% 100%;background-repeat:no-repeat;}',
      '.ck-stampwrap{position:relative;display:block;margin:0 auto .9rem;width:100%;}',
      '.ck-sealcameo{display:block;width:100%;aspect-ratio:2.35/1;',
      'background-size:cover;background-position:50% 44%;background-repeat:no-repeat;',
      'border:1px solid var(--ck-hair);box-shadow:0 10px 26px -12px rgba(0,0,0,.85);}',
      '.ck-sealshot{position:absolute;inset:0;z-index:3;pointer-events:none;',
      'background-size:cover;background-position:center 30%;opacity:0;}',
      '.ck-stampwrap::after{content:"";position:absolute;inset:-5px;',
      'border:1px solid rgba(196,155,91,.75);opacity:0;pointer-events:none;}',
      '.ck-cardno{font-family:"Gloock",serif;font-weight:400;',
      'font-size:clamp(1.5rem,8.5vw,2.4rem);line-height:1.1;',
      'color:var(--ck-ink);margin:0 0 .25rem;}',
      '.ck-sheen{position:absolute;inset:0;pointer-events:none;',
      'background:linear-gradient(115deg,transparent 30%,rgba(241,236,226,.08) 45%,',
      'rgba(196,155,91,.16) 50%,transparent 66%);transform:translateX(-130%);}',
      '.ck-motes{position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;}',

      /* the commission moment — only when motion is welcome.
         Order: the seal-press photograph fills the card, recedes, and the
         certificate assembles beneath it. */
      '.ck-card.ck-celebrate{animation:ckRise .9s cubic-bezier(.22,1,.36,1) both;}',
      '.ck-celebrate .ck-sealshot{animation:ckShot 3.4s ease-in-out both;}',
      '.ck-celebrate .ck-sealcameo{animation:ckVignette 1.1s ease 2.6s both;}',
      '@keyframes ckVignette{0%{opacity:0;transform:scale(1.04);}100%{opacity:1;transform:scale(1);}}',
      '.ck-celebrate .ck-stampwrap::after{animation:ckRing 1.5s ease-out 3.5s both;}',
      '.ck-celebrate .ck-cardno{animation:ckInkIn .6s ease 2.7s both;}',
      '.ck-celebrate .ck-cardrun{opacity:0;animation:ckRow .8s ease 3.6s both;}',
      '.ck-celebrate .ck-cardrow{opacity:0;animation:ckRow .7s ease both;}',
      '.ck-celebrate .ck-sheen{animation:ckSheen 3s ease-in-out 4.4s 2;}',
      '@keyframes ckShot{0%{opacity:0;transform:scale(1.06);}8%{opacity:1;}',
      '72%{opacity:1;transform:scale(1.01);}100%{opacity:0;transform:scale(1.1);}}',
      '.ck-sealshot video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}',
      '@keyframes ckRise{0%{opacity:0;transform:translateY(28px) scale(.96);}',
      '100%{opacity:1;transform:none;}}',
      '@keyframes ckStamp{0%{opacity:0;transform:scale(2.4) rotate(-9deg);}',
      '55%{opacity:1;transform:scale(.93) rotate(1deg);}78%{transform:scale(1.06);}',
      '100%{opacity:1;transform:scale(1) rotate(0);}}',
      '@keyframes ckRing{0%{opacity:.9;transform:scale(.55);}100%{opacity:0;transform:scale(2.7);}}',
      '@keyframes ckInkIn{0%{opacity:0;filter:blur(4px);}100%{opacity:1;filter:blur(0);}}',
      '@keyframes ckRow{0%{opacity:0;transform:translateY(7px);}100%{opacity:1;transform:none;}}',
      '@keyframes ckSheen{0%{transform:translateX(-130%);}60%{transform:translateX(130%);}',
      '100%{transform:translateX(130%);}}',
      '@keyframes ckFlare{0%{text-shadow:0 0 26px rgba(var(--ck-flare,196,155,91),.95);}',
      '100%{text-shadow:0 0 0 rgba(var(--ck-flare,196,155,91),0);}}',
      '@media (max-width:480px){',
      '.ck-cardrow{font-size:.5rem;letter-spacing:.08em;padding:.3rem 0;}',
      '.ck-cardrun{font-size:.46rem;letter-spacing:.14em;margin-bottom:.45rem;}',
      '.ck-stampwrap{margin-bottom:.4rem;}',
      '.ck-sealcameo{aspect-ratio:3.5/1;}',
      '.ck-cardno{font-size:clamp(1.2rem,6.2vw,1.6rem);}',
      '}',
      '.ck-cardrun{font-family:"IBM Plex Mono",monospace;font-size:.54rem;letter-spacing:.24em;',
      'text-transform:uppercase;color:var(--ck-brass-soft);margin-bottom:.8rem;}',
      '.ck-cardrows{border-top:1px solid var(--ck-hair-soft);margin:0;}',
      '.ck-cardrow{padding:.45rem 0;border-bottom:1px solid var(--ck-hair-soft);',
      'font-family:"IBM Plex Mono",monospace;font-size:.58rem;letter-spacing:.14em;',
      'text-transform:uppercase;line-height:1.7;color:rgba(241,236,226,.78);',
      'overflow-wrap:break-word;word-break:break-word;}',
      '.ck-cardrow.ck-cardrow-soft{color:rgba(241,236,226,.5);text-transform:none;letter-spacing:.08em;}',
      '.ck-returnrow{display:flex;justify-content:center;align-items:center;gap:.75rem;flex-wrap:wrap;margin-top:1.4rem;}',
      /* finale pills — a special send-off after a commission */
      '.ck-finbtn{position:relative;overflow:hidden;min-height:46px;padding:.72rem 1.5rem;border-radius:999px;cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.62rem;letter-spacing:.22em;text-transform:uppercase;',
      'transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s ease,background .25s ease,color .25s ease,border-color .25s ease;',
      'animation:ckRise .6s cubic-bezier(.2,.8,.2,1) both;}',
      '.ck-finbtn:focus-visible{outline:1px solid var(--ck-brass-soft);outline-offset:3px;}',
      '.ck-finbtn:active{transform:translateY(1px) scale(.99);}',
      /* primary — brass pill with a slow shine sweep + glow */
      '.ck-again{background:linear-gradient(135deg,var(--ck-brass-soft),var(--ck-brass));color:#171F1A;font-weight:700;',
      'border:1px solid var(--ck-brass-soft);animation-delay:.05s;',
      'box-shadow:0 6px 22px -8px rgba(196,155,91,.7),inset 0 1px 0 rgba(255,255,255,.28);}',
      '.ck-again:hover{transform:translateY(-2px);box-shadow:0 12px 32px -8px rgba(196,155,91,.92),inset 0 1px 0 rgba(255,255,255,.38);}',
      '.ck-again::after{content:"";position:absolute;top:0;left:-60%;width:42%;height:100%;pointer-events:none;',
      'background:linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-18deg);',
      'animation:ckShine 4s ease-in-out 1.4s infinite;}',
      /* secondary — refined ghost pill */
      '.ck-return{background:rgba(241,236,226,.02);color:rgba(241,236,226,.6);border:1px solid rgba(196,155,91,.32);animation-delay:.15s;}',
      '.ck-return:hover{transform:translateY(-2px);color:var(--ck-ink);border-color:var(--ck-brass-soft);background:rgba(196,155,91,.08);}',
      '@keyframes ckShine{0%{left:-60%;}55%{left:130%;}100%{left:130%;}}',
      '@keyframes ckRise{0%{opacity:0;transform:translateY(10px);}100%{opacity:1;transform:translateY(0);}}',
      '@media (prefers-reduced-motion:reduce){.ck-finbtn{animation:none;}.ck-again::after{display:none;}.ck-finbtn:hover{transform:none;}}',

      '.ck-fade{animation:ckFade .6s ease both;}',
      '@keyframes ckFade{from{opacity:0;}to{opacity:1;}}',

      /* ---------- reduced motion ---------- */
      '.ck-reduced,.ck-reduced *{transition:none !important;animation:none !important;}',
      '.ck-reduced .ck-dots i{opacity:.8;transform:none;}',
      '@media (prefers-reduced-motion:reduce){',
      '.ck-scrim,.ck-panel,.ck-act,.ck-swatch,.ck-swmark,.ck-knot,.ck-seg,.ck-primary{transition:none !important;}',
      '.ck-dots i,.ck-fade{animation:none !important;}',
      '}'
    ].join('');
    var tag = document.createElement('style');
    tag.id = 'ck-style';
    tag.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(tag);
  }

  /* ----------------------------------------------------------
     2. Tiny DOM helpers — no innerHTML anywhere near input
  ---------------------------------------------------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.appendChild(document.createTextNode(String(text))); }
    return n;
  }

  function stampImg(cls) {
    var img = document.createElement('img');
    img.className = cls;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.onerror = function () { img.style.display = 'none'; };
    img.src = STAMP_SRC;
    return img;
  }

  /* ----------------------------------------------------------
     3. State — kept across close/open so the sheet resumes
  ---------------------------------------------------------- */
  var act = 1;                       /* 1..4 */
  var order = {
    colorway: '',
    is_gift: false,
    recipient: '',
    bill_differs: false,
    bill_address: '',
    bill_address2: '',
    bill_city: '',
    bill_state: '',
    bill_zip: '',
    name: '',
    email: '',
    address: '',
    address2: '',
    city: '',
    state: '',
    zip: ''
  };
  var commissioned = null;           /* { serial, dateLine } once entered */
  var sending = false;
  var patronAddresses = [];          /* saved ship-to addresses from ?me=1 (returning patron) */
  var pickedAddrKey = null;          /* which saved ship-to is selected */
  var patronBillingAddresses = [];   /* saved billing addresses from ?me=1 */
  var pickedBillKey = null;          /* which saved billing address is selected */

  /* ----------------------------------------------------------
     4. Swatch imagery — borrowed from the page's colorway chips
  ---------------------------------------------------------- */
  var swatchImages = null;           /* array of 3 backgroundImage strings or '' */
  function readSwatchImages() {
    if (swatchImages) { return swatchImages; }
    var out = ['', '', ''];
    try {
      var chips = document.querySelectorAll('.cw .chip');
      var i, bg;
      for (i = 0; i < chips.length && i < 3; i++) {
        bg = window.getComputedStyle(chips[i]).backgroundImage;
        if (typeof bg === 'string' && bg !== 'none') { out[i] = bg; }
      }
    } catch (eS) { /* fall back to flat tones */ }
    swatchImages = out;
    return out;
  }

  /* ----------------------------------------------------------
     5. UI construction
  ---------------------------------------------------------- */
  var scrim, panel, bodyEl, threadEl, knots = [], segs = [];
  var roots = [];
  var currentActEl = null;

  function syncReduced() {
    var i;
    for (i = 0; i < roots.length; i++) {
      if (roots[i]) {
        if (REDUCED) { roots[i].classList.add('ck-reduced'); }
        else { roots[i].classList.remove('ck-reduced'); }
      }
    }
  }

  function buildUI() {
    scrim = el('div', 'ck-scrim');
    scrim.addEventListener('click', function () { closePanel(); });

    panel = el('aside', 'ck-panel');
    panel.id = 'ck-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Commission Decke 01');
    panel.setAttribute('tabindex', '-1');

    var handle = el('div', 'ck-handle');
    handle.setAttribute('aria-hidden', 'true');
    panel.appendChild(handle);

    var head = el('header', 'ck-head');
    var headLeft = el('div', 'ck-headleft');
    headLeft.appendChild(el('h2', 'ck-title', 'The Commission'));
    var sub = el('div', 'ck-sub');
    sub.appendChild(el('span', null, 'DECKE 01 · WEBEREI BRANDT · EST. 1897'));
    headLeft.appendChild(sub);
    head.appendChild(headLeft);
    var closeBtn = el('button', 'ck-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close commission sheet');
    closeBtn.addEventListener('click', function () { closePanel(); });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    /* progress thread — brass line, three knots */
    threadEl = el('div', 'ck-thread');
    threadEl.setAttribute('aria-hidden', 'true');
    knots = []; segs = [];
    var k;
    for (k = 0; k < 3; k++) {
      var knot = el('span', 'ck-knot');
      knots.push(knot);
      threadEl.appendChild(knot);
      if (k < 2) {
        var seg = el('span', 'ck-seg');
        segs.push(seg);
        threadEl.appendChild(seg);
      }
    }
    threadEl.appendChild(el('span', 'ck-threadcap', 'Cloth · Register · Commission'));
    panel.appendChild(threadEl);

    bodyEl = el('div', 'ck-body');
    panel.appendChild(bodyEl);

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    roots = [scrim, panel];
    syncReduced();

    panel.addEventListener('keydown', trapFocus);
    initDrag(handle, head);
  }

  function syncThread() {
    var i;
    var a = (act === 5) ? 2 : act; /* the key gate sits within stage two */
    for (i = 0; i < knots.length; i++) {
      knots[i].className = 'ck-knot';
      var step = i + 1;
      if (a > step || a === 4) { knots[i].classList.add('ck-done'); }
      else if (a === step) { knots[i].classList.add('ck-now'); }
    }
    for (i = 0; i < segs.length; i++) {
      segs[i].className = 'ck-seg' + ((a > i + 1 || a === 4) ? ' ck-done' : '');
    }
  }

  /* ----------------------------------------------------------
     6. Act rendering & the gentle horizontal slide
  ---------------------------------------------------------- */
  function buildAct(n) {
    if (n === 2) { return buildAct2(); }
    if (n === 3) { return buildAct3(); }
    if (n === 4) { return buildAct4(); }
    if (n === 5) { return buildGate(); }
    return buildAct1();
  }

  function pubCkState() {
    try {
      window.__ckState = {
        open: panelOpen, act: act,
        colorway: order.colorway || '',
        commissioned: !!commissioned
      };
    } catch (eP) { /* ignore */ }
  }

  function showAct(n, dir) {
    act = n;
    saveDraft();
    pubCkState();
    syncThread();
    var next = buildAct(n);
    var prev = currentActEl;
    currentActEl = next;
    bodyEl.scrollTop = 0;

    if (REDUCED || !prev || !dir) {
      if (prev && prev.parentNode) { prev.parentNode.removeChild(prev); }
      bodyEl.appendChild(next);
      focusAct(next, !prev);
      return;
    }

    /* outgoing drifts away, incoming slides in from the travel direction */
    prev.classList.add('ck-out', 'ck-slide');
    next.classList.add('ck-slide');
    next.style.transform = 'translateX(' + (dir > 0 ? 44 : -44) + 'px)';
    next.style.opacity = '0';
    bodyEl.appendChild(next);
    void next.offsetWidth; /* commit start frame */
    prev.style.transform = 'translateX(' + (dir > 0 ? -44 : 44) + 'px)';
    prev.style.opacity = '0';
    next.style.transform = 'translateX(0)';
    next.style.opacity = '1';
    setTimeout(function () {
      if (prev.parentNode) { prev.parentNode.removeChild(prev); }
      next.classList.remove('ck-slide');
      next.style.transform = '';
      next.style.opacity = '';
    }, 420);
    focusAct(next, false);
  }

  function focusAct(node, initial) {
    if (initial) { return; } /* openPanel focuses the panel itself */
    node.setAttribute('tabindex', '-1');
    setTimeout(function () {
      try { node.focus({ preventScroll: true }); }
      catch (eF) { try { node.focus(); } catch (eF2) { /* ignore */ } }
    }, REDUCED ? 0 : 60);
  }

  /* ----------------------------------------------------------
     7. Act 1 — THE CLOTH
  ---------------------------------------------------------- */
  function buildAct1() {
    var box = el('section', 'ck-act');
    box.setAttribute('aria-label', 'Act one — the cloth');

    var alloc = el('div', 'ck-alloc');
    alloc.appendChild(el('i', null, '✳'));
    alloc.appendChild(el('span', null, 'YOURS WILL BE Nº ' + slotLabel()));
    box.appendChild(alloc);

    box.appendChild(el('div', 'ck-kicker', 'Act I — The Cloth'));
    box.appendChild(el('p', 'ck-lede', 'Three dye lots leave the kettles this run. Choose the one your evenings should wear.'));

    var imgs = readSwatchImages();
    var list = el('div', 'ck-swatches');
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Colorway');

    var continueBtn = el('button', 'ck-primary', 'Continue');
    continueBtn.type = 'button';
    continueBtn.disabled = !order.colorway;

    var i;
    for (i = 0; i < COLORWAYS.length; i++) {
      (function (cw, idx) {
        var card = el('button', 'ck-swatch');
        card.type = 'button';
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', order.colorway === cw.id ? 'true' : 'false');
        if (order.colorway === cw.id) { card.classList.add('ck-sel'); }

        var img = el('div', 'ck-swimg');
        img.setAttribute('aria-hidden', 'true');
        if (imgs[idx]) { img.style.backgroundImage = imgs[idx]; }
        else { img.style.backgroundColor = cw.tone; }
        card.appendChild(img);

        var text = el('div', 'ck-swtext');
        text.appendChild(el('div', 'ck-swname', cw.name + ' — ' + cw.desc.charAt(0).toLowerCase() + cw.desc.slice(1)));
        text.appendChild(el('div', 'ck-swdesc', 'Merino twill · one dye lot'));
        card.appendChild(text);

        card.appendChild(el('span', 'ck-swmark', '✳'));

        card.addEventListener('click', function () {
          order.colorway = cw.id;
          var sibs = list.querySelectorAll('.ck-swatch');
          var s;
          for (s = 0; s < sibs.length; s++) {
            sibs[s].classList.remove('ck-sel');
            sibs[s].setAttribute('aria-checked', 'false');
          }
          card.classList.add('ck-sel');
          card.setAttribute('aria-checked', 'true');
          continueBtn.disabled = false;
        });
        list.appendChild(card);
      })(COLORWAYS[i], i);
    }
    box.appendChild(list);

    continueBtn.addEventListener('click', function () {
      if (!colorwayById(order.colorway)) { return; }
      showAct(2, 1);
    });
    box.appendChild(continueBtn);
    return box;
  }

  /* ----------------------------------------------------------
     8. Act 2 — THE REGISTER ENTRY
  ---------------------------------------------------------- */
  function makeField(labelText, control, errId) {
    var field = el('div', 'ck-field');
    var label = el('label', 'ck-label', labelText);
    var cid = 'ck-f-' + errId;
    control.id = cid;
    label.setAttribute('for', cid);
    field.appendChild(label);
    field.appendChild(control);
    var err = el('div', 'ck-err');
    err.id = 'ck-err-' + errId;
    control.setAttribute('aria-describedby', err.id);
    field.appendChild(err);
    field.ckErr = err;
    field.ckControl = control;
    return field;
  }

  function setFieldError(field, msg) {
    if (msg) {
      field.classList.add('ck-invalid');
      field.ckErr.textContent = msg;
      field.ckErr.classList.add('ck-on');
      field.ckControl.setAttribute('aria-invalid', 'true');
    } else {
      field.classList.remove('ck-invalid');
      field.ckErr.textContent = '';
      field.ckErr.classList.remove('ck-on');
      field.ckControl.removeAttribute('aria-invalid');
    }
  }

  /* Apply a saved address to the order (an explicit tap overrides typed fields).
     A gift entry re-addresses to that recipient; a personal one clears the gift. */
  function applyAddress(entry) {
    if (!entry) {                       /* "New address" — clear ship-to + gift */
      order.address = ''; order.address2 = ''; order.city = ''; order.state = ''; order.zip = '';
      order.is_gift = false; order.recipient = '';
      pickedAddrKey = 'new';
    } else {
      order.address = entry.address || '';
      order.address2 = entry.address2 || '';
      order.city = entry.city || '';
      order.state = entry.state || '';
      order.zip = entry.zip || '';
      if (entry.is_gift && entry.recipient_name) {
        order.is_gift = true; order.recipient = entry.recipient_name;
      } else {
        order.is_gift = false; order.recipient = '';
      }
      if (entry.name && !order.name) { order.name = entry.name; }
      pickedAddrKey = entryKey(entry);
    }
    saveDraft();
    showAct(2, 0);                      /* re-render the act with the chosen address */
  }

  /* A saved address is identified by its managed-book id when it has one, else by
     the derived-book key. */
  function entryKey(a) { return (a && (a.id || a.key)) || ''; }

  /* Remove a saved address from the patron's managed book (the real delete). */
  function removeSavedAddress(id) {
    if (!id || isDemo()) { return; }
    getFreshToken().then(function (token) {
      if (!token) { return; }
      return fetch(commissionEndpoint() + '?address_delete=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ id: id })
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (j && Array.isArray(j.addresses)) { patronAddresses = j.addresses; }
        if (pickedAddrKey === id) { pickedAddrKey = 'new'; }
        showAct(2, 0);
      });
    })['catch'](function () { /* leave the book as-is */ });
  }

  /* A one-line summary + a distinguishing label for a saved address — so two
     "Home" addresses (or several gift recipients) never read alike in the list. */
  function addrSummary(a) {
    return [a.address, a.city, a.state].filter(function (x) { return x; }).join(', ');
  }
  function shipOptionLabel(a) {
    var who = a.is_gift ? ('Gift → ' + (a.recipient_name || 'recipient')) : 'Home';
    return who + ' — ' + addrSummary(a);
  }

  /* The saved-address book — a compact SELECT (scales to any number of addresses,
     unlike a wrapping chip row). Personal doors + past gift recipients + a "new"
     escape. Picking a gift address re-addresses the order to that recipient. */
  function buildAddressBook() {
    if (!patronAddresses.length) { return null; }
    var wrap = el('div', 'ck-book');
    wrap.appendChild(el('div', 'ck-book-lbl', 'Ship to a saved address'));
    var sel = document.createElement('select');
    sel.className = 'ck-select';
    var i, cur = -1;
    for (i = 0; i < patronAddresses.length; i++) {
      var a = patronAddresses[i];
      var op = document.createElement('option');
      op.value = String(i); op.textContent = shipOptionLabel(a);
      sel.appendChild(op);
      if (pickedAddrKey === entryKey(a)) { cur = i; }
    }
    var opNew = document.createElement('option');
    opNew.value = 'new'; opNew.textContent = '＋ Enter a new address';
    sel.appendChild(opNew);
    sel.value = (pickedAddrKey === 'new') ? 'new' : (cur >= 0 ? String(cur) : '0');
    sel.addEventListener('change', function () {
      if (sel.value === 'new') { applyAddress(null); }
      else { applyAddress(patronAddresses[parseInt(sel.value, 10)]); }
    });
    wrap.appendChild(sel);
    /* Remove — only for a real saved (managed) address that's currently selected. */
    var chosen = (cur >= 0) ? patronAddresses[cur] : null;
    if (chosen && chosen.id) {
      var rm = el('button', 'ck-book-rm', 'Remove this saved address'); rm.type = 'button';
      rm.addEventListener('click', function () { removeSavedAddress(chosen.id); });
      wrap.appendChild(rm);
    }
    return wrap;
  }

  /* Apply a saved BILLING address (explicit pick overrides typed billing fields). */
  function applyBillingAddress(entry) {
    if (!entry) {
      order.bill_address = ''; order.bill_address2 = ''; order.bill_city = '';
      order.bill_state = ''; order.bill_zip = ''; pickedBillKey = 'new';
    } else {
      order.bill_address = entry.address || ''; order.bill_address2 = entry.address2 || '';
      order.bill_city = entry.city || ''; order.bill_state = entry.state || '';
      order.bill_zip = entry.zip || ''; pickedBillKey = entry.key;
    }
    saveDraft();
    showAct(2, 0);
  }
  /* Billing options = prior billing addresses + the patron's own (non-gift)
     shipping addresses, deduped. So "bill to my home" is one pick even if they've
     never entered a separate billing address (gift recipients are excluded — you
     don't bill to the person you're gifting). */
  function billingOptions() {
    var seen = {}, out = [];
    function add(a, origin) {
      if (!a || !a.address || !a.city) { return; }
      var k = [a.address, a.city, a.zip].join('|').toLowerCase();
      if (seen[k]) { return; } seen[k] = 1;
      out.push({ key: a.key || k, origin: origin, address: a.address, address2: a.address2 || '',
        city: a.city, state: a.state || '', zip: a.zip || '' });
    }
    patronBillingAddresses.forEach(function (a) { add(a, 'billing'); });
    patronAddresses.forEach(function (a) { if (!a.is_gift) { add(a, 'home'); } });
    return out;
  }
  function billOptionLabel(a) {
    return (a.origin === 'home' ? 'Home — ' : 'Billed before — ') + addrSummary(a);
  }
  function buildBillingBook() {
    var opts = billingOptions();
    if (!opts.length) { return null; }
    var wrap = el('div', 'ck-book'); wrap.style.marginTop = '.4rem';
    wrap.appendChild(el('div', 'ck-book-lbl', 'Use a saved billing address'));
    var sel = document.createElement('select');
    sel.className = 'ck-select';
    var i, cur = -1;
    for (i = 0; i < opts.length; i++) {
      var op = document.createElement('option');
      op.value = String(i); op.textContent = billOptionLabel(opts[i]);
      sel.appendChild(op);
      if (pickedBillKey === opts[i].key) { cur = i; }
    }
    var opNew = document.createElement('option');
    opNew.value = 'new'; opNew.textContent = '＋ Enter a new billing address';
    sel.appendChild(opNew);
    sel.value = (pickedBillKey === 'new') ? 'new' : (cur >= 0 ? String(cur) : 'new');
    sel.addEventListener('change', function () {
      if (sel.value === 'new') { applyBillingAddress(null); }
      else { applyBillingAddress(opts[parseInt(sel.value, 10)]); }
    });
    wrap.appendChild(sel);
    return wrap;
  }

  function buildAct2() {
    var box = el('section', 'ck-act');
    box.setAttribute('aria-label', 'Act two — the register entry');

    box.appendChild(el('div', 'ck-kicker', 'Act II — The Register Entry'));
    box.appendChild(el('p', 'ck-lede', 'A few lines for the mill’s Webbuch. Nothing more is asked.'));

    var book = buildAddressBook();
    if (book) { box.appendChild(book); }

    var form = document.createElement('form');
    form.noValidate = true;

    var fields = el('div', 'ck-fields');

    var nameInput = document.createElement('input');
    nameInput.className = 'ck-input';
    nameInput.type = 'text';
    nameInput.autocomplete = 'name';
    nameInput.value = order.name;
    var nameField = makeField('Full name — for the Webbuch', nameInput, 'name');
    fields.appendChild(nameField);

    var emailInput = document.createElement('input');
    emailInput.className = 'ck-input';
    emailInput.type = 'email';
    emailInput.autocomplete = 'email';
    emailInput.setAttribute('inputmode', 'email');
    emailInput.value = order.email;
    var emailField = makeField('Email — for the register card', emailInput, 'email');
    fields.appendChild(emailField);

    var addrInput = document.createElement('input');
    addrInput.className = 'ck-input';
    addrInput.type = 'text';
    addrInput.autocomplete = 'address-line1';
    addrInput.value = order.address;
    var addrField = makeField('Street address', addrInput, 'address');
    fields.appendChild(addrField);

    var addr2Input = document.createElement('input');
    addr2Input.className = 'ck-input';
    addr2Input.type = 'text';
    addr2Input.autocomplete = 'address-line2';
    addr2Input.value = order.address2;
    var addr2Field = makeField('Apt, suite — if the register needs it', addr2Input, 'address2');
    fields.appendChild(addr2Field);

    var cityInput = document.createElement('input');
    cityInput.className = 'ck-input';
    cityInput.type = 'text';
    cityInput.autocomplete = 'address-level2';
    cityInput.value = order.city;
    var cityField = makeField('City', cityInput, 'city');
    fields.appendChild(cityField);

    var stateSel = document.createElement('select');
    stateSel.className = 'ck-select';
    stateSel.autocomplete = 'address-level1';
    var opt0 = document.createElement('option');
    opt0.value = '';
    opt0.appendChild(document.createTextNode('Choose a state'));
    stateSel.appendChild(opt0);
    var s;
    for (s = 0; s < STATES.length; s++) {
      var opt = document.createElement('option');
      opt.value = STATES[s][0];
      opt.appendChild(document.createTextNode(STATES[s][1]));
      stateSel.appendChild(opt);
    }
    stateSel.value = order.state || '';
    function syncSelTone() {
      if (stateSel.value) { stateSel.classList.remove('ck-empty'); }
      else { stateSel.classList.add('ck-empty'); }
    }
    syncSelTone();
    stateSel.addEventListener('change', syncSelTone);
    var stateField = makeField('State', stateSel, 'state');
    fields.appendChild(stateField);

    var zipInput = document.createElement('input');
    zipInput.className = 'ck-input';
    zipInput.type = 'text';
    zipInput.autocomplete = 'postal-code';
    zipInput.setAttribute('inputmode', 'numeric');
    zipInput.value = order.zip;
    var zipField = makeField('ZIP', zipInput, 'zip');
    fields.appendChild(zipField);

    form.appendChild(fields);

    /* a gift: the register card carries the recipient's name */
    var giftRow = el('div', 'ck-giftrow');
    var giftLbl = el('label', 'ck-giftline');
    var giftCb = document.createElement('input');
    giftCb.type = 'checkbox';
    giftCb.checked = !!order.is_gift;
    giftLbl.appendChild(giftCb);
    giftLbl.appendChild(el('span', null, 'This one is a gift — the card carries another name'));
    giftRow.appendChild(giftLbl);

    var recInput = document.createElement('input');
    recInput.className = 'ck-input';
    recInput.type = 'text';
    recInput.autocomplete = 'off';
    recInput.value = order.recipient;
    var recField = makeField('Recipient’s name — for the register card', recInput, 'recipient');
    recField.style.display = order.is_gift ? '' : 'none';
    giftRow.appendChild(recField);
    form.appendChild(giftRow);

    var giftNote = el('p', 'ck-notice', 'It ships to the address above — the recipient\u2019s door.');
    giftNote.style.display = order.is_gift ? '' : 'none';
    giftRow.appendChild(giftNote);
    giftCb.addEventListener('change', function () {
      order.is_gift = giftCb.checked;
      recField.style.display = giftCb.checked ? '' : 'none';
      giftNote.style.display = giftCb.checked ? '' : 'none';
      if (giftCb.checked) { try { recInput.focus(); } catch (eG) { /* ignore */ } }
      saveDraft();
    });
    recInput.addEventListener('input', function () {
      order.recipient = (recInput.value || '').replace(/^\s+|\s+$/g, '');
      saveDraft();
    });

    /* billing: recorded only when it differs — nothing is demanded */
    var billRow = el('div', 'ck-giftrow');
    var billLbl = el('label', 'ck-giftline');
    var billCb = document.createElement('input');
    billCb.type = 'checkbox';
    billCb.checked = !!order.bill_differs;
    billLbl.appendChild(billCb);
    billLbl.appendChild(el('span', null, 'My billing address differs from shipping'));
    billRow.appendChild(billLbl);

    var billWrap = el('div');
    billWrap.style.display = order.bill_differs ? '' : 'none';

    var billBook = buildBillingBook();
    if (billBook) { billWrap.appendChild(billBook); }

    var bAddrInput = document.createElement('input');
    bAddrInput.className = 'ck-input';
    bAddrInput.type = 'text';
    bAddrInput.autocomplete = 'billing address-line1';
    bAddrInput.value = order.bill_address;
    var bAddrField = makeField('Billing street address', bAddrInput, 'baddress');
    billWrap.appendChild(bAddrField);

    var bAddr2Input = document.createElement('input');
    bAddr2Input.className = 'ck-input';
    bAddr2Input.type = 'text';
    bAddr2Input.autocomplete = 'billing address-line2';
    bAddr2Input.value = order.bill_address2;
    var bAddr2Field = makeField('Billing apt, suite — if needed', bAddr2Input, 'baddress2');
    billWrap.appendChild(bAddr2Field);

    var bCityInput = document.createElement('input');
    bCityInput.className = 'ck-input';
    bCityInput.type = 'text';
    bCityInput.autocomplete = 'billing address-level2';
    bCityInput.value = order.bill_city;
    var bCityField = makeField('Billing city', bCityInput, 'bcity');
    billWrap.appendChild(bCityField);

    var bStateSel = document.createElement('select');
    bStateSel.className = 'ck-select';
    bStateSel.autocomplete = 'billing address-level1';
    var bOpt0 = document.createElement('option');
    bOpt0.value = '';
    bOpt0.appendChild(document.createTextNode('Choose a state'));
    bStateSel.appendChild(bOpt0);
    var bs;
    for (bs = 0; bs < STATES.length; bs++) {
      var bOpt = document.createElement('option');
      bOpt.value = STATES[bs][0];
      bOpt.appendChild(document.createTextNode(STATES[bs][1]));
      bStateSel.appendChild(bOpt);
    }
    bStateSel.value = order.bill_state || '';
    var bStateField = makeField('Billing state', bStateSel, 'bstate');
    billWrap.appendChild(bStateField);

    var bZipInput = document.createElement('input');
    bZipInput.className = 'ck-input';
    bZipInput.type = 'text';
    bZipInput.autocomplete = 'billing postal-code';
    bZipInput.setAttribute('inputmode', 'numeric');
    bZipInput.value = order.bill_zip;
    var bZipField = makeField('Billing ZIP', bZipInput, 'bzip');
    billWrap.appendChild(bZipField);

    billRow.appendChild(billWrap);
    form.appendChild(billRow);

    function keepBilling() {
      order.bill_differs = billCb.checked;
      order.bill_address = (bAddrInput.value || '').replace(/^\s+|\s+$/g, '');
      order.bill_address2 = (bAddr2Input.value || '').replace(/^\s+|\s+$/g, '');
      order.bill_city = (bCityInput.value || '').replace(/^\s+|\s+$/g, '');
      order.bill_state = bStateSel.value || '';
      order.bill_zip = (bZipInput.value || '').replace(/^\s+|\s+$/g, '');
      saveDraft();
    }
    billCb.addEventListener('change', function () {
      billWrap.style.display = billCb.checked ? '' : 'none';
      if (billCb.checked) { try { bAddrInput.focus(); } catch (eB) { /* ignore */ } }
      keepBilling();
    });
    bAddrInput.addEventListener('input', keepBilling);
    bAddr2Input.addEventListener('input', keepBilling);
    bCityInput.addEventListener('input', keepBilling);
    bStateSel.addEventListener('change', keepBilling);
    bZipInput.addEventListener('input', keepBilling);

    /* notice at collection — quiet, present, not a checkbox */
    var notice = el('p', 'ck-notice');
    notice.appendChild(document.createTextNode(
      'We collect only what the register needs: your name, email, and address. ' +
      'Nothing is sold or shared; delete it any time at concierge@feier-abend.co. ' +
      'California residents: see our '));
    var privacyA = document.createElement('a');
    privacyA.setAttribute('href', 'privacy.html');
    privacyA.appendChild(document.createTextNode('privacy notice'));
    notice.appendChild(privacyA);
    notice.appendChild(document.createTextNode('.'));
    form.appendChild(notice);

    form.appendChild(el('p', 'ck-demoline', DEMO_LINE));

    var reviewBtn = el('button', 'ck-primary', 'Review the commission');
    reviewBtn.type = 'submit';
    form.appendChild(reviewBtn);

    var backRow = el('div', 'ck-backrow');
    var back = el('button', 'ck-back', '← The cloth');
    back.type = 'button';
    back.addEventListener('click', function () { keep(); showAct(1, -1); });
    backRow.appendChild(back);
    form.appendChild(backRow);

    function keep() {
      order.name = (nameInput.value || '').replace(/^\s+|\s+$/g, '');
      order.email = (emailInput.value || '').replace(/^\s+|\s+$/g, '');
      order.address = (addrInput.value || '').replace(/^\s+|\s+$/g, '');
      order.address2 = (addr2Input.value || '').replace(/^\s+|\s+$/g, '');
      order.city = (cityInput.value || '').replace(/^\s+|\s+$/g, '');
      order.state = stateSel.value || '';
      order.zip = (zipInput.value || '').replace(/^\s+|\s+$/g, '');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      keep();
      var ok = true, firstBad = null;

      if (!order.name || order.name.length < 2) {
        setFieldError(nameField, 'A name for the register, please.');
        ok = false; firstBad = firstBad || nameInput;
      } else { setFieldError(nameField, ''); }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(order.email)) {
        setFieldError(emailField, 'That address doesn’t read — check it once more.');
        ok = false; firstBad = firstBad || emailInput;
      } else { setFieldError(emailField, ''); }

      if (!order.address || order.address.length < 4 || order.address.length > 120) {
        setFieldError(addrField, 'A street address for the register, please.');
        ok = false; firstBad = firstBad || addrInput;
      } else { setFieldError(addrField, ''); }

      if (order.address2.length > 120) {
        setFieldError(addr2Field, 'Shorter, if it can be.');
        ok = false; firstBad = firstBad || addr2Input;
      } else { setFieldError(addr2Field, ''); }

      if (!order.city) {
        setFieldError(cityField, 'The register asks for a city.');
        ok = false; firstBad = firstBad || cityInput;
      } else { setFieldError(cityField, ''); }

      if (!isValidState(order.state)) {
        setFieldError(stateField, 'Choose a state from the list.');
        ok = false; firstBad = firstBad || stateSel;
      } else { setFieldError(stateField, ''); }

      if (!/^\d{5}(-\d{4})?$/.test(order.zip)) {
        setFieldError(zipField, 'Five digits — the usual kind.');
        ok = false; firstBad = firstBad || zipInput;
      } else { setFieldError(zipField, ''); }

      order.recipient = (recInput.value || '').replace(/^\s+|\s+$/g, '');
      order.is_gift = giftCb.checked;
      if (order.is_gift && (order.recipient.length < 2 || order.recipient.length > 80)) {
        setFieldError(recField, 'A name for the card, please.');
        ok = false; firstBad = firstBad || recInput;
      } else { setFieldError(recField, ''); }

      keepBilling();
      if (order.bill_differs) {
        if (order.bill_address.length < 4 || order.bill_address.length > 120) {
          setFieldError(bAddrField, 'A billing street address, please.');
          ok = false; firstBad = firstBad || bAddrInput;
        } else { setFieldError(bAddrField, ''); }
        if (order.bill_address2.length > 120) {
          setFieldError(bAddr2Field, 'Shorter, if it can be.');
          ok = false; firstBad = firstBad || bAddr2Input;
        } else { setFieldError(bAddr2Field, ''); }
        if (!order.bill_city) {
          setFieldError(bCityField, 'A billing city, please.');
          ok = false; firstBad = firstBad || bCityInput;
        } else { setFieldError(bCityField, ''); }
        if (!isValidState(order.bill_state)) {
          setFieldError(bStateField, 'Choose a state from the list.');
          ok = false; firstBad = firstBad || bStateSel;
        } else { setFieldError(bStateField, ''); }
        if (!/^\d{5}(-\d{4})?$/.test(order.bill_zip)) {
          setFieldError(bZipField, 'Five digits — the usual kind.');
          ok = false; firstBad = firstBad || bZipInput;
        } else { setFieldError(bZipField, ''); }
      }

      if (!ok) {
        if (firstBad) { try { firstBad.focus(); } catch (eF) { /* ignore */ } }
        return;
      }
      saveDraft();
      /* the register takes signed entries: verified session, or the key gate */
      if (isDemo() || !hasSb()) { showAct(3, 1); return; }
      reviewBtn.disabled = true;
      getFreshToken().then(function (token) {
        if (token) { reviewBtn.disabled = false; showAct(3, 1); return null; }
        return sendKey().then(function (res) {
          reviewBtn.disabled = false;
          if (res && res.error) { setFieldError(emailField, keyErrorLine(res.error)); return null; }
          showAct(5, 1);
          return null;
        });
      })['catch'](function () {
        reviewBtn.disabled = false;
        showAct(5, 1);
      });
    });

    /* keep drafts even if the sheet is abandoned mid-entry */
    nameInput.addEventListener('input', keep);
    emailInput.addEventListener('input', keep);
    addrInput.addEventListener('input', keep);
    addr2Input.addEventListener('input', keep);
    cityInput.addEventListener('input', keep);
    stateSel.addEventListener('change', keep);
    zipInput.addEventListener('input', keep);

    box.appendChild(form);
    return box;
  }

  /* ----------------------------------------------------------
     9. Act 3 — THE COMMISSION (review & confirm)
  ---------------------------------------------------------- */
  function plateRow(key, value, soft) {
    var row = el('div', 'ck-row');
    row.appendChild(el('div', 'ck-rk', key));
    row.appendChild(el('div', 'ck-rv' + (soft ? ' ck-rv-soft' : ''), value));
    return row;
  }

  function buildAct3() {
    var box = el('section', 'ck-act');
    box.setAttribute('aria-label', 'Act three — the commission');
    /* warm the chosen cloth's engraving and seal while the visitor reads */
    try {
      var artPre = cardArt();
      var pre1 = new Image(); pre1.src = artPre.frame;
      var pre2 = new Image(); pre2.src = artPre.seal;
    } catch (eP) { /* ignore */ }

    box.appendChild(el('div', 'ck-kicker', 'Act III — The Commission'));
    box.appendChild(el('p', 'ck-lede', 'Read it the way the mill will sew it in. Then sign the evening over.'));

    var cw = colorwayById(order.colorway);
    var plate = el('div', 'ck-plate');
    plate.appendChild(plateRow('Cloth', cw ? (cw.name + ' — ' + cw.desc.charAt(0).toLowerCase() + cw.desc.slice(1)) : '—'));
    if (order.is_gift && order.recipient) {
      plate.appendChild(plateRow('For', order.recipient + ' — a gift'));
    }
    plate.appendChild(plateRow('Register name', order.name || '—'));
    plate.appendChild(plateRow('Email',
      (order.email || '—') + ((!isDemo() && findAccessToken()) ? ' — verified' : '')));
    plate.appendChild(plateRow('Ships to', order.address ? (order.address + (order.address2 ? ', ' + order.address2 : '')) : '—'));
    plate.appendChild(plateRow('City', order.city || '—'));
    plate.appendChild(plateRow('State · ZIP', (order.state ? stateName(order.state) : '—') + ' · ' + (order.zip || '—')));
    if (order.bill_differs && order.bill_address) {
      plate.appendChild(plateRow('Billing',
        order.bill_address + (order.bill_address2 ? ', ' + order.bill_address2 : '') +
        ' — ' + order.bill_city + ', ' + order.bill_state + ' ' + order.bill_zip, true));
    }
    plate.appendChild(plateRow('Price', PRICE_LINE));
    plate.appendChild(plateRow('Nº', slotLabel() + ' — held while you finish'));
    box.appendChild(plate);

    box.appendChild(el('p', 'ck-demoline', DEMO_LINE));

    var confirmBtn = el('button', 'ck-primary');
    confirmBtn.type = 'button';
    var btnLabel = el('span', null, 'Enter the Webbuch');
    confirmBtn.appendChild(btnLabel);
    box.appendChild(confirmBtn);

    var sysline = el('p', 'ck-sysline');
    sysline.style.display = 'none';
    sysline.setAttribute('role', 'status');
    box.appendChild(sysline);

    var backRow = el('div', 'ck-backrow');
    var back = el('button', 'ck-back', '← The register');
    back.type = 'button';
    back.addEventListener('click', function () {
      if (sending) { return; }
      showAct(2, -1);
    });
    backRow.appendChild(back);
    box.appendChild(backRow);

    function setWeaving(on) {
      sending = on;
      confirmBtn.disabled = on;
      back.disabled = on;
      while (confirmBtn.firstChild) { confirmBtn.removeChild(confirmBtn.firstChild); }
      if (on) {
        var dots = el('span', 'ck-dots');
        dots.setAttribute('aria-hidden', 'true');
        dots.appendChild(el('i'));
        dots.appendChild(el('i'));
        dots.appendChild(el('i'));
        confirmBtn.appendChild(dots);
        confirmBtn.appendChild(el('span', null, 'Entering the register'));
      } else {
        confirmBtn.appendChild(el('span', null, 'Enter the Webbuch'));
      }
    }

    function fail(code) {
      setWeaving(false);
      if (code === 401) {
        sysline.textContent = 'Your key has lapsed — a fresh one is going in the post.';
        sysline.style.display = '';
        /* drop the dead session first, or the gate sees it and loops back */
        clearStaleSession().then(function () {
          return sendKey()['catch'](function () { return null; });
        }).then(function () {
          showAct(5, 1);
        });
        return;
      }
      if (code === 409) {
        sysline.textContent = 'The year\u2019s run is fully spoken for at this moment. A held number may free within minutes \u2014 or leave your name and I\u2019ll write when the next edition opens.';
        sysline.style.display = '';
        while (confirmBtn.firstChild) { confirmBtn.removeChild(confirmBtn.firstChild); }
        confirmBtn.appendChild(el('span', null, 'Try once more'));
        if (!document.getElementById('ck-wl-btn') && confirmBtn.parentNode) {
          var wlBtn = el('button', 'ck-btn ck-ghost');
          wlBtn.id = 'ck-wl-btn';
          wlBtn.type = 'button';
          wlBtn.appendChild(el('span', null, 'Join the waitlist'));
          wlBtn.addEventListener('click', function () { joinWaitlist(wlBtn, sysline); });
          confirmBtn.parentNode.appendChild(wlBtn);
        }
        return;
      }
      sysline.textContent = ERR_LINE;
      sysline.style.display = '';
      while (confirmBtn.firstChild) { confirmBtn.removeChild(confirmBtn.firstChild); }
      confirmBtn.appendChild(el('span', null, 'Retry'));
    }

    function succeed(serial, standing) {
      sending = false;
      clearDraft();
      /* standing: the register's count wins; otherwise count locally */
      var st = standing && typeof standing.count === 'number'
        ? { count: standing.count, tier: standing.tier || tierFor(standing.count) }
        : (function () {
            var n = 1;
            try {
              var prev = JSON.parse(window.localStorage.getItem('feier-patron') || 'null');
              if (prev && typeof prev.count === 'number') { n = prev.count + 1; }
            } catch (eL) { /* fresh patron */ }
            return { count: n, tier: tierFor(n) };
          })();
      try {
        window.localStorage.setItem('feier-patron', JSON.stringify({
          count: st.count, tier: st.tier, serial: serial,
          name: order.name, colorway: order.colorway, at: Date.now(),
          email: order.email, address: order.address, address2: order.address2,
          city: order.city, state: order.state, zip: order.zip,
          /* remember whether this ship-to was a gift, so the next visit doesn't
             prefill a returning buyer's personal order with a recipient's door */
          is_gift: !!order.is_gift, recipient: (order.is_gift && order.recipient) || ''
        }));
      } catch (eS) { /* storage blocked */ }
      try {
        window.dispatchEvent(new CustomEvent('ck:commissioned', {
          detail: { serial: serial, city: order.city, state: order.state,
                    tier: st.tier, count: st.count }
        }));
      } catch (eEv) { /* older browsers — the card still shows */ }
      commissioned = {
        serial: serial,
        dateLine: todayLine(),
        standing: st
      };
      showAct(4, 1);
    }

    confirmBtn.addEventListener('click', function () {
      if (sending) { return; }
      if (!colorwayById(order.colorway)) { showAct(1, -1); return; }
      sysline.style.display = 'none';
      sysline.textContent = '';
      setWeaving(true);
      submitCommission(succeed, fail);
    });

    return box;
  }

  function todayLine() {
    var d = new Date();
    try {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (eD) {
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }
  }

  /* Supabase session token, if one is resting in localStorage */
  function findAccessToken() {
    try {
      var i, key, raw, parsed;
      for (i = 0; i < window.localStorage.length; i++) {
        key = window.localStorage.key(i);
        if (!key || !/^sb-.*-auth-token$/.test(key)) { continue; }
        raw = window.localStorage.getItem(key);
        if (!raw) { continue; }
        parsed = JSON.parse(raw);
        if (parsed && typeof parsed.access_token === 'string' && parsed.access_token) {
          return parsed.access_token;
        }
        if (parsed && parsed.currentSession &&
            typeof parsed.currentSession.access_token === 'string') {
          return parsed.currentSession.access_token;
        }
      }
    } catch (eT) { /* signed-out or storage blocked — proceed anonymously */ }
    return '';
  }

  /* ---- supabase-js (shared session with the concierge) ---- */
  var ckSb = null, ckSbPromise = null;
  function hasSb() {
    var c = cfg();
    return !!(c.supabaseUrl && c.supabaseAnonKey);
  }
  function ensureSb() {
    if (ckSbPromise) { return ckSbPromise; }
    ckSbPromise = new Promise(function (resolve) {
      if (!hasSb()) { resolve(null); return; }
      function make() {
        try {
          ckSb = ckSb || window.supabase.createClient(cfg().supabaseUrl, cfg().supabaseAnonKey);
          resolve(ckSb);
        } catch (eC) { resolve(null); }
      }
      if (window.supabase && typeof window.supabase.createClient === 'function') { make(); return; }
      var sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      sc.onload = make;
      sc.onerror = function () { resolve(null); };
      document.head.appendChild(sc);
    });
    return ckSbPromise;
  }
  function gateRedirectUrl() {
    return window.location.origin + window.location.pathname;
  }

  /* A live token, refreshed by supabase-js when the stored one has expired.
     findAccessToken() alone reads raw storage and can hand back a stale key —
     the register answers 401 and the gate loops. Always prefer this. */
  function getFreshToken() {
    if (!hasSb()) { return Promise.resolve(findAccessToken()); }
    return ensureSb().then(function (sb) {
      if (!sb) { return findAccessToken(); }
      return sb.auth.getSession().then(function (r) {
        return (r && r.data && r.data.session && r.data.session.access_token) || '';
      })['catch'](function () { return ''; });
    });
  }

  /* Drop a session the register has refused, so the gate polls for a fresh
     key instead of bouncing straight back with the same dead token. */
  function clearStaleSession() {
    return ensureSb().then(function (sb) {
      if (sb) { return sb.auth.signOut({ scope: 'local' })['catch'](function () { return null; }); }
      return null;
    })['catch'](function () { return null; }).then(function () {
      try {
        var i, key, doomed = [];
        for (i = 0; i < window.localStorage.length; i++) {
          key = window.localStorage.key(i);
          if (key && /^sb-.*-auth-token$/.test(key)) { doomed.push(key); }
        }
        for (i = 0; i < doomed.length; i++) { window.localStorage.removeItem(doomed[i]); }
      } catch (eC) { /* storage blocked — nothing to clear */ }
    });
  }

  /* Brand-voice line for a key that could not be posted. */
  function keyErrorLine(error) {
    var msg = (error && (error.message || error.error_description)) || '';
    if (error && (error.status === 429 || /rate ?limit/i.test(msg))) {
      return 'The mill has posted its share of keys this hour. Rest a little, then ask again.';
    }
    return 'The key could not be posted just now — try once more in a moment.';
  }

  /* ---- draft persistence — the entry survives the key's round trip ---- */
  function saveDraft() {
    try {
      if (act === 4) { return; }
      window.sessionStorage.setItem('ck-draft', JSON.stringify({ act: act, order: order }));
    } catch (eS) { /* ignore */ }
  }
  function clearDraft() {
    try { window.sessionStorage.removeItem('ck-draft'); } catch (eS) { /* ignore */ }
  }
  function loadDraft() {
    try {
      var raw = window.sessionStorage.getItem('ck-draft');
      if (!raw) { return null; }
      var d = JSON.parse(raw);
      return (d && d.order && typeof d.order === 'object') ? d : null;
    } catch (eS) { return null; }
  }

  /* ---- the key gate (act 5): verification pending ---- */
  function sendKey() {
    return ensureSb().then(function (sb) {
      if (!sb) { return null; }
      return sb.auth.signInWithOtp({
        email: order.email,
        options: { emailRedirectTo: gateRedirectUrl() }
      });
    });
  }
  function buildGate() {
    var box = el('section', 'ck-act');
    box.setAttribute('aria-label', 'Verification — the key is in the mail');
    box.appendChild(el('div', 'ck-kicker', 'The Key'));
    box.appendChild(el('p', 'ck-lede',
      'The register takes signed entries. A key is on its way to ' + order.email +
      ' — open it, and you return here with your entry intact.'));
    box.appendChild(el('p', 'ck-notice',
      'The mill posts only a couple of keys an hour. If nothing arrives, look where mail goes to be forgotten, then resend.'));

    var sysline = el('p', 'ck-sysline');
    sysline.style.display = 'none';
    sysline.setAttribute('role', 'status');

    function say(text) {
      sysline.textContent = text;
      sysline.style.display = text ? '' : 'none';
    }

    /* the six figures from the letter — works even when the email opens in
       another app's browser, where the link's session cannot reach this tab */
    var otpRow = el('div', 'ck-otprow');
    var otpInput = document.createElement('input');
    otpInput.className = 'ck-input ck-otp';
    otpInput.type = 'text';
    otpInput.autocomplete = 'one-time-code';
    /* No maxlength and no numeric-only keyboard: the letter usually carries a
       short all-digit code, but a differently-configured mailer can send a
       longer or alphanumeric key — the gate accepts whatever the letter says
       rather than silently truncating it at six characters. */
    otpInput.setAttribute('maxlength', '80');
    otpInput.setAttribute('aria-label', 'The key from the email — the short code, or the whole long key');
    otpInput.placeholder = '······';
    var otpBtn = el('button', 'ck-primary ck-otpbtn', 'Turn the key');
    otpBtn.type = 'button';
    otpRow.appendChild(otpInput);
    otpRow.appendChild(otpBtn);
    var otpLabel = el('p', 'ck-notice',
      'The letter also carries the key’s figures — copy them here and the lock turns without leaving this page.');
    box.appendChild(otpLabel);
    box.appendChild(otpRow);
    box.appendChild(sysline);

    function tryOtp() {
      var raw = (otpInput.value || '').replace(/\s+/g, '');
      if (!raw) { say('The letter has the key — under the seal.'); return; }
      /* Two shapes of key: the usual short all-digit code (6–10 figures,
         verified as a token), or a long opaque key (a token hash — some mail
         templates carry that instead). Try the shape that matches. */
      var digitCode = /^\d{6,10}$/.test(raw) ? raw : '';
      var longKey = !digitCode && raw.length >= 16 ? raw : '';
      if (!digitCode && !longKey) {
        say('That doesn’t look like the key — copy the figures (or the one long key) exactly as the letter shows them.');
        return;
      }
      otpBtn.disabled = true;
      say('');
      ensureSb().then(function (sb) {
        if (!sb) { return null; }
        return digitCode
          ? sb.auth.verifyOtp({ email: order.email, token: digitCode, type: 'email' })
          : sb.auth.verifyOtp({ token_hash: longKey, type: 'email' });
      }).then(function (res) {
        otpBtn.disabled = false;
        if (!res) { say(ERR_LINE); return; }
        if (res.error) {
          /* say WHY it failed — a key works once, only the newest key counts,
             and they expire; the generic line hid all of that */
          var em = (res.error && res.error.message) ? String(res.error.message) : '';
          if (/expired|invalid/i.test(em)) {
            say('That key has expired or was already used — each key works once, and only the newest one counts. Resend and paste the fresh figures.');
          } else if (em) {
            say('The lock didn’t turn: ' + em + ' — resend the key and try the fresh figures.');
          } else {
            say('That key does not turn the lock — resend and paste the newest figures.');
          }
          return;
        }
        showAct(3, 1);
      })['catch'](function () { otpBtn.disabled = false; say(ERR_LINE); });
    }
    otpBtn.addEventListener('click', tryOtp);
    otpInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); tryOtp(); }
    });
    /* the wide six-figure spacing collapses when a long key is pasted, so the
       whole key stays readable inside the box */
    otpInput.addEventListener('input', function () {
      var long = (otpInput.value || '').replace(/\s+/g, '').length > 10;
      if (long) { otpInput.classList.add('ck-otp-long'); }
      else { otpInput.classList.remove('ck-otp-long'); }
    });

    var backRow = el('div', 'ck-backrow');
    var resend = el('button', 'ck-back', 'Resend the key');
    resend.type = 'button';
    var cool = 0;
    function coolTick() {
      if (cool <= 0) { resend.disabled = false; resend.textContent = 'Resend the key'; return; }
      resend.disabled = true;
      resend.textContent = 'Resend — ' + cool + 's';
      cool--;
      setTimeout(coolTick, 1000);
    }
    resend.addEventListener('click', function () {
      if (cool > 0) { return; }
      cool = 30; coolTick();
      sendKey().then(function (res) {
        if (res && res.error) { say(keyErrorLine(res.error)); }
        else { say('A fresh key is in the post.'); }
      })['catch'](function () { say(ERR_LINE); });
    });
    backRow.appendChild(resend);
    var back = el('button', 'ck-back', '← The register entry');
    back.type = 'button';
    back.addEventListener('click', function () { showAct(2, -1); });
    backRow.appendChild(back);
    box.appendChild(backRow);

    /* the key often turns in another tab — notice quietly and move on */
    var watch = setInterval(function () {
      if (!box.isConnected) { clearInterval(watch); return; }
      if (findAccessToken()) { clearInterval(watch); showAct(3, 1); }
    }, 2500);

    return box;
  }

  function submitCommission(onOk, onFail) {
    /* DEMO-LOCAL: no endpoint configured — simulate the mill's ledger */
    if (isDemo()) {
      setTimeout(function () { onOk(demoSerial(), null); }, 900);
      return;
    }
    var body = JSON.stringify({
      name: order.name,
      email: order.email,
      address: order.address,
      address2: order.address2,
      city: order.city,
      state: order.state,
      zip: order.zip,
      colorway: order.colorway,
      session_key: visitKey() || undefined,
      chat_session: chatKey() || undefined,
      chat_via: chatVia() || undefined,
      chat_meta: chatMeta() || undefined,
      is_gift: order.is_gift || undefined,
      recipient: (order.is_gift && order.recipient) || undefined,
      billing: order.bill_differs && order.bill_address ? {
        address: order.bill_address,
        address2: order.bill_address2 || undefined,
        city: order.bill_city,
        state: order.bill_state,
        zip: order.bill_zip
      } : undefined
    });
    try {
      getFreshToken().then(function (token) {
        var headers = { 'Content-Type': 'application/json' };
        if (token) { headers['Authorization'] = 'Bearer ' + token; }
        return fetch(commissionEndpoint(), {
          method: 'POST',
          headers: headers,
          body: body
        });
      }).then(function (res) {
        if (res.status === 401) { var e401 = new Error('401'); e401.code = 401; throw e401; }
        if (res.status === 409) { var e409 = new Error('409'); e409.code = 409; throw e409; }
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json()['catch'](function () { return {}; });
      }).then(function (j) {
        var serial = null;
        if (j && typeof j === 'object') {
          if (j.serial != null) { serial = parseInt(String(j.serial).replace(/,/g, ''), 10); }
          else if (j.number != null) { serial = parseInt(String(j.number).replace(/,/g, ''), 10); }
          else if (j.no != null) { serial = parseInt(String(j.no).replace(/,/g, ''), 10); }
        }
        if (!serial || isNaN(serial)) { serial = demoSerial(); }
        clearChatVia(); /* this order consumed the commission-click marker */
        onOk(serial, (j && j.standing) || null);
      })['catch'](function (err) { onFail(err && err.code ? err.code : 0); });
    } catch (eF) { onFail(0); }
  }

  /* ----------------------------------------------------------
     10. Act 4 — THE REGISTER CARD
  ---------------------------------------------------------- */
  /* Brass motes — a slow drift of golden dust over the card. Cheap canvas,
     stops itself the moment the card leaves the document. */
  function startMotes(card, rgb) {
    var cv = document.createElement('canvas');
    cv.className = 'ck-motes';
    cv.setAttribute('aria-hidden', 'true');
    card.appendChild(cv);
    var ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) { return; }
    var W = 0, H = 0, motes = [], i;
    function size() {
      W = cv.width = card.clientWidth || 300;
      H = cv.height = card.clientHeight || 380;
    }
    size();
    for (i = 0; i < 26; i++) {
      motes.push({
        x: Math.random() * W, y: Math.random() * H,
        r: 0.6 + Math.random() * 1.6,
        s: 0.06 + Math.random() * 0.2,
        w: Math.random() * 6.28,
        a: 0.12 + Math.random() * 0.45
      });
    }
    function frame(ts) {
      if (!cv.isConnected) { return; }
      if (W !== (card.clientWidth || W) || H !== (card.clientHeight || H)) { size(); }
      ctx.clearRect(0, 0, W, H);
      var p, tw;
      for (i = 0; i < motes.length; i++) {
        p = motes[i];
        p.y -= p.s;
        p.x += Math.sin(ts / 1500 + p.w) * 0.12;
        if (p.y < -4) { p.y = H + 4; p.x = Math.random() * W; }
        tw = p.a * (0.55 + 0.45 * Math.sin(ts / 680 + p.w));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 6.2832);
        ctx.fillStyle = 'rgba(' + (rgb || '214,178,122') + ',' + tw.toFixed(3) + ')';
        ctx.fill();
      }
      window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  function buildAct4() {
    var box = el('section', 'ck-act');
    box.setAttribute('aria-label', 'Act four — the register card');

    box.appendChild(el('div', 'ck-kicker', 'The Register Card'));

    var serial = commissioned ? commissioned.serial : demoSerial();
    var dateLine = (commissioned && commissioned.dateLine) ? commissioned.dateLine : todayLine();
    var cw = colorwayById(order.colorway);
    var celebrate = !REDUCED;
    var art = cardArt();

    var card = el('div', 'ck-card' + (celebrate ? ' ck-celebrate' : ''));
    card.style.backgroundImage = 'url("' + art.frame + '")';
    card.style.backgroundColor = art.bg;
    card.style.setProperty('--ck-flare', art.flare);
    card.appendChild(el('div', 'ck-sheen'));

    var stampWrap = el('span', 'ck-stampwrap');
    var cameo = el('span', 'ck-sealcameo');
    cameo.style.backgroundImage = 'url("' + art.seal + '")';
    cameo.setAttribute('role', 'img');
    cameo.setAttribute('aria-label', 'The mill seal, pressed in beeswax on your cloth');
    stampWrap.appendChild(cameo);
    card.appendChild(stampWrap);

    var no = el('div', 'ck-cardno', 'Nº ' + fmtSerial(celebrate ? Math.max(1, serial - 24) : serial));
    card.appendChild(no);
    var standing = commissioned && commissioned.standing;
    var runLine = 'Decke 01 · Run of 15,000' + (standing && standing.tier
      ? ' — ' + standing.tier + ' · ' + ordinal(standing.count) + ' entry'
      : '');
    card.appendChild(el('div', 'ck-cardrun', runLine));

    var rows = el('div', 'ck-cardrows');
    var rowData = order.is_gift && order.recipient
      ? [
          ['For ' + order.recipient, ''],
          ['from ' + (order.name || '—'), ''],
          [cw ? (cw.name + ' · ' + cw.desc) : '—', ''],
          ['Webbuch · ' + dateLine, '']
        ]
      : [
          [order.name || '—', ''],
          [cw ? (cw.name + ' · ' + cw.desc) : '—', ''],
          ['Webbuch · ' + dateLine, '']
        ];
    var r, rowEl;
    for (r = 0; r < rowData.length; r++) {
      rowEl = el('div', 'ck-cardrow' + rowData[r][1], rowData[r][0]);
      if (celebrate) { rowEl.style.animationDelay = (3700 + r * 170) + 'ms'; }
      rows.appendChild(rowEl);
    }
    card.appendChild(rows);

    if (celebrate) {
      /* the seal-press film fills the card, then recedes into the vignette;
         the photograph sits behind it so nothing waits on the network */
      var shot = el('div', 'ck-sealshot');
      shot.style.backgroundImage = 'url("' + art.seal + '")';
      shot.setAttribute('aria-hidden', 'true');
      if (art.film && window.HTMLVideoElement) {
        try {
          var film = document.createElement('video');
          film.muted = true;
          film.setAttribute('muted', '');
          film.setAttribute('playsinline', '');
          film.autoplay = true;
          film.preload = 'auto';
          film.src = art.film;
          film.playbackRate = 1.5;
          film.addEventListener('error', function () { film.remove(); });
          shot.appendChild(film);
          var playP = film.play();
          if (playP && playP['catch']) { playP['catch'](function () { /* still covers */ }); }
        } catch (eV) { /* the photograph carries the moment */ }
      }
      card.appendChild(shot);

      /* the number inks itself upward until it settles on the assigned Nº */
      var from = Math.max(1, serial - 24);
      var t0 = null;
      var tick = function (ts) {
        if (!card.isConnected) { return; }
        if (t0 === null) { t0 = ts; }
        var p = Math.min(1, (ts - t0) / 950);
        var eased = 1 - Math.pow(1 - p, 3);
        no.textContent = 'Nº ' + fmtSerial(Math.round(from + (serial - from) * eased));
        if (p < 1) { window.requestAnimationFrame(tick); }
        else {
          no.textContent = 'Nº ' + fmtSerial(serial);
          no.style.animation = 'ckFlare 1.3s ease-out both';
        }
      };
      setTimeout(function () { window.requestAnimationFrame(tick); }, 2800);
      startMotes(card, art.mote);
    }
    box.appendChild(card);
    box.appendChild(el('p', 'ck-demoline', DEMO_LINE));

    var returnRow = el('div', 'ck-returnrow');
    var againBtn = el('button', 'ck-finbtn ck-again', 'Commission another →');
    againBtn.type = 'button';
    againBtn.addEventListener('click', function () {
      commissioned = null;
      order.colorway = '';
      showAct(1, 1); /* details stay filled; only the cloth is chosen anew */
    });
    returnRow.appendChild(againBtn);
    var closeBtn = el('button', 'ck-finbtn ck-return', 'Return to the evening');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', function () { closePanel(); });
    returnRow.appendChild(closeBtn);
    box.appendChild(returnRow);

    return box;
  }

  /* ----------------------------------------------------------
     11. Panel open / close, focus trap, body lock
  ---------------------------------------------------------- */
  var panelOpen = false;
  var lastFocused = null;
  var savedBodyOverflow = '', savedHtmlOverflow = '';

  function lockBody() {
    savedBodyOverflow = document.body.style.overflow;
    savedHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }
  function unlockBody() {
    document.body.style.overflow = savedBodyOverflow;
    document.documentElement.style.overflow = savedHtmlOverflow;
  }

  /* Prefill for returning patrons: never overwrite anything typed. */
  function prefillFrom(src) {
    if (!src || typeof src !== 'object') { return; }
    var map = {
      name: 'name', email: 'email', address: 'address', address2: 'address2',
      city: 'city', state: 'state', zip: 'zip'
    };
    var k;
    for (k in map) {
      if (!order[map[k]] && typeof src[k] === 'string' && src[k]) {
        order[map[k]] = src[k];
      }
    }
  }
  var meFetched = false;
  function prefillReturning() {
    try {
      var lp = JSON.parse(window.localStorage.getItem('feier-patron') || 'null');
      if (lp) {
        prefillFrom({ name: lp.name, email: lp.email });   /* identity always */
        if (!lp.is_gift) { prefillFrom(lp); }              /* but a personal ship-to only */
      }
    } catch (eP) { /* fresh visitor */ }
    if (meFetched || isDemo() || !hasSb()) { return; }
    meFetched = true;
    getFreshToken().then(function (token) {
      if (!token) { return; }
      return fetch(commissionEndpoint() + '?me=1', {
        headers: { 'Authorization': 'Bearer ' + token }
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j) { return; }
        /* Prefer the MANAGED book (real, removable rows with ids); fall back to
           the derived view if it's empty (e.g. server not yet deployed). */
        patronAddresses = (Array.isArray(j.saved_addresses) && j.saved_addresses.length)
          ? j.saved_addresses
          : (Array.isArray(j.addresses) ? j.addresses : []);
        patronBillingAddresses = Array.isArray(j.billing_addresses) ? j.billing_addresses : [];
        /* Identity from the latest entry; the DEFAULT ship-to prefill is the most
           recent PERSONAL address, so a returning buyer whose last order was a
           gift doesn't inherit the recipient's door. Saved gift addresses stay
           available as taps in the book. */
        if (j.latest) { prefillFrom({ name: j.latest.name, email: j.latest.email }); }
        var home = null, i;
        for (i = 0; i < patronAddresses.length; i++) {
          if (!patronAddresses[i].is_gift) { home = patronAddresses[i]; break; }
        }
        if (home) { prefillFrom(home); pickedAddrKey = entryKey(home); }
        else if (j.latest && !j.latest.is_gift) { prefillFrom(j.latest); }
        if (panelOpen && act === 2) { showAct(2, 0); } /* re-render with the prefill */
      });
    })['catch'](function () { /* the form is still a form */ });
  }

  /* Opening to place a NEW order: if the last commission is already finished,
     clear it so we start a fresh entry instead of replaying its celebration
     card. (An in-progress entry — commissioned still null — is left to resume.) */
  function freshIfDone() {
    if (commissioned) {
      commissioned = null;
      act = 1;
      order.colorway = '';
      clearDraft();
    }
  }

  function openPanel() {
    if (!panel || panelOpen) { return; }
    panelOpen = true;
    trackOpen();
    pubCkState();
    refreshHold();
    prefillReturning();
    lastFocused = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement : null;
    /* resume where the visitor left off; a finished commission shows its card */
    var resumeAct = commissioned ? 4 : act;
    showAct(resumeAct, 0);
    scrim.classList.add('ck-on');
    panel.classList.add('ck-open');
    lockBody();
    setTimeout(function () {
      try { panel.focus(); } catch (e) { /* ignore */ }
    }, REDUCED ? 0 : 80);
  }

  function closePanel() {
    if (!panelOpen) { return; }
    panelOpen = false;
    pubCkState();
    panel.classList.remove('ck-open');
    scrim.classList.remove('ck-on');
    unlockBody();
    panel.style.bottom = '';
    panel.style.maxHeight = '';
    if (lastFocused && lastFocused.focus) {
      try { lastFocused.focus(); } catch (e) { /* ignore */ }
    }
    lastFocused = null;
  }

  function trapFocus(e) {
    if (e.key !== 'Tab') { return; }
    var focusables = panel.querySelectorAll(
      'button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) { return; }
    var list = [], i;
    for (i = 0; i < focusables.length; i++) {
      if (focusables[i].offsetParent !== null || focusables[i] === document.activeElement) {
        list.push(focusables[i]);
      }
    }
    if (!list.length) { return; }
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && panelOpen) {
      e.preventDefault();
      closePanel(); /* confirm-free abandon — state is kept for the return */
    }
  }

  /* ----------------------------------------------------------
     12. Bottom-sheet drag (mobile)
  ---------------------------------------------------------- */
  function initDrag(handle, head) {
    var startY = 0, delta = 0, dragging = false;

    function onStart(e) {
      if (window.innerWidth >= 900) { return; }
      dragging = true;
      delta = 0;
      startY = (e.touches ? e.touches[0].clientY : e.clientY);
      panel.classList.add('ck-dragging');
    }
    function onMove(e) {
      if (!dragging) { return; }
      var y = (e.touches ? e.touches[0].clientY : e.clientY);
      delta = y - startY;
      panel.style.transform = 'translateY(' + (delta > 0 ? delta : 0) + 'px)';
      if (e.cancelable) { e.preventDefault(); }
    }
    function onEnd() {
      if (!dragging) { return; }
      dragging = false;
      panel.classList.remove('ck-dragging');
      panel.style.transform = '';
      if (delta > 90) { closePanel(); }
      delta = 0;
    }

    var targets = [handle, head], t;
    for (t = 0; t < targets.length; t++) {
      if (!targets[t]) { continue; }
      targets[t].addEventListener('touchstart', onStart, { passive: true });
      targets[t].addEventListener('mousedown', onStart);
    }
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
  }

  /* ----------------------------------------------------------
     13. visualViewport — keep the sheet above the keyboard
  ---------------------------------------------------------- */
  function initVisualViewport() {
    var vv = window.visualViewport;
    if (!vv) { return; }
    function onVV() {
      if (!panelOpen || window.innerWidth >= 900) {
        panel.style.bottom = '';
        panel.style.maxHeight = '';
        return;
      }
      var inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      if (inset > 40) {
        panel.style.bottom = inset + 'px';
        panel.style.maxHeight = Math.max(240, vv.height - 12) + 'px';
      } else {
        panel.style.bottom = '';
        panel.style.maxHeight = '';
      }
    }
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
  }

  /* ----------------------------------------------------------
     14. Hooks — the page's commission buttons open the sheet.
         Only anchors to #reserve that are .btn or .nav-cta;
         other #reserve anchors keep their native scroll.
  ---------------------------------------------------------- */
  function hookReserveButtons() {
    var anchors = document.querySelectorAll('a[href="#reserve"]');
    var i, a;
    for (i = 0; i < anchors.length; i++) {
      a = anchors[i];
      if (!a.classList) { continue; }
      if (!(a.classList.contains('btn') || a.classList.contains('nav-cta'))) { continue; }
      (function (anchor) {
        anchor.addEventListener('click', function (e) {
          e.preventDefault();
          freshIfDone();
          openPanel();
        });
      })(a);
    }
  }

  /* ----------------------------------------------------------
     15. Boot
  ---------------------------------------------------------- */
  function boot() {
    injectStyle();
    buildUI();
    hookReserveButtons();
    initVisualViewport();
    document.addEventListener('keydown', onKeydown);

    /* restore a draft across reloads and the key's redirect round trip */
    var d = loadDraft();
    if (d) {
      var k;
      for (k in d.order) {
        if (Object.prototype.hasOwnProperty.call(d.order, k) &&
            Object.prototype.hasOwnProperty.call(order, k)) {
          order[k] = String(d.order[k] || '');
        }
      }
      if (typeof d.act === 'number' && d.act >= 1 && d.act <= 3) { act = d.act; }
      var fromKey = /[?&]code=/.test(window.location.search) ||
        window.location.hash.indexOf('access_token') > -1;
      if (fromKey && d.act >= 2) {
        ensureSb().then(function (sb) {
          var resume = function () { act = 3; openPanel(); };
          if (!sb) { resume(); return; }
          sb.auth.getSession().then(resume)['catch'](resume);
        });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ----------------------------------------------------------
     16. Public API
  ---------------------------------------------------------- */
  window.FeierabendCheckout = {
    open: function (opts) {
      var cw = opts && typeof opts === 'object' ? colorwayById(opts.colorway) : null;
      if (cw) {
        /* a colorway arrived with the open — start (or restart) the
           commission at Act I with that cloth already chosen */
        commissioned = null;
        order.colorway = cw.id;
        act = 1;
        saveDraft();
        if (panelOpen) { showAct(1, 0); } else { openPanel(); }
        return;
      }
      freshIfDone();
      openPanel();
    },
    close: function () { closePanel(); }
  };
})();
