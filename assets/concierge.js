/* ============================================================
   FEIERABEND — DECKE 01
   The Mill Concierge · assets/concierge.js
   Self-contained. No dependencies. Loaded with defer.
   All classes and ids are prefixed 'cx-'.
   Public API: window.FeierabendConcierge = { open(prefill), close() }
   ============================================================ */
(function () {
  'use strict';

  if (window.FeierabendConcierge) { return; }
  if (!document || !document.createElement) { return; }

  /* ----------------------------------------------------------
     0. Configuration & defensive reads
  ---------------------------------------------------------- */
  function cfg() {
    var c = window.FEIER_CONCIERGE_CONFIG;
    return (c && typeof c === 'object') ? c : {};
  }
  function endpoint() {
    var e = cfg().endpoint;
    return (typeof e === 'string') ? e.replace(/^\s+|\s+$/g, '') : '';
  }
  function isDemo() { return !endpoint(); }
  function supaUrl() {
    var u = cfg().supabaseUrl;
    return (typeof u === 'string') ? u.replace(/^\s+|\s+$/g, '').replace(/\/+$/, '') : '';
  }
  function supaKey() {
    var k = cfg().supabaseAnonKey;
    return (typeof k === 'string') ? k.replace(/^\s+|\s+$/g, '') : '';
  }
  function hasSupabase() { return !!(supaUrl() && supaKey()); }
  /* auth UI is creds-gated, and the mill can switch it off remotely */
  function authEnabled() { return hasSupabase() && remoteAuth !== false; }
  function kb() {
    var k = window.FEIER_KB;
    return (k && typeof k === 'object') ? k : {};
  }
  function kbImages() {
    var i = kb().images;
    return (i && typeof i === 'object') ? i : {};
  }
  /* remote starters (from ?config=1) REPLACE the KB map when present */
  function suggestedMap() {
    if (remoteStarters) { return remoteStarters; }
    var s = kb().suggested;
    return (s && typeof s === 'object') ? s : null;
  }
  function kbSuggested(sectionId) {
    var s = suggestedMap();
    if (!s) { return []; }
    var list = (sectionId && s[sectionId]) ? s[sectionId] : s['default'];
    if (Object.prototype.toString.call(list) !== '[object Array]') { return []; }
    return list.slice(0, 3);
  }
  function kbDemoEntries() {
    var d = kb().demo;
    return (Object.prototype.toString.call(d) === '[object Array]') ? d : [];
  }
  function kbGreeting() {
    if (remoteGreeting) { return remoteGreeting; }
    var g = kb().greeting;
    if (typeof g === 'string' && g.length) { return g; }
    return 'Good evening. I keep the register at the mill — ask me about the wool, ' +
      'the weave, or the number that will be yours.';
  }
  function freshState() {
    var s = window.__feierState;
    s = (s && typeof s === 'object') ? s : {};
    return {
      section: (typeof s.section === 'string' && s.section) ? s.section : currentSection(),
      claimed: (s.claimed != null) ? s.claimed : null,
      remaining: (s.remaining != null) ? s.remaining : null,
      slot: (s.slot != null) ? s.slot : null,
      holdClock: (s.holdClock != null) ? s.holdClock : null,
      loomClock: (s.loomClock != null) ? s.loomClock : null
    };
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

  var SECTIONS = ['top', 'why', 'wool', 'label', 'ritual', 'arrival', 'reserve'];
  var INLINE_SECTIONS = ['why', 'wool', 'label', 'ritual', 'arrival'];
  var HISTORY_KEY = 'cx-history';
  var SKEY_KEY = 'cx-skey';
  var HISTORY_CAP = 40;
  var SEND_TURNS = 12;
  var ERROR_LINE = 'The line to the mill is quiet. Try once more, or write hello@feierabend.example.';
  var BUSY_LINE = 'The mill is resting. Try again in a moment.';
  var STAMP_SRC = 'assets/concierge-stamp.webp';
  var SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  var TRACK_QUESTION = 'Where is my blanket?';

  /* ----------------------------------------------------------
     0b. Session key — one random id per browser session
  ---------------------------------------------------------- */
  var _sessionKey = '';
  function sessionKey() {
    if (_sessionKey) { return _sessionKey; }
    var k = null;
    try { k = window.sessionStorage.getItem(SKEY_KEY); } catch (eK) { k = null; }
    if (k) { _sessionKey = k; return k; }
    k = 'sk-';
    try {
      var buf = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(buf);
      var b;
      for (b = 0; b < buf.length; b++) { k += (buf[b] + 256).toString(16).slice(1); }
    } catch (eR) {
      k += Date.now().toString(36) +
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 10);
    }
    try { window.sessionStorage.setItem(SKEY_KEY, k); } catch (eS) { /* ignore */ }
    _sessionKey = k;
    return k;
  }

  /* ----------------------------------------------------------
     0c. Remote config (?config=1) — 3s budget, failures swallowed
  ---------------------------------------------------------- */
  var remoteCfgOk = false;      /* fetch succeeded and parsed */
  var remoteEnabled = null;     /* true/false once fetched */
  var remoteGreeting = '';
  var remoteStarters = null;    /* replaces FEIER_KB.suggested when present */
  var remoteAuth = null;

  function sanitizeStarters(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    var out = {}, any = false, key, list, i, clean;
    for (key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) { continue; }
      list = raw[key];
      if (Object.prototype.toString.call(list) !== '[object Array]') { continue; }
      clean = [];
      for (i = 0; i < list.length; i++) {
        if (typeof list[i] === 'string' && list[i]) { clean.push(list[i]); }
      }
      out[key] = clean;
      any = true;
    }
    return any ? out : null;
  }

  function fetchRemoteConfig(cb) {
    if (!endpoint()) { cb(); return; }
    var settled = false;
    function finish() {
      if (settled) { return; }
      settled = true;
      cb();
    }
    var ac = null;
    try { ac = new AbortController(); } catch (eA) { ac = null; }
    var timer = setTimeout(function () {
      if (ac) { try { ac.abort(); } catch (eT) { /* ignore */ } }
      finish();
    }, 3000);
    var url = endpoint() + (endpoint().indexOf('?') === -1 ? '?config=1' : '&config=1');
    try {
      fetch(url, { method: 'GET', signal: ac ? ac.signal : undefined }).then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      }).then(function (j) {
        if (j && typeof j === 'object') {
          remoteCfgOk = true;
          remoteEnabled = (j.enabled !== false);
          if (typeof j.greeting === 'string' && j.greeting) { remoteGreeting = j.greeting; }
          var st = sanitizeStarters(j.starters);
          if (st) { remoteStarters = st; }
          if (j.auth != null) { remoteAuth = j.auth; }
        }
        clearTimeout(timer);
        finish();
      })['catch'](function () {
        clearTimeout(timer);
        finish();
      });
    } catch (eF) {
      clearTimeout(timer);
      finish();
    }
  }

  /* ----------------------------------------------------------
     1. Styles — glass loden
  ---------------------------------------------------------- */
  function injectStyle() {
    var css = [
      ':root{--cx-glass:rgba(23,31,26,.92);--cx-hair:rgba(196,155,91,.35);--cx-hair-soft:rgba(196,155,91,.18);',
      '--cx-ink:var(--wool,#F1ECE2);--cx-brass:var(--brass,#A67C3D);--cx-brass-soft:var(--brass-soft,#C49B5B);}',

      /* ---------- launcher ---------- */
      '.cx-launch{position:fixed;left:50%;bottom:calc(1rem + env(safe-area-inset-bottom,0px));',
      'transform:translateX(-50%);z-index:80;display:inline-flex;align-items:center;gap:.55rem;',
      'min-height:44px;padding:.7rem 1.3rem;background:var(--cx-glass);',
      '-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);',
      'border:1px solid var(--cx-hair);border-radius:999px;cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.66rem;letter-spacing:.2em;',
      'text-transform:uppercase;color:var(--cx-ink);opacity:0;pointer-events:none;',
      'transition:opacity .45s ease,transform .45s ease;will-change:transform,opacity;}',
      '.cx-launch .cx-star{color:var(--cx-brass-soft);font-size:.85rem;line-height:1;transform:translateY(-1px);}',
      '.cx-launch.cx-on{opacity:1;pointer-events:auto;}',
      '.cx-launch.cx-tuck{opacity:0;transform:translateX(-50%) translateY(140%);pointer-events:none;}',
      '.cx-launch:hover{border-color:rgba(196,155,91,.6);}',
      '.cx-launch:focus-visible{outline:1px solid var(--cx-brass-soft);outline-offset:3px;}',
      /* docked circular form over the reserve section */
      '.cx-launch.cx-dock{left:auto;right:calc(1rem + env(safe-area-inset-right,0px));transform:none;',
      'width:48px;height:48px;min-height:48px;padding:0;justify-content:center;border-radius:50%;}',
      '.cx-launch.cx-dock .cx-label{display:none;}',
      '.cx-launch.cx-dock.cx-tuck{transform:translateY(140%);}',

      /* ---------- context chip ---------- */
      '.cx-chip{position:fixed;left:50%;bottom:calc(1rem + env(safe-area-inset-bottom,0px) + 62px);',
      'transform:translateX(-50%);z-index:80;max-width:min(86vw,26rem);',
      'padding:.65rem 1rem;min-height:44px;display:inline-flex;align-items:center;',
      'background:var(--cx-glass);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);',
      'border:1px solid var(--cx-hair);border-radius:2px;cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.62rem;letter-spacing:.16em;',
      'text-transform:uppercase;color:var(--cx-ink);text-align:left;line-height:1.5;',
      'opacity:0;transition:opacity .6s ease;}',
      '.cx-chip.cx-on{opacity:1;}',
      '.cx-chip:hover{border-color:rgba(196,155,91,.6);}',

      /* ---------- scrim ---------- */
      '.cx-scrim{position:fixed;inset:0;z-index:81;background:rgba(23,31,26,.35);',
      'opacity:0;pointer-events:none;transition:opacity .35s ease;}',
      '.cx-scrim.cx-on{opacity:1;pointer-events:auto;}',

      /* ---------- panel ---------- */
      '.cx-panel{position:fixed;z-index:82;display:flex;flex-direction:column;',
      'background:var(--cx-glass);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);',
      'color:var(--cx-ink);visibility:hidden;}',
      '.cx-panel:focus{outline:none;}',

      '@media (max-width:899px){',
      '.cx-panel{left:0;right:0;bottom:0;height:68svh;max-height:100svh;border-radius:14px 14px 0 0;',
      'border-top:1px solid var(--cx-hair);transform:translateY(105%);',
      'transition:transform .5s cubic-bezier(.22,.8,.28,1),height .35s ease,visibility 0s linear .5s;}',
      '.cx-panel.cx-open{transform:translateY(0);visibility:visible;transition:transform .5s cubic-bezier(.22,.8,.28,1),height .35s ease;}',
      '.cx-panel.cx-tall{height:92svh;}',
      '.cx-panel.cx-dragging{transition:none;}',
      '.cx-handle{flex:0 0 auto;padding:.55rem 0 .2rem;display:flex;justify-content:center;cursor:grab;touch-action:none;}',
      '.cx-handle::before{content:"";width:38px;height:3px;border-radius:2px;background:rgba(196,155,91,.45);}',
      '.cx-head{padding:0 1.4rem .6rem !important;gap:.6rem !important;min-height:auto !important;}',
      '.cx-close{margin:-.3rem -.7rem 0 0 !important;}',
      '.cx-authmail{display:none !important;}',
      '.cx-compose{padding:.5rem 1.4rem .6rem !important;}',
      '.cx-foot{display:none !important;}',
      '}',

      '@media (min-width:900px){',
      '.cx-panel{top:0;right:0;bottom:0;width:420px;border-left:1px solid var(--cx-hair);',
      'transform:translateX(105%);transition:transform .5s cubic-bezier(.22,.8,.28,1),visibility 0s linear .5s;}',
      '.cx-panel.cx-open{transform:translateX(0);visibility:visible;transition:transform .5s cubic-bezier(.22,.8,.28,1);}',
      '.cx-handle{display:none;}',
      '}',

      /* ---------- header ---------- */
      '.cx-head{flex:0 0 auto;display:flex;align-items:flex-start;justify-content:space-between;',
      'gap:1rem;padding:1.1rem 1.4rem .95rem;border-bottom:1px solid var(--cx-hair-soft);}',
      '.cx-title{font-family:"Gloock",serif;font-weight:400;font-size:1.28rem;line-height:1.2;',
      'color:var(--cx-ink);margin:0;}',
      '.cx-sub{display:flex;align-items:center;gap:.5rem;margin-top:.4rem;',
      'font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.22em;',
      'text-transform:uppercase;color:rgba(241,236,226,.55);white-space:nowrap;overflow:hidden;}',
      '.cx-sub span{overflow:hidden;text-overflow:ellipsis;}',
      '.cx-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;}',
      '.cx-dot.cx-demo{background:#C8973F;box-shadow:0 0 6px rgba(200,151,63,.5);}',
      '.cx-dot.cx-live{background:#6FA57A;box-shadow:0 0 6px rgba(111,165,122,.5);}',
      '.cx-close{flex:0 0 auto;width:44px;height:44px;margin:-.55rem -.7rem 0 0;',
      'display:flex;align-items:center;justify-content:center;background:none;border:none;',
      'color:rgba(241,236,226,.65);font-size:1.25rem;line-height:1;cursor:pointer;font-family:"Hanken Grotesk",sans-serif;}',
      '.cx-close:hover{color:var(--cx-ink);}',
      '.cx-close:focus-visible{outline:1px solid var(--cx-brass-soft);outline-offset:2px;}',

      /* ---------- message list ---------- */
      '.cx-msgs{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:.4rem 1.4rem 1rem;',
      '-webkit-overflow-scrolling:touch;overscroll-behavior:contain;position:relative;}',
      '.cx-turn{padding:1.05rem 0;border-bottom:1px solid var(--cx-hair-soft);}',
      '.cx-turn:last-child{border-bottom:none;}',
      '.cx-turn-user{text-align:right;font-family:"IBM Plex Mono",monospace;font-size:.66rem;',
      'letter-spacing:.18em;text-transform:uppercase;color:rgba(241,236,226,.78);line-height:1.7;',
      'word-break:break-word;}',
      '.cx-turn-assistant{font-family:"Hanken Grotesk",sans-serif;font-weight:300;',
      'font-size:.95rem;line-height:1.65;color:var(--cx-ink);word-break:break-word;}',
      '.cx-turn-assistant p{margin:0 0 .85em;}',
      '.cx-turn-assistant p:last-child{margin-bottom:0;}',
      '.cx-turn-assistant strong{font-weight:600;}',
      '.cx-turn-assistant em{font-style:italic;}',
      '.cx-turn-assistant code{font-family:"IBM Plex Mono",monospace;font-size:.8em;',
      'padding:.08em .35em;border:1px solid var(--cx-hair-soft);background:rgba(241,236,226,.05);}',
      '.cx-turn-assistant ul,.cx-turn-assistant ol{margin:0 0 .85em;padding-left:1.15rem;}',
      '.cx-turn-assistant li{margin:.25em 0;}',
      '.cx-turn-assistant a{color:var(--cx-brass-soft);text-decoration:none;',
      'border-bottom:1px solid var(--cx-hair);}',
      '.cx-turn-assistant a:hover{border-bottom-color:var(--cx-brass-soft);}',
      '.cx-pre{white-space:pre-wrap;}',

      /* tables */
      '.cx-tablewrap{overflow-x:auto;margin:0 0 .85em;border:1px solid var(--cx-hair-soft);}',
      '.cx-turn-assistant table{border-collapse:collapse;width:100%;',
      'font-family:"IBM Plex Mono",monospace;font-size:.72rem;line-height:1.5;}',
      '.cx-turn-assistant th{font-weight:500;text-transform:uppercase;letter-spacing:.12em;',
      'font-size:.62rem;color:var(--cx-brass-soft);text-align:left;}',
      '.cx-turn-assistant th,.cx-turn-assistant td{padding:.5rem .75rem;',
      'border-bottom:1px solid var(--cx-hair-soft);white-space:nowrap;}',
      '.cx-turn-assistant tr:last-child td{border-bottom:none;}',

      /* figures */
      '.cx-fig{margin:.2em 0 .95em;}',
      '.cx-fig img{display:block;max-width:100%;height:auto;border:1px solid var(--cx-hair-soft);}',
      '.cx-actionrow{margin:.3em 0 .9em;}',
      '.cx-action{min-height:44px;display:inline-flex;align-items:center;gap:.5rem;cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;',
      'color:var(--cx-loden-deep,#171F1A);background:var(--cx-brass-soft);border:1px solid var(--cx-brass-soft);',
      'padding:.65rem 1.25rem;transition:background .25s,color .25s;}',
      '.cx-action:hover{background:transparent;color:var(--cx-brass-soft);}',
      '.cx-fade-in{animation:cxFade .6s ease both;}',
      '@keyframes cxFade{from{opacity:0;}to{opacity:1;}}',

      /* caret (weaving shuttle) + woven-word entrance + dots */
      '.cx-caret{display:inline-block;width:13px;height:2px;background:var(--cx-brass-soft);',
      'vertical-align:baseline;margin-left:3px;border-radius:1px;transform-origin:left center;',
      'animation:cxShuttle .9s ease-in-out infinite;}',
      '@keyframes cxShuttle{0%,100%{transform:scaleX(1);opacity:.9;}50%{transform:scaleX(.35);opacity:.45;}}',
      '.cx-w{opacity:0;filter:blur(2.5px);color:var(--cx-brass-soft);',
      'transition:opacity .3s ease,filter .42s ease,color .8s ease;}',
      '.cx-w.cx-w-in{opacity:1;filter:blur(0);color:inherit;}',
      '.cx-dots{display:inline-flex;gap:6px;align-items:center;padding:.3em 0;}',
      '.cx-dots i{width:3px;height:3px;border-radius:50%;background:var(--cx-brass-soft);',
      'animation:cxWeave 1.1s ease-in-out infinite;}',
      '.cx-dots i:nth-child(2){animation-delay:.18s;}',
      '.cx-dots i:nth-child(3){animation-delay:.36s;}',
      '@keyframes cxWeave{0%,100%{transform:translateY(0);opacity:.4;}50%{transform:translateY(-4px);opacity:1;}}',
      '.cx-status{font-family:"IBM Plex Mono",monospace;font-size:.62rem;letter-spacing:.14em;',
      'text-transform:uppercase;color:rgba(196,155,91,.75);margin-left:10px;vertical-align:middle;}',

      /* error + system lines */
      '.cx-sysline{font-family:"IBM Plex Mono",monospace;font-size:.64rem;letter-spacing:.14em;',
      'text-transform:uppercase;line-height:1.8;color:rgba(241,236,226,.6);}',

      /* suggestion chips inside panel */
      '.cx-suggest{display:flex;flex-direction:column;align-items:flex-start;gap:.5rem;',
      'padding:.9rem 0 .3rem;}',
      '.cx-sbtn{min-height:44px;display:inline-flex;align-items:center;text-align:left;',
      'padding:.55rem .9rem;background:transparent;border:1px solid var(--cx-hair);',
      'border-radius:2px;color:var(--cx-ink);cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.62rem;letter-spacing:.16em;',
      'text-transform:uppercase;line-height:1.5;transition:border-color .25s ease;}',
      '.cx-sbtn:hover{border-color:rgba(196,155,91,.65);}',
      '.cx-sbtn:focus-visible{outline:1px solid var(--cx-brass-soft);outline-offset:2px;}',

      /* new-messages pill */
      '.cx-newpill{position:absolute;left:50%;transform:translateX(-50%);',
      'bottom:calc(100% + .6rem);z-index:2;padding:.45rem .9rem;min-height:34px;',
      'background:var(--cx-glass);border:1px solid var(--cx-hair);border-radius:999px;',
      'font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.18em;',
      'text-transform:uppercase;color:var(--cx-brass-soft);cursor:pointer;',
      'opacity:0;pointer-events:none;transition:opacity .3s ease;}',
      '.cx-newpill.cx-on{opacity:1;pointer-events:auto;}',

      /* ---------- composer ---------- */
      '.cx-compose{flex:0 0 auto;position:relative;padding:.85rem 1.4rem .4rem;',
      'border-top:1px solid var(--cx-hair);}',
      '.cx-inputrow{display:flex;align-items:flex-end;gap:.7rem;}',
      '.cx-input{flex:1 1 auto;resize:none;background:transparent;border:none;',
      'border-bottom:1px solid var(--cx-hair-soft);color:var(--cx-ink);',
      'font-family:"Hanken Grotesk",sans-serif;font-weight:300;font-size:16px;line-height:1.5;',
      'padding:.4rem 0;min-height:44px;max-height:calc(3 * 1.5em + .8rem);overflow-y:auto;}',
      '.cx-input:focus{outline:none;border-bottom-color:var(--cx-hair);}',
      '.cx-input::placeholder{font-family:"IBM Plex Mono",monospace;font-size:.68rem;',
      'letter-spacing:.16em;text-transform:uppercase;color:rgba(241,236,226,.4);}',
      '.cx-input:disabled{opacity:.45;}',
      '.cx-send{flex:0 0 auto;width:44px;height:44px;display:flex;align-items:center;',
      'justify-content:center;background:transparent;border:1px solid var(--cx-hair);',
      'border-radius:50%;color:var(--cx-brass-soft);font-size:1rem;cursor:pointer;',
      'transition:border-color .25s ease,color .25s ease;}',
      '.cx-send:hover:not(:disabled){border-color:var(--cx-brass-soft);color:var(--cx-ink);}',
      '.cx-send:disabled{opacity:.35;cursor:default;}',
      '.cx-send:focus-visible{outline:1px solid var(--cx-brass-soft);outline-offset:2px;}',

      '.cx-foot{flex:0 0 auto;padding:.35rem 1.4rem calc(.8rem + env(safe-area-inset-bottom,0px));',
      'font-family:"IBM Plex Mono",monospace;font-size:.58rem;letter-spacing:.14em;',
      'text-transform:uppercase;color:var(--cx-ink);opacity:.45;line-height:1.7;}',

      /* ---------- mill stamp (avatar) ---------- */
      '.cx-stamp{flex:0 0 auto;width:28px;height:28px;border-radius:50%;object-fit:cover;',
      'border:1px solid var(--cx-hair);margin-top:.15rem;}',
      '.cx-stamp-mini{width:18px;height:18px;border-radius:50%;object-fit:cover;',
      'border:1px solid var(--cx-hair-soft);flex:0 0 auto;}',
      '.cx-think{display:inline-flex;align-items:center;gap:.5rem;}',
      '.cx-headleft{flex:1 1 auto;min-width:0;}',

      /* ---------- top-hairline shimmer (once per open) ---------- */
      '.cx-shimline{position:absolute;top:0;left:0;right:0;height:1px;overflow:hidden;',
      'pointer-events:none;z-index:3;}',
      '.cx-shimline i{position:absolute;top:0;left:0;width:34%;height:100%;',
      'background:linear-gradient(90deg,transparent,rgba(196,155,91,.85),transparent);',
      'transform:translateX(-110%);animation:cxShim 2s ease .1s both;}',
      '@keyframes cxShim{from{transform:translateX(-110%);}to{transform:translateX(420%);}}',

      /* ---------- account (magic link) ---------- */
      '.cx-authbox{flex:0 0 auto;display:flex;align-items:center;gap:.55rem;',
      'margin-left:auto;margin-top:-.2rem;min-width:0;}',
      '.cx-authmail{font-family:"IBM Plex Mono",monospace;font-size:.58rem;letter-spacing:.12em;',
      'text-transform:uppercase;color:rgba(241,236,226,.55);max-width:8.5rem;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap;}',
      '.cx-authlink{background:none;border:none;padding:.6rem .2rem;min-height:44px;cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.58rem;letter-spacing:.18em;',
      'text-transform:uppercase;color:var(--cx-brass-soft);white-space:nowrap;}',
      '.cx-authlink:hover{color:var(--cx-ink);}',
      '.cx-authlink:focus-visible{outline:1px solid var(--cx-brass-soft);outline-offset:2px;}',
      '.cx-authrow{flex:0 0 auto;padding:.85rem 1.4rem .95rem;border-bottom:1px solid var(--cx-hair-soft);}',
      '.cx-authcap{font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.16em;',
      'text-transform:uppercase;color:rgba(241,236,226,.6);line-height:1.7;}',
      '.cx-authline{display:flex;align-items:flex-end;gap:.7rem;margin-top:.55rem;}',
      '.cx-authinput{flex:1 1 auto;min-width:0;background:transparent;border:none;',
      'border-bottom:1px solid var(--cx-hair-soft);color:var(--cx-ink);',
      'font-family:"Hanken Grotesk",sans-serif;font-weight:300;font-size:16px;line-height:1.4;',
      'padding:.35rem 0;min-height:40px;}',
      '.cx-authinput:focus{outline:none;border-bottom-color:var(--cx-hair);}',
      '.cx-authinput::placeholder{font-family:"IBM Plex Mono",monospace;font-size:.66rem;',
      'letter-spacing:.14em;text-transform:uppercase;color:rgba(241,236,226,.35);}',
      '.cx-authsend{flex:0 0 auto;min-height:40px;padding:.45rem .9rem;background:transparent;',
      'border:1px solid var(--cx-hair);border-radius:2px;color:var(--cx-brass-soft);cursor:pointer;',
      'font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.18em;',
      'text-transform:uppercase;transition:border-color .25s ease;}',
      '.cx-authsend:hover:not(:disabled){border-color:var(--cx-brass-soft);}',
      '.cx-authsend:disabled{opacity:.45;cursor:default;}',
      '.cx-authsend:focus-visible{outline:1px solid var(--cx-brass-soft);outline-offset:2px;}',
      '.cx-signedline{margin-top:.7rem;font-family:"IBM Plex Mono",monospace;font-size:.6rem;',
      'letter-spacing:.18em;text-transform:uppercase;color:rgba(241,236,226,.5);}',

      /* ---------- feedback (↑ / ↓) ---------- */
      '.cx-fb{display:flex;justify-content:flex-end;align-items:center;gap:.15rem;margin-top:.35rem;}',
      '.cx-fbbtn{background:none;border:none;min-width:44px;min-height:44px;padding:.8rem .85rem;',
      'font-family:"IBM Plex Mono",monospace;font-size:.85rem;line-height:1;cursor:pointer;',
      'color:var(--cx-ink);opacity:.4;transition:opacity .25s ease,color .25s ease;}',
      '.cx-fbbtn:hover:not(:disabled){opacity:1;color:var(--cx-brass-soft);}',
      '.cx-fbbtn:disabled{cursor:default;}',
      '.cx-fbbtn:focus-visible{outline:1px solid var(--cx-brass-soft);outline-offset:2px;}',
      '.cx-fbnote{font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.18em;',
      'text-transform:uppercase;color:rgba(241,236,226,.5);padding:.4rem 0;}',

      /* ---------- inline starters woven into the page ---------- */
      '.cx-inline{display:flex;align-items:center;gap:.85rem;width:100%;max-width:80rem;',
      'margin:clamp(2rem,5vh,3.25rem) auto 0;padding:1.1rem 0;background:none;border:0;',
      'border-top:1px solid rgba(196,155,91,.28);border-radius:0;cursor:pointer;text-align:left;',
      'font-family:"IBM Plex Mono",monospace;',
      'grid-column:1/-1;position:relative;z-index:2;color:var(--wool,#F1ECE2);}',
      '.cx-inline-ink{color:var(--ink,#26332B);}',
      '.cx-inline-pad{padding-left:clamp(1.25rem,4vw,4rem);padding-right:clamp(1.25rem,4vw,4rem);}',
      '.cx-inline .cx-inline-star{flex:0 0 auto;color:var(--brass,#A67C3D);font-size:.85rem;line-height:1;}',
      '.cx-inline .cx-inline-q{flex:1 1 auto;font-family:"IBM Plex Mono",monospace;font-size:.68rem;',
      'letter-spacing:.18em;text-transform:uppercase;line-height:1.6;opacity:.65;',
      'transition:opacity .3s ease;}',
      '.cx-inline .cx-inline-arrow{flex:0 0 auto;color:var(--brass-soft,#C49B5B);font-size:.9rem;',
      'line-height:1;transform:translateX(0);transition:transform .3s ease;}',
      '.cx-inline:hover .cx-inline-q,.cx-inline:focus-visible .cx-inline-q{opacity:1;}',
      '.cx-inline:hover .cx-inline-arrow{transform:translateX(4px);}',
      '.cx-inline:focus-visible{outline:1px solid var(--brass-soft,#C49B5B);outline-offset:4px;}',

      /* ---------- reduced motion ---------- */
      '.cx-reduced,.cx-reduced *{transition:none !important;animation:none !important;}',
      '.cx-reduced .cx-caret{opacity:1;}',
      '.cx-reduced .cx-dots i{opacity:.8;transform:none;}',

      '@media (prefers-reduced-motion:reduce){',
      '.cx-launch,.cx-chip,.cx-scrim,.cx-panel,.cx-newpill,.cx-sbtn,.cx-send,',
      '.cx-inline .cx-inline-q,.cx-inline .cx-inline-arrow,.cx-fbbtn,.cx-authsend{transition:none !important;}',
      '.cx-caret,.cx-dots i,.cx-fade-in,.cx-shimline i{animation:none !important;}',
      '}'
    ].join('');
    var tag = document.createElement('style');
    tag.id = 'cx-style';
    tag.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(tag);
  }

  /* ----------------------------------------------------------
     2. Tiny DOM helpers (no innerHTML anywhere near input)
  ---------------------------------------------------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.appendChild(document.createTextNode(String(text))); }
    return n;
  }

  /* mill-stamp emblem — hides itself if the asset is missing */
  function stampImg(cls) {
    var img = document.createElement('img');
    img.className = cls;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.onerror = function () { img.style.display = 'none'; };
    img.src = STAMP_SRC;
    return img;
  }

  /* status dot: green only when the mill line is verified live */
  function syncStatusDot() {
    if (!statusDot) { return; }
    if (endpoint() && remoteCfgOk && remoteEnabled === true) {
      statusDot.className = 'cx-dot cx-live';
      statusDot.title = 'Live';
    } else {
      statusDot.className = 'cx-dot cx-demo';
      statusDot.title = isDemo()
        ? 'Demo — answers from the product register'
        : 'Standing by — the mill line is unverified';
    }
  }

  /* ----------------------------------------------------------
     3. Markdown renderer — SECURITY CRITICAL
        Builds a DocumentFragment via createElement/textContent only.
  ---------------------------------------------------------- */
  var INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]*\]\([^)\s]+\))/g;
  var LINK_RE = /^\[([^\]]*)\]\(([^)\s]+)\)$/;

  function safeUrl(url) {
    return /^https:\/\//i.test(url) || /^mailto:/i.test(url);
  }

  function renderInline(text, target) {
    /* per-call regex instance: the shared global's lastIndex gets clobbered
       by recursive calls (nested bold/italic), which loops forever */
    var re = new RegExp(INLINE_RE.source, 'g');
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        target.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      var tok = m[0], node;
      if (m[1]) { /* `code` */
        node = el('code', null, tok.slice(1, -1));
        target.appendChild(node);
      } else if (m[2]) { /* **bold** */
        node = document.createElement('strong');
        renderInline(tok.slice(2, -2), node);
        target.appendChild(node);
      } else if (m[3]) { /* *italic* */
        node = document.createElement('em');
        renderInline(tok.slice(1, -1), node);
        target.appendChild(node);
      } else if (m[4]) { /* [text](url) */
        var lm = LINK_RE.exec(tok);
        if (lm && safeUrl(lm[2])) {
          node = document.createElement('a');
          node.setAttribute('href', lm[2]);
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
          node.appendChild(document.createTextNode(lm[1] || lm[2]));
          target.appendChild(node);
        } else {
          target.appendChild(document.createTextNode(tok));
        }
      }
      last = re.lastIndex;
    }
    if (last < text.length) {
      target.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function isTableSep(line) {
    return /^\s*\|?[\s:\-|]+\|?\s*$/.test(line) && line.indexOf('-') !== -1;
  }
  function splitTableRow(line) {
    var t = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    var cells = t.split('|'), out = [], i;
    for (i = 0; i < cells.length; i++) { out.push(cells[i].replace(/^\s+|\s+$/g, '')); }
    return out;
  }

  function mdRender(text) {
    var frag = document.createDocumentFragment();
    if (typeof text !== 'string' || !text.length) { return frag; }
    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    var i = 0, n = lines.length;
    var para = [];
    var images = kbImages();

    function flushPara() {
      if (!para.length) { return; }
      var p = document.createElement('p');
      renderInline(para.join('\n'), p);
      frag.appendChild(p);
      para = [];
    }

    while (i < n) {
      var line = lines[i];
      var trimmed = line.replace(/^\s+|\s+$/g, '');

      /* blank line — paragraph break */
      if (!trimmed) { flushPara(); i++; continue; }

      /* {{img:token}} line */
      var imgm = /^\{\{img:([A-Za-z0-9_-]+)\}\}$/.exec(trimmed);
      if (imgm) {
        flushPara();
        var meta = images[imgm[1]];
        if (meta && typeof meta === 'object' && typeof meta.src === 'string') {
          var fig = document.createElement('figure');
          fig.className = 'cx-fig cx-fade-in';
          var img = document.createElement('img');
          img.setAttribute('loading', 'lazy');
          img.setAttribute('src', meta.src);
          img.setAttribute('alt', (typeof meta.alt === 'string') ? meta.alt : '');
          fig.appendChild(img);
          frag.appendChild(fig);
        }
        i++; continue;
      }

      /* {{action:token}} line — whitelisted action buttons */
      var actm = /^\{\{action:(commission|signin)\}\}$/.exec(trimmed);
      if (actm) {
        flushPara();
        var actName = actm[1];
        var canDo = actName === 'commission'
          ? (window.FeierabendCheckout && typeof window.FeierabendCheckout.open === 'function')
          : authEnabled();
        if (canDo) {
          var act = el('div', 'cx-actionrow cx-fade-in');
          var ab = el('button', 'cx-action',
            actName === 'commission' ? '✳ Begin the commission' : '✳ Sign in — the key arrives by mail');
          ab.type = 'button';
          ab.addEventListener('click', actName === 'commission'
            ? function () { closePanel(); window.FeierabendCheckout.open(); }
            : function () { openAuthRow(); });
          act.appendChild(ab);
          frag.appendChild(act);
        }
        i++; continue;
      }

      /* pipe table: needs header row + separator row */
      if (trimmed.charAt(0) === '|' && i + 1 < n && isTableSep(lines[i + 1])) {
        flushPara();
        var header = splitTableRow(trimmed);
        var rows = [];
        var j = i + 2;
        while (j < n) {
          var rt = lines[j].replace(/^\s+|\s+$/g, '');
          if (!rt || rt.charAt(0) !== '|') { break; }
          rows.push(splitTableRow(rt));
          j++;
        }
        var wrap = el('div', 'cx-tablewrap cx-fade-in');
        var table = document.createElement('table');
        var thead = document.createElement('thead');
        var trh = document.createElement('tr');
        var c;
        for (c = 0; c < header.length; c++) {
          var th = document.createElement('th');
          renderInline(header[c], th);
          trh.appendChild(th);
        }
        thead.appendChild(trh);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        var r;
        for (r = 0; r < rows.length; r++) {
          var tr = document.createElement('tr');
          for (c = 0; c < header.length; c++) {
            var td = document.createElement('td');
            renderInline(rows[r][c] != null ? rows[r][c] : '', td);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        frag.appendChild(wrap);
        i = j; continue;
      }

      /* unordered list */
      if (/^-\s+/.test(trimmed)) {
        flushPara();
        var ul = document.createElement('ul');
        while (i < n) {
          var ut = lines[i].replace(/^\s+|\s+$/g, '');
          if (!/^-\s+/.test(ut)) { break; }
          var li = document.createElement('li');
          renderInline(ut.replace(/^-\s+/, ''), li);
          ul.appendChild(li);
          i++;
        }
        frag.appendChild(ul);
        continue;
      }

      /* ordered list */
      if (/^\d+[.)]\s+/.test(trimmed)) {
        flushPara();
        var ol = document.createElement('ol');
        while (i < n) {
          var ot = lines[i].replace(/^\s+|\s+$/g, '');
          if (!/^\d+[.)]\s+/.test(ot)) { break; }
          var oli = document.createElement('li');
          renderInline(ot.replace(/^\d+[.)]\s+/, ''), oli);
          ol.appendChild(oli);
          i++;
        }
        frag.appendChild(ol);
        continue;
      }

      /* plain paragraph line */
      para.push(trimmed);
      i++;
    }
    flushPara();
    return frag;
  }

  /* ----------------------------------------------------------
     4. Section tracking
  ---------------------------------------------------------- */
  var observedSection = SECTIONS[0];
  function currentSection() {
    var s = window.__feierState;
    if (s && typeof s === 'object' && typeof s.section === 'string' && s.section) {
      return s.section;
    }
    return observedSection;
  }
  function initSectionObserver() {
    if (!('IntersectionObserver' in window)) { return; }
    var ratios = {};
    var io = new IntersectionObserver(function (entries) {
      var i;
      for (i = 0; i < entries.length; i++) {
        ratios[entries[i].target.id] = entries[i].isIntersecting ? entries[i].intersectionRatio : 0;
      }
      var best = null, bestR = 0, id;
      for (id in ratios) {
        if (ratios.hasOwnProperty(id) && ratios[id] > bestR) { bestR = ratios[id]; best = id; }
      }
      if (best && best !== observedSection) {
        observedSection = best;
        onSectionChange(best);
      } else if (best) {
        observedSection = best;
      }
    }, { threshold: [0, 0.15, 0.3, 0.5, 0.75, 1] });
    var i, node;
    for (i = 0; i < SECTIONS.length; i++) {
      node = document.getElementById(SECTIONS[i]);
      if (node) { io.observe(node); }
    }
  }

  /* ----------------------------------------------------------
     5. UI construction
  ---------------------------------------------------------- */
  var launcher, chipEl, scrim, panel, msgsEl, inputEl, sendBtn, newPill, statusDot;
  var authMailEl = null, authBtn = null, authRow = null;
  var roots = [];

  function syncReduced() {
    var i;
    for (i = 0; i < roots.length; i++) {
      if (roots[i]) {
        if (REDUCED) { roots[i].classList.add('cx-reduced'); }
        else { roots[i].classList.remove('cx-reduced'); }
      }
    }
  }

  function buildUI() {
    /* launcher */
    launcher = el('button', 'cx-launch');
    launcher.id = 'cx-launch';
    launcher.type = 'button';
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-label', 'Ask the mill — open product concierge');
    launcher.appendChild(el('span', 'cx-star', '✳'));
    launcher.appendChild(el('span', 'cx-label', 'Ask the mill'));
    launcher.addEventListener('click', function () { openPanel(); });

    /* context chip (built lazily on show) */

    /* scrim */
    scrim = el('div', 'cx-scrim');
    scrim.addEventListener('click', function () { closePanel(); });

    /* panel */
    panel = el('aside', 'cx-panel');
    panel.id = 'cx-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Product concierge');
    panel.setAttribute('tabindex', '-1');

    var handle = el('div', 'cx-handle');
    handle.setAttribute('aria-hidden', 'true');
    panel.appendChild(handle);

    /* header */
    var head = el('header', 'cx-head');
    head.appendChild(stampImg('cx-stamp'));
    var headLeft = el('div', 'cx-headleft');
    headLeft.appendChild(el('h2', 'cx-title', 'The Mill Concierge'));
    var sub = el('div', 'cx-sub');
    statusDot = el('span', 'cx-dot');
    syncStatusDot();
    sub.appendChild(statusDot);
    sub.appendChild(el('span', null, 'WEBEREI BRANDT · EST. 1897'));
    headLeft.appendChild(sub);
    head.appendChild(headLeft);
    if (authEnabled()) {
      var authBox = el('div', 'cx-authbox');
      authMailEl = el('span', 'cx-authmail');
      authMailEl.style.display = 'none';
      authBox.appendChild(authMailEl);
      authBtn = el('button', 'cx-authlink', 'Sign in');
      authBtn.type = 'button';
      authBtn.addEventListener('click', onAuthLink);
      authBox.appendChild(authBtn);
      head.appendChild(authBox);
    }
    var closeBtn = el('button', 'cx-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close concierge');
    closeBtn.addEventListener('click', function () { closePanel(); });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    /* messages */
    msgsEl = el('div', 'cx-msgs');
    msgsEl.setAttribute('aria-live', 'polite');
    panel.appendChild(msgsEl);

    /* composer */
    var compose = el('div', 'cx-compose');
    newPill = el('button', 'cx-newpill', '↓ new');
    newPill.type = 'button';
    newPill.addEventListener('click', function () {
      pinned = true;
      scrollToBottom(true);
      hideNewPill();
    });
    compose.appendChild(newPill);
    var row = el('div', 'cx-inputrow');
    inputEl = document.createElement('textarea');
    inputEl.className = 'cx-input';
    inputEl.rows = 1;
    inputEl.placeholder = 'Ask about the wool, the mill, the number…';
    inputEl.setAttribute('aria-label', 'Your question');
    inputEl.addEventListener('input', autogrow);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitInput();
      }
    });
    row.appendChild(inputEl);
    sendBtn = el('button', 'cx-send', '↑');
    sendBtn.type = 'button';
    sendBtn.setAttribute('aria-label', 'Send question');
    sendBtn.addEventListener('click', submitInput);
    row.appendChild(sendBtn);
    compose.appendChild(row);
    panel.appendChild(compose);

    /* footer */
    panel.appendChild(el('div', 'cx-foot',
      'An automated AI concierge — answers by Anthropic\u2019s Claude · woven, not warranted · hello@feierabend.example'));

    document.body.appendChild(launcher);
    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    roots = [launcher, scrim, panel];
    syncReduced();

    msgsEl.addEventListener('scroll', onMsgsScroll);
    initDrag(handle, head);
    panel.addEventListener('keydown', trapFocus);
  }

  function autogrow() {
    inputEl.style.height = 'auto';
    var max = 3 * 1.5 * 16 + 14; /* ~3 lines */
    var h = Math.min(inputEl.scrollHeight, max);
    inputEl.style.height = h + 'px';
  }

  /* ----------------------------------------------------------
     6. Launcher visibility & scroll choreography
  ---------------------------------------------------------- */
  var lastY = 0, idleTimer = null, tucked = false;

  function updateLauncher() {
    if (!launcher) { return; }
    if (panelOpen) {
      launcher.classList.remove('cx-on');
      return;
    }
    var eligible = (window.scrollY || window.pageYOffset || 0) > window.innerHeight * 0.6;
    if (eligible) { launcher.classList.add('cx-on'); }
    else { launcher.classList.remove('cx-on'); }
    if (currentSection() === 'reserve') { launcher.classList.add('cx-dock'); }
    else { launcher.classList.remove('cx-dock'); }
    if (tucked) { launcher.classList.add('cx-tuck'); }
    else { launcher.classList.remove('cx-tuck'); }
  }

  function onScroll() {
    var y = window.scrollY || window.pageYOffset || 0;
    var dy = y - lastY;
    lastY = y;
    if (dy > 4) { tucked = true; }
    else if (dy < -4) { tucked = false; }
    if (idleTimer) { clearTimeout(idleTimer); }
    idleTimer = setTimeout(function () { tucked = false; updateLauncher(); }, 900);
    updateLauncher();
  }

  /* ----------------------------------------------------------
     7. Context chips (dwell nudge)
  ---------------------------------------------------------- */
  var dwellTimer = null, chipHideTimer = null;

  function ssGet(key) {
    try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function ssSet(key, val) {
    try { window.sessionStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }

  /* Per-pageview chip state — in memory, so a reload starts fresh and the
     nudges behave predictably. Caps: once per section, CHIP_CAP per view. */
  var chipShownCount = 0;
  var chipSeenSections = [];
  var CHIP_CAP = 5;
  var CHIP_DWELL_MS = 1100;
  var CHIP_LINGER_MS = 9000;

  function onSectionChange(sectionId) {
    updateLauncher();
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
    hideChip();
    if (panelOpen) { return; }
    if (chipShownCount >= CHIP_CAP) { return; }
    var k;
    for (k = 0; k < chipSeenSections.length; k++) {
      if (chipSeenSections[k] === sectionId) { return; }
    }
    var sugg = suggestedMap();
    if (!sugg) { return; }
    var list = sugg[sectionId];
    if (Object.prototype.toString.call(list) !== '[object Array]' || !list.length) { return; }
    var question = String(list[0]);
    dwellTimer = setTimeout(function () {
      dwellTimer = null;
      if (panelOpen || currentSection() !== sectionId || chipShownCount >= CHIP_CAP) { return; }
      showChip(sectionId, question);
    }, CHIP_DWELL_MS);
  }

  function showChip(sectionId, question) {
    hideChip();
    chipSeenSections.push(sectionId);
    chipShownCount++;
    chipEl = el('button', 'cx-chip', question);
    chipEl.type = 'button';
    if (REDUCED) { chipEl.classList.add('cx-reduced'); }
    chipEl.addEventListener('click', function () {
      var q = question;
      hideChip();
      openPanel(q);
    });
    document.body.appendChild(chipEl);
    /* force layout, then fade in */
    void chipEl.offsetWidth;
    chipEl.classList.add('cx-on');
    chipHideTimer = setTimeout(hideChip, CHIP_LINGER_MS);
  }

  function hideChip() {
    if (chipHideTimer) { clearTimeout(chipHideTimer); chipHideTimer = null; }
    if (chipEl && chipEl.parentNode) {
      var node = chipEl;
      chipEl = null;
      node.classList.remove('cx-on');
      if (REDUCED) {
        if (node.parentNode) { node.parentNode.removeChild(node); }
      } else {
        setTimeout(function () {
          if (node.parentNode) { node.parentNode.removeChild(node); }
        }, 650);
      }
    } else {
      chipEl = null;
    }
  }

  /* ----------------------------------------------------------
     8. History (sessionStorage)
  ---------------------------------------------------------- */
  var history = [];

  function loadHistory() {
    try {
      var raw = ssGet(HISTORY_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (Object.prototype.toString.call(arr) !== '[object Array]') { arr = []; }
      history = [];
      var i, t;
      for (i = 0; i < arr.length; i++) {
        t = arr[i];
        if (t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string') {
          history.push({ role: t.role, content: t.content });
        }
      }
    } catch (e) { history = []; }
  }
  function saveHistory() {
    if (history.length > HISTORY_CAP) { history = history.slice(history.length - HISTORY_CAP); }
    ssSet(HISTORY_KEY, JSON.stringify(history));
  }

  /* ----------------------------------------------------------
     9. Message rendering
  ---------------------------------------------------------- */
  var pinned = true;

  function scrollToBottom(force) {
    if (!msgsEl) { return; }
    if (pinned || force) { msgsEl.scrollTop = msgsEl.scrollHeight; }
    else { showNewPill(); }
  }
  function onMsgsScroll() {
    var slack = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight;
    var wasPinned = pinned;
    pinned = slack < 48;
    if (pinned && !wasPinned) { hideNewPill(); }
  }
  function showNewPill() { if (newPill) { newPill.classList.add('cx-on'); } }
  function hideNewPill() { if (newPill) { newPill.classList.remove('cx-on'); } }

  function addUserTurn(text) {
    var turn = el('div', 'cx-turn cx-turn-user', text);
    msgsEl.appendChild(turn);
    scrollToBottom(false);
    return turn;
  }

  function addAssistantShell() {
    var turn = el('div', 'cx-turn cx-turn-assistant');
    var body = el('div', 'cx-pre');
    turn.appendChild(body);
    msgsEl.appendChild(turn);
    var buffer = '';          /* everything received */
    var queue = '';           /* received but not yet woven into the DOM */
    var loom = null;          /* drain interval */
    var ended = false;        /* stream finished; finalize when queue drains */
    var started = false;
    var caret = el('span', 'cx-caret');
    caret.setAttribute('aria-hidden', 'true');
    var dots = el('span', 'cx-dots');
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    var statusEl = el('span', 'cx-status');
    var think = el('span', 'cx-think');
    think.setAttribute('aria-hidden', 'true');
    think.appendChild(stampImg('cx-stamp-mini'));
    think.appendChild(dots);
    think.appendChild(statusEl);
    if (!REDUCED) { body.appendChild(think); }
    scrollToBottom(false);

    function beginWeave() {
      if (started) { return; }
      started = true;
      if (think.parentNode) { think.parentNode.removeChild(think); }
      body.appendChild(caret);
    }
    /* Weave one word (with its leading whitespace) before the caret. */
    function placeNext() {
      var m = queue.match(/^\s*\S+\s?|^\s+/);
      if (!m) { return false; }
      var tok = m[0];
      queue = queue.slice(tok.length);
      var node = el('span', 'cx-w', tok);
      body.insertBefore(node, caret);
      void node.offsetWidth;
      node.className = 'cx-w cx-w-in';
      return true;
    }
    function finalize() {
      if (loom) { clearInterval(loom); loom = null; }
      while (body.firstChild) { body.removeChild(body.firstChild); }
      body.className = '';
      body.appendChild(mdRender(buffer));
      if (!REDUCED) { body.classList.add('cx-fade-in'); }
      scrollToBottom(false);
    }
    /* Steady drain: ~1 word / 36ms, weaving faster when a burst backs up. */
    function ensureLoom() {
      if (loom) { return; }
      loom = setInterval(function () {
        var steps = 1 + Math.min(3, Math.floor(queue.length / 140));
        var wove = false, i;
        for (i = 0; i < steps; i++) { if (placeNext()) { wove = true; } }
        if (wove) { scrollToBottom(false); }
        if (!queue.length) {
          clearInterval(loom); loom = null;
          if (ended) { finalize(); }
        }
      }, 36);
    }

    return {
      turn: turn,
      getText: function () { return buffer; },
      /* server status caption ("Reading the register…") shown by the
         thinking dots until the first text chunk starts the weave */
      status: function (text) {
        if (started) { return; }
        statusEl.textContent = String(text || '');
        scrollToBottom(false);
      },
      append: function (chunk) {
        buffer += chunk;
        if (REDUCED) {
          /* reduced motion: plain immediate text, no weave */
          beginWeave();
          while (body.firstChild) { body.removeChild(body.firstChild); }
          body.appendChild(document.createTextNode(buffer));
          scrollToBottom(false);
          return;
        }
        queue += chunk;
        beginWeave();
        ensureLoom();
      },
      done: function () {
        ended = true;
        if (REDUCED || (!queue.length && !loom)) { finalize(); }
        /* otherwise the loom finalizes when the queue drains */
      },
      fail: function () {
        ended = true;
        if (loom) { clearInterval(loom); loom = null; }
        while (body.firstChild) { body.removeChild(body.firstChild); }
        if (buffer) {
          body.className = '';
          body.appendChild(mdRender(buffer));
        } else if (turn.parentNode) {
          turn.parentNode.removeChild(turn);
        }
      }
    };
  }

  function addSysLine(text) {
    var turn = el('div', 'cx-turn cx-sysline', text);
    msgsEl.appendChild(turn);
    scrollToBottom(false);
    return turn;
  }

  function addSuggestChips(questions) {
    var list = [], j;
    if (authEmail) { list.push(TRACK_QUESTION); }
    if (questions && questions.length) {
      for (j = 0; j < questions.length; j++) {
        if (String(questions[j]) !== TRACK_QUESTION) { list.push(questions[j]); }
      }
    }
    if (!list.length) { return; }
    var cap = authEmail ? 4 : 3;
    var box = el('div', 'cx-suggest');
    var i;
    for (i = 0; i < list.length && i < cap; i++) {
      (function (q) {
        var b = el('button', 'cx-sbtn', q);
        b.type = 'button';
        b.addEventListener('click', function () {
          if (box.parentNode) { box.parentNode.removeChild(box); }
          sendMessage(String(q));
        });
        box.appendChild(b);
      })(String(list[i]));
    }
    msgsEl.appendChild(box);
    scrollToBottom(false);
  }

  function addRetryChip() {
    var box = el('div', 'cx-suggest');
    var b = el('button', 'cx-sbtn', 'Retry');
    b.type = 'button';
    b.addEventListener('click', function () {
      if (box.parentNode) { box.parentNode.removeChild(box); }
      resendLast();
    });
    box.appendChild(b);
    msgsEl.appendChild(box);
    scrollToBottom(false);
  }

  function renderHistory() {
    while (msgsEl.firstChild) { msgsEl.removeChild(msgsEl.firstChild); }
    if (!history.length) {
      var greet = el('div', 'cx-turn cx-turn-assistant');
      greet.appendChild(mdRender(kbGreeting()));
      if (authEmail) {
        greet.appendChild(el('div', 'cx-signedline', 'Signed in as ' + authEmail + '.'));
      }
      msgsEl.appendChild(greet);
      addSuggestChips(kbSuggested(currentSection()));
      return;
    }
    var i, t;
    for (i = 0; i < history.length; i++) {
      t = history[i];
      if (t.role === 'user') {
        msgsEl.appendChild(el('div', 'cx-turn cx-turn-user', t.content));
      } else {
        var turn = el('div', 'cx-turn cx-turn-assistant');
        turn.appendChild(mdRender(t.content));
        msgsEl.appendChild(turn);
      }
    }
  }

  /* ----------------------------------------------------------
     10. Transport
  ---------------------------------------------------------- */
  var streaming = false;
  var currentAbort = null;
  var demoTimers = [];

  function setStreaming(on) {
    streaming = on;
    if (sendBtn) { sendBtn.disabled = on; }
    if (inputEl) {
      inputEl.disabled = on;
      if (!on && panelOpen && window.innerWidth >= 900) {
        try { inputEl.focus(); } catch (e) { /* ignore */ }
      }
    }
  }

  function clearDemoTimers() {
    var i;
    for (i = 0; i < demoTimers.length; i++) { clearTimeout(demoTimers[i]); }
    demoTimers = [];
  }

  function abortStream() {
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) { /* ignore */ }
      currentAbort = null;
    }
    clearDemoTimers();
  }

  function submitInput() {
    if (streaming) { return; }
    var text = (inputEl.value || '').replace(/^\s+|\s+$/g, '');
    if (!text) { return; }
    inputEl.value = '';
    autogrow();
    sendMessage(text);
  }

  function sendMessage(text) {
    if (streaming) { return; }
    pinned = true;
    hideNewPill();
    addUserTurn(text);
    history.push({ role: 'user', content: text });
    saveHistory();
    performRequest();
  }

  function resendLast() {
    if (streaming) { return; }
    /* last user message is already in history — just re-run */
    var i, has = false;
    for (i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') { has = true; break; }
    }
    if (!has) { return; }
    pinned = true;
    performRequest();
  }

  function performRequest() {
    setStreaming(true);
    var shell = addAssistantShell();
    if (isDemo()) { demoRespond(shell); }
    else { liveRespond(shell); }
  }

  function finishTurn(shell) {
    shell.done();
    var content = shell.getText();
    if (content) {
      history.push({ role: 'assistant', content: content });
      saveHistory();
    }
    if (content && shell.mid != null && hasSupabase()) {
      addFeedback(shell.turn, shell.mid);
    }
    setStreaming(false);
  }

  function failTurn(shell) {
    shell.fail();
    var partial = shell.getText();
    if (partial) {
      history.push({ role: 'assistant', content: partial });
      saveHistory();
    }
    addSysLine(ERROR_LINE);
    addRetryChip();
    setStreaming(false);
  }

  /* ---- LIVE: SSE over fetch ---- */
  function liveRespond(shell) {
    var turns = history.slice(Math.max(0, history.length - SEND_TURNS));
    var messages = [], i;
    for (i = 0; i < turns.length; i++) {
      messages.push({ role: turns[i].role, content: turns[i].content });
    }
    var body = JSON.stringify({
      messages: messages,
      context: freshState(),
      session_key: sessionKey()
    });
    var ac = null;
    try { ac = new AbortController(); } catch (eAC) { ac = null; }
    currentAbort = ac;
    var aborted = false;

    getAccessToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) { headers['Authorization'] = 'Bearer ' + token; }
      return fetch(endpoint(), {
        method: 'POST',
        headers: headers,
        body: body,
        signal: ac ? ac.signal : undefined
      });
    }).then(function (res) {
      if (!res.ok) {
        if (res.status === 503) {
          /* the mill is closed for the moment — calm mono notice */
          return res.json()['catch'](function () { return null; }).then(function (j) {
            var msg = '';
            if (typeof j === 'string') { msg = j; }
            else if (j && typeof j.error === 'string') { msg = j.error; }
            else if (j && typeof j.message === 'string') { msg = j.message; }
            shell.fail();
            addSysLine(msg || BUSY_LINE);
            setStreaming(false);
          });
        }
        return res.json()['catch'](function () { return {}; }).then(function () {
          throw new Error('HTTP ' + res.status);
        });
      }
      if (!res.body || !res.body.getReader) {
        /* no streaming support — read whole text */
        return res.text().then(function (full) {
          consumeSSE(full, shell);
          consumeSSEFlush(shell);
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var doneFlag = { v: false };

      function pump() {
        return reader.read().then(function (step) {
          if (doneFlag.v) { return; }
          if (step.done) {
            buf += decoder.decode();
            processBuf(true);
            if (!doneFlag.v) { doneFlag.v = true; finishTurn(shell); }
            return;
          }
          buf += decoder.decode(step.value, { stream: true });
          processBuf(false);
          if (!doneFlag.v) { return pump(); }
        });
      }

      function processBuf(flush) {
        var parts = buf.split('\n\n');
        buf = flush ? '' : parts.pop();
        if (flush && parts.length && parts[parts.length - 1] === '') { parts.pop(); }
        var p, lines, L, payload, obj;
        for (p = 0; p < parts.length; p++) {
          lines = parts[p].split('\n');
          for (L = 0; L < lines.length; L++) {
            if (lines[L].indexOf('data:') !== 0) { continue; }
            payload = lines[L].slice(5).replace(/^\s/, '');
            if (payload === '[DONE]') {
              doneFlag.v = true;
              finishTurn(shell);
              return;
            }
            try {
              obj = JSON.parse(payload);
              if (obj && typeof obj.t === 'string') { shell.append(obj.t); }
              if (obj && typeof obj.s === 'string' && shell.status) { shell.status(obj.s); }
              if (obj && obj.m && typeof obj.m === 'object') {
                if (obj.m.mid != null) { shell.mid = obj.m.mid; }
                if (obj.m.cid != null) { shell.cid = obj.m.cid; }
              }
            } catch (eJ) { /* skip malformed frame */ }
          }
        }
      }

      return pump();
    })['catch'](function (err) {
      if (aborted || (err && err.name === 'AbortError')) {
        /* panel closed mid-stream: keep what we have quietly */
        shell.done();
        var partial = shell.getText();
        if (partial) {
          history.push({ role: 'assistant', content: partial });
          saveHistory();
        }
        setStreaming(false);
        return;
      }
      failTurn(shell);
    }).then(function () {
      if (currentAbort === ac) { currentAbort = null; }
    });
  }

  /* fallback single-shot SSE parse (non-streaming bodies) */
  var _fullDone = false;
  function consumeSSE(full, shell) {
    _fullDone = false;
    var parts = String(full).split('\n\n');
    var p, lines, L, payload, obj;
    for (p = 0; p < parts.length; p++) {
      lines = parts[p].split('\n');
      for (L = 0; L < lines.length; L++) {
        if (lines[L].indexOf('data:') !== 0) { continue; }
        payload = lines[L].slice(5).replace(/^\s/, '');
        if (payload === '[DONE]') { _fullDone = true; return; }
        try {
          obj = JSON.parse(payload);
          if (obj && typeof obj.t === 'string') { shell.append(obj.t); }
          if (obj && typeof obj.s === 'string' && shell.status) { shell.status(obj.s); }
          if (obj && obj.m && typeof obj.m === 'object') {
            if (obj.m.mid != null) { shell.mid = obj.m.mid; }
            if (obj.m.cid != null) { shell.cid = obj.m.cid; }
          }
        } catch (eJ) { /* ignore */ }
      }
    }
  }
  function consumeSSEFlush(shell) { finishTurn(shell); }

  /* ---- DEMO: keyword scoring + simulated stream ---- */
  function demoAnswerFor(userText) {
    var q = String(userText).toLowerCase();
    var entries = kbDemoEntries();
    var best = null, bestScore = 0;
    var i, j, entry, score, kw;
    for (i = 0; i < entries.length; i++) {
      entry = entries[i];
      if (!entry || typeof entry.answer !== 'string') { continue; }
      var match = entry.match;
      if (Object.prototype.toString.call(match) !== '[object Array]') { continue; }
      score = 0;
      for (j = 0; j < match.length; j++) {
        kw = String(match[j]).toLowerCase();
        if (kw && q.indexOf(kw) !== -1) { score++; }
      }
      if (score >= 1 && score > bestScore) { bestScore = score; best = entry; }
    }
    return best ? best.answer : null;
  }

  function demoFallbackAnswer() {
    return 'That thread runs past my register, I’m afraid. I can speak with certainty ' +
      'about the **wool**, the **mill and its looms**, the **numbering of the edition**, ' +
      'and how your blanket **arrives**. Pull on one of those, and I’ll unravel it properly.';
  }

  function demoRespond(shell) {
    var lastUser = '';
    var i;
    for (i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') { lastUser = history[i].content; break; }
    }
    var answer = demoAnswerFor(lastUser);
    var fallback = false;
    if (answer == null) { answer = demoFallbackAnswer(); fallback = true; }

    var words = String(answer).split(/(\s+)/);
    /* build 2–5 word chunks (word + trailing space pairs) */
    var chunks = [], k = 0;
    while (k < words.length) {
      var take = (2 + Math.floor(Math.random() * 4)) * 2; /* 2–5 words incl. separators */
      chunks.push(words.slice(k, k + take).join(''));
      k += take;
    }

    var idx = 0;
    function emit() {
      if (!panelOpen && !streaming) { return; }
      if (idx >= chunks.length) {
        finishTurn(shell);
        if (fallback) { addSuggestChips(kbSuggested(null)); }
        return;
      }
      shell.append(chunks[idx]);
      idx++;
      var delay = REDUCED ? 0 : (24 + Math.floor(Math.random() * 17));
      demoTimers.push(setTimeout(emit, delay));
    }
    demoTimers.push(setTimeout(emit, REDUCED ? 0 : 500));
  }

  /* ----------------------------------------------------------
     10b. Accounts — magic link via supabase-js (lazy UMD load)
  ---------------------------------------------------------- */
  var sbClient = null, sbPromise = null;
  var authEmail = '';

  function ensureSupabase() {
    if (sbPromise) { return sbPromise; }
    sbPromise = new Promise(function (resolve) {
      if (!hasSupabase()) { resolve(null); return; }
      if (window.supabase && window.supabase.createClient) { resolve(makeSbClient()); return; }
      var s = document.createElement('script');
      s.src = SUPABASE_CDN;
      s.async = true;
      s.onload = function () { resolve(makeSbClient()); };
      s.onerror = function () { resolve(null); };
      (document.head || document.documentElement).appendChild(s);
    });
    return sbPromise;
  }

  function makeSbClient() {
    if (sbClient) { return sbClient; }
    try {
      if (!window.supabase || !window.supabase.createClient) { return null; }
      /* persistSession + detectSessionInUrl are supabase-js defaults;
         the magic-link redirect is picked up automatically */
      sbClient = window.supabase.createClient(supaUrl(), supaKey());
      try {
        sbClient.auth.onAuthStateChange(function (evt, session) { setAuthState(session); });
        sbClient.auth.getSession().then(function (r) {
          setAuthState(r && r.data ? r.data.session : null);
        }, function () { /* ignore */ });
      } catch (eL) { /* ignore */ }
    } catch (eC) { sbClient = null; }
    return sbClient;
  }

  function getAccessToken() {
    return new Promise(function (resolve) {
      if (!sbClient) { resolve(null); return; }
      try {
        sbClient.auth.getSession().then(function (r) {
          var s = r && r.data ? r.data.session : null;
          resolve((s && s.access_token) ? s.access_token : null);
        }, function () { resolve(null); });
      } catch (eG) { resolve(null); }
    });
  }

  function setAuthState(session) {
    var em = '';
    try {
      em = (session && session.user && typeof session.user.email === 'string')
        ? session.user.email : '';
    } catch (eE) { em = ''; }
    if (em === authEmail) { return; }
    authEmail = em;
    if (em) { closeAuthRow(); }
    updateAuthUI();
    /* fresh conversation on screen — refresh greeting + chips in place */
    if (panelOpen && !streaming && !history.length && msgsEl) { renderHistory(); }
  }

  function shortEmail(em) {
    var at = em.indexOf('@');
    if (at < 1) { return em; }
    var local = em.slice(0, at);
    if (local.length > 7) { local = local.slice(0, 6) + '…'; }
    return local + em.slice(at);
  }

  function updateAuthUI() {
    if (!authBtn || !authMailEl) { return; }
    if (authEmail) {
      authMailEl.textContent = shortEmail(authEmail);
      authMailEl.title = authEmail;
      authMailEl.style.display = '';
      authBtn.textContent = 'Sign out';
      authBtn.setAttribute('aria-label', 'Sign out of ' + authEmail);
    } else {
      authMailEl.textContent = '';
      authMailEl.style.display = 'none';
      authBtn.textContent = 'Sign in';
      authBtn.setAttribute('aria-label', 'Sign in with a magic link');
    }
  }

  function onAuthLink() {
    if (authEmail) {
      ensureSupabase().then(function (client) {
        if (!client) { return; }
        try {
          client.auth.signOut().then(function () { setAuthState(null); },
            function () { /* ignore */ });
        } catch (eO) { /* ignore */ }
      });
      return;
    }
    if (authRow) { closeAuthRow(); return; }
    openAuthRow();
  }

  function openAuthRow() {
    if (!panel || authRow) { return; }
    ensureSupabase();
    authRow = el('div', 'cx-authrow');
    var cap = el('div', 'cx-authcap', 'Your email — we send a key, no passwords.');
    authRow.appendChild(cap);
    var line = el('div', 'cx-authline');
    var input = document.createElement('input');
    input.type = 'email';
    input.className = 'cx-authinput';
    input.placeholder = 'you@example.com';
    input.autocomplete = 'email';
    input.setAttribute('aria-label', 'Email for sign-in key');
    var send = el('button', 'cx-authsend', 'Send key');
    send.type = 'button';
    function fail() {
      send.disabled = false;
      send.textContent = 'Send key';
      cap.textContent = 'The key could not be sent. Try once more.';
    }
    function submit() {
      if (send.disabled) { return; }
      var em = (input.value || '').replace(/^\s+|\s+$/g, '');
      if (!em || em.indexOf('@') < 1) {
        try { input.focus(); } catch (eF) { /* ignore */ }
        return;
      }
      send.disabled = true;
      send.textContent = 'Sending…';
      ensureSupabase().then(function (client) {
        if (!client) { fail(); return; }
        try {
          client.auth.signInWithOtp({
            email: em,
            options: { emailRedirectTo: location.href }
          }).then(function (r) {
            if (r && r.error) { fail(); return; }
            var row = authRow;
            if (!row) { return; }
            while (row.firstChild) { row.removeChild(row.firstChild); }
            row.appendChild(el('div', 'cx-authcap', 'Sent. Check your inbox.'));
          }, fail);
        } catch (eS) { fail(); }
      });
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    line.appendChild(input);
    line.appendChild(send);
    authRow.appendChild(line);
    panel.insertBefore(authRow, msgsEl);
    try { input.focus(); } catch (eI) { /* ignore */ }
  }

  function closeAuthRow() {
    if (authRow && authRow.parentNode) { authRow.parentNode.removeChild(authRow); }
    authRow = null;
  }

  /* ----------------------------------------------------------
     10c. Feedback — ↑/↓ under completed assistant messages
  ---------------------------------------------------------- */
  function addFeedback(turn, mid) {
    var box = el('div', 'cx-fb');
    var up = el('button', 'cx-fbbtn', '↑');
    up.type = 'button';
    up.setAttribute('aria-label', 'Helpful');
    var down = el('button', 'cx-fbbtn', '↓');
    down.type = 'button';
    down.setAttribute('aria-label', 'Not helpful');
    function remove() {
      if (box.parentNode) { box.parentNode.removeChild(box); }
    }
    function vote(rating) {
      if (up.disabled) { return; } /* one vote per message */
      up.disabled = true;
      down.disabled = true;
      try {
        fetch(supaUrl() + '/rest/v1/concierge_feedback', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supaKey(),
            'Authorization': 'Bearer ' + supaKey(),
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ message_id: mid, rating: rating })
        }).then(function (res) {
          if (res.ok) {
            while (box.firstChild) { box.removeChild(box.firstChild); }
            box.appendChild(el('span', 'cx-fbnote', 'Noted.'));
          } else {
            remove();
          }
        }, remove);
      } catch (eV) { remove(); }
    }
    up.addEventListener('click', function () { vote(1); });
    down.addEventListener('click', function () { vote(-1); });
    box.appendChild(up);
    box.appendChild(down);
    turn.appendChild(box);
    scrollToBottom(false);
  }

  /* ----------------------------------------------------------
     10d. Inline conversation starters woven into the page
          Second starter per section (index 1) — the floating
          context chip already uses index 0.
  ---------------------------------------------------------- */
  var LIGHT_SECTIONS = { wool: 1, ritual: 1 }; /* wool-coloured backgrounds → ink text */

  function initInlineStarters() {
    var map = suggestedMap();
    if (!map) { return; }
    var i;
    for (i = 0; i < INLINE_SECTIONS.length; i++) {
      (function (id) {
        var section = document.getElementById(id);
        if (!section) { return; }
        var list = map[id];
        if (Object.prototype.toString.call(list) !== '[object Array]' || list.length < 2) { return; }
        var question = String(list[1]);
        if (!question) { return; }
        /* match the section's own gutters by living inside its inner wrapper */
        var target = section.querySelector('.scrub-inner,.specs-inner,.ritual-inner,.arrival-inner');
        var pad = false;
        if (!target) {
          var head = section.querySelector('.benefits-head');
          if (head && head.parentNode) { target = head.parentNode; }
          else { target = section; pad = true; }
        }
        var b = el('button', 'cx-inline');
        b.type = 'button';
        if (LIGHT_SECTIONS[id]) { b.className += ' cx-inline-ink'; }
        if (pad) { b.className += ' cx-inline-pad'; }
        b.setAttribute('aria-label', 'Ask the mill: ' + question);
        b.appendChild(el('span', 'cx-inline-star', '✳'));
        b.appendChild(el('span', 'cx-inline-q', question));
        b.appendChild(el('span', 'cx-inline-arrow', '→'));
        b.addEventListener('click', function () { openPanel(question); });
        target.appendChild(b);
        roots.push(b);
      })(INLINE_SECTIONS[i]);
    }
    syncReduced();
  }

  /* ----------------------------------------------------------
     10e. Brass shimmer across the panel's top hairline
  ---------------------------------------------------------- */
  var shimmerTimer = null;

  function runShimmer() {
    if (REDUCED || !panel) { return; }
    var old = panel.querySelector('.cx-shimline');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    if (shimmerTimer) { clearTimeout(shimmerTimer); shimmerTimer = null; }
    var line = el('div', 'cx-shimline');
    line.setAttribute('aria-hidden', 'true');
    line.appendChild(el('i'));
    panel.appendChild(line);
    shimmerTimer = setTimeout(function () {
      shimmerTimer = null;
      if (line.parentNode) { line.parentNode.removeChild(line); }
    }, 2400);
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

  function openPanel(prefillQuestion) {
    if (!panel) { return; } /* not mounted (yet), or remotely disabled */
    if (panelOpen) {
      if (typeof prefillQuestion === 'string' && prefillQuestion && !streaming) {
        sendMessage(prefillQuestion);
      }
      return;
    }
    panelOpen = true;
    if (hasSupabase()) { ensureSupabase(); }
    hideChip();
    lastFocused = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement : launcher;
    loadHistory();
    renderHistory();
    pinned = true;
    scrim.classList.add('cx-on');
    panel.classList.add('cx-open');
    runShimmer();
    lockBody();
    updateLauncher();
    scrollToBottom(true);
    setTimeout(function () {
      try { panel.focus(); } catch (e) { /* ignore */ }
    }, REDUCED ? 0 : 80);
    if (typeof prefillQuestion === 'string' && prefillQuestion && !streaming) {
      sendMessage(prefillQuestion);
    }
  }

  function closePanel() {
    if (!panelOpen) { return; }
    panelOpen = false;
    abortStream();
    panel.classList.remove('cx-open');
    panel.classList.remove('cx-tall');
    scrim.classList.remove('cx-on');
    unlockBody();
    updateLauncher();
    if (lastFocused && lastFocused.focus) {
      try { launcher.focus(); } catch (e) { /* ignore */ }
    } else if (launcher) {
      try { launcher.focus(); } catch (e2) { /* ignore */ }
    }
    lastFocused = null;
  }

  function trapFocus(e) {
    if (e.key !== 'Tab') { return; }
    var focusables = panel.querySelectorAll(
      'button:not(:disabled),textarea:not(:disabled),input:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])'
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
      closePanel();
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
      panel.classList.add('cx-dragging');
    }
    function onMove(e) {
      if (!dragging) { return; }
      var y = (e.touches ? e.touches[0].clientY : e.clientY);
      delta = y - startY;
      if (delta > 0) {
        panel.style.transform = 'translateY(' + delta + 'px)';
      } else {
        panel.style.transform = 'translateY(0)';
      }
      if (e.cancelable) { e.preventDefault(); }
    }
    function onEnd() {
      if (!dragging) { return; }
      dragging = false;
      panel.classList.remove('cx-dragging');
      panel.style.transform = '';
      if (delta > 90) {
        closePanel();
      } else if (delta < -60) {
        panel.classList.add('cx-tall');
      }
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
     13. visualViewport — keep composer above the keyboard
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
      if (pinned) { scrollToBottom(true); }
    }
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
  }

  /* ----------------------------------------------------------
     14. Section polling (catches __feierState-driven changes)
  ---------------------------------------------------------- */
  var lastKnownSection = null;
  function initSectionPoll() {
    lastKnownSection = currentSection();
    setInterval(function () {
      var s = currentSection();
      if (s !== lastKnownSection) {
        lastKnownSection = s;
        onSectionChange(s);
      }
    }, 250);
  }

  /* ----------------------------------------------------------
     15. Boot
  ---------------------------------------------------------- */
  function mountAll() {
    buildUI();
    initInlineStarters();
    initSectionObserver();
    initSectionPoll();
    initVisualViewport();
    lastY = window.scrollY || window.pageYOffset || 0;
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', updateLauncher);
    document.addEventListener('keydown', onKeydown);
    updateLauncher();
    /* a magic-link redirect landed here — let supabase-js collect it now */
    if (authEnabled()) {
      var loc = '';
      try { loc = String(location.hash || '') + String(location.search || ''); } catch (eH) { loc = ''; }
      if (loc.indexOf('access_token=') !== -1 || loc.indexOf('type=magiclink') !== -1 ||
          loc.indexOf('code=') !== -1) {
        ensureSupabase();
      }
    }
  }

  function boot() {
    injectStyle();
    fetchRemoteConfig(function () {
      /* remotely switched off: mount nothing — no launcher, chips or starters */
      if (endpoint() && remoteCfgOk && remoteEnabled === false) { return; }
      mountAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ----------------------------------------------------------
     16. Public API
  ---------------------------------------------------------- */
  window.FeierabendConcierge = {
    open: function (prefillQuestion) { openPanel(prefillQuestion); },
    close: function () { closePanel(); }
  };
})();
