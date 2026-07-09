#!/usr/bin/env node
// evals/conformance.mjs — CONFIG CONFORMANCE: does the live widget actually run
// on the parameters configured in the admin? The behavior deck (run.mjs) tests
// WHAT the concierge says; this tests that the knobs are CONNECTED — for every
// checkable engagement parameter it compares:
//   configured  (the live ?config=1 payload — what the admin saved)
//   effective   (FeierabendConcierge.status() — what the running widget computed)
//   observed    (measured timings where feasible: opener delay, first follow-up)
// and prints a PASS/FAIL report you can hand straight back for diagnosis.
//
//   SITE_URL=https://feier-abend.co node evals/conformance.mjs
//
// Env:
//   SITE_URL              (default https://feier-abend.co)
//   CHROMIUM_PATH         (optional; e.g. /opt/pw-browsers/chromium for sandboxes)
//   CONFORMANCE_OUT       (optional; report file, default conformance-report.md)
//
// The run seeds sessionStorage cx-skey with a "qa-" key BEFORE the widget boots,
// so everything it triggers (opener, follow-up) is excluded from metrics.
//
// Formula notes: the expected-value math MIRRORS the widget engine
// (assets/concierge.js: assertDelayMult, reengageCfg, effUnackedCap,
// effHoldBudget, nudge ladder). If a formula changes there, update here — a
// FAIL on an untouched config is exactly that drift being caught.

import fs from "node:fs";

const SITE = process.env.SITE_URL || "https://feier-abend.co";
const OUT = process.env.CONFORMANCE_OUT || "conformance-report.md";

const DIAL_MULT = [1.5, 1.25, 1, 0.8, 0.65];

async function getBrowser() {
  let pw;
  try { pw = await import("playwright"); } catch {
    pw = await import("playwright-core");
  }
  const opts = {};
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  return (pw.chromium ?? pw.default.chromium).launch(opts);
}

const rows = [];
function row(param, configured, actual, ok, note = "") {
  rows.push({ param, configured: String(configured), actual: String(actual), ok, note });
}
function num(v, dflt) { return typeof v === "number" && Number.isFinite(v) ? v : dflt; }
function approx(measured, expected, tolMs) { return Math.abs(measured - expected) <= tolMs; }

async function main() {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(30000);
  // Metrics exclusion: the widget reads cx-skey before generating its own.
  await page.addInitScript(() => {
    try { sessionStorage.setItem("cx-skey", "qa-conform-" + Math.random().toString(36).slice(2, 10)); } catch {}
  });

  console.log("Loading " + SITE + " …");
  await page.goto(SITE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.FeierabendConcierge && window.FeierabendConcierge.status, null, { timeout: 20000 });

  // ── 1. The configured truth: the same ?config=1 the widget itself fetched ──
  const endpoint = await page.evaluate(() => (window.FEIER_CONCIERGE_CONFIG || {}).endpoint || "");
  if (!endpoint) throw new Error("No FEIER_CONCIERGE_CONFIG.endpoint on the page");
  const cfg = await (await fetch(endpoint + (endpoint.includes("?") ? "&" : "?") + "config=1")).json();
  const o = cfg.outreach || {};
  const dial = Math.min(5, Math.max(1, Math.round(num(cfg.assertiveness, 3))));
  const mult = DIAL_MULT[dial - 1];
  // Give the widget a beat to finish applying the remote config it fetched.
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => window.FeierabendConcierge.status());

  // ── 2. Configured vs effective (anonymous visitor) ─────────────────────────
  {
    const exp = o.reengageEnabled !== false;
    row("Re-engage enabled", exp, st.reengage.enabled, st.reengage.enabled === exp);
  }
  {
    const exp = num(o.reengageIdleAnonMs, Math.round(40000 * mult));
    row("Guest idle before returning (ms)", exp + (typeof o.reengageIdleAnonMs === "number" ? " (pinned)" : " (40s × dial)"),
      st.reengage.firesAfterIdleMs, st.reengage.firesAfterIdleMs === exp);
  }
  {
    const exp = typeof o.reengageMaxAnon === "number" ? o.reengageMaxAnon : Math.max(0, 2 + (dial - 3));
    row("Guest returns per visit (max)", exp, st.reengage.max, st.reengage.max === exp);
  }
  {
    const exp = num(o.holdBudget, 4);
    row("Silent holds before resting", exp, st.holdBudget, st.holdBudget === exp);
  }
  {
    const exp = typeof o.unackedCap === "number" && o.unackedCap >= 0 ? o.unackedCap : (dial >= 4 ? 3 : 2);
    row("Ignored reach-outs before pausing", exp, st.unackedCap, st.unackedCap === exp);
  }
  {
    const exp = typeof o.nudgeCap === "number" ? o.nudgeCap : (6 + (dial - 3));
    row("Follow-ups per conversation (cap)", exp, st.nudgeCap, st.nudgeCap === exp);
  }
  {
    const exp = num(o.reengagePostSaleWindowMs, 48 * 3600000);
    row("Post-sale window (ms)", exp, st.postSale.windowMs, st.postSale.windowMs === exp);
    const expG = num(o.reengageGraceMs, 240000);
    row("Post-sale grace (ms)", expG, st.postSale.graceMs, st.postSale.graceMs === expG);
    const expMode = (o.postSaleMode === "presence" || o.postSaleMode === "quiet" || o.postSaleMode === "upsell")
      ? o.postSaleMode : (o.reengagePostSaleEnabled === false ? "quiet" : "upsell");
    row("Post-sale mode", expMode, st.postSale.mode, st.postSale.mode === expMode);
  }

  // ── 3. Observed timing: the opener fires when configured ───────────────────
  // Open the panel; the anonymous opener should request its line after
  // openerAnonMs (default 3000). We watch entryMode/streaming flip.
  {
    const expected = num(o.openerAnonMs, 3000);
    const t0 = Date.now();
    await page.evaluate(() => window.FeierabendConcierge.open());
    let measured = -1;
    try {
      await page.waitForFunction(
        () => { const s = window.FeierabendConcierge.status(); return s.entryMode.indexOf("opener") === 0 || s.historyTurns > 0; },
        null, { timeout: Math.max(15000, expected + 12000), polling: 100 },
      );
      measured = Date.now() - t0;
    } catch { /* never fired */ }
    const ok = measured >= 0 && approx(measured, expected, 2500);
    row("Opener delay after panel open (ms)", expected, measured < 0 ? "never fired" : "~" + measured, ok,
      ok ? "" : "tolerance ±2500ms (includes page work before the request)");
  }

  // ── 4. Observed timing: the first follow-up lands on the ladder's first rung ──
  // The ladder only runs once the visitor has SPOKEN (an anonymous visitor who
  // never typed is deliberately not chased — the anonNudges toggle). So this
  // check types one real message, waits for the reply, then expects the first
  // nudge to FIRE at nudge1 × dial. The typed turn runs under the qa- session
  // key like everything else here.
  {
    const expected = Math.round(num(o.nudge1Ms, 8000) * mult);
    try {
      // Let the opener finish first so the typed turn doesn't race it.
      await page.waitForFunction(
        () => { const s = window.FeierabendConcierge.status(); return !s.streaming || s.historyTurns > 0; },
        null, { timeout: 30000, polling: 250 },
      ).catch(() => {});
      const before = await page.evaluate(() => window.FeierabendConcierge.status().historyTurns);
      // A real reader MOVES — acknowledge the opener like a human would.
      // Headless JS injection produces no pointer/key events, so without this
      // the widget correctly stacks its reach-outs as "unacknowledged" and
      // pauses the ladder at the unacked cap (an artificial state no live
      // visitor produces).
      await page.mouse.move(400, 300);
      await page.mouse.move(430, 330);
      await page.evaluate(() => window.FeierabendConcierge.open("Which cloth suits a bright room?"));
      await page.waitForFunction(
        (n) => { const s = window.FeierabendConcierge.status(); return s.historyTurns > n + 1 && s.lastRole === "assistant"; },
        before, { timeout: 60000, polling: 250 },
      );
      // Acknowledge the reply too (a reader who got an answer is looking at it).
      await page.mouse.move(410, 350);
      await page.mouse.move(390, 310);
      const t0 = Date.now();
      let measured = -1;
      try {
        // The widget's own diagnostics name each lifecycle event: a fired rung
        // logs "nudge: FIRED (#1)"; anything else that shows up first is a gate.
        await page.waitForFunction(
          (since) => {
            const s = window.FeierabendConcierge.status();
            const fresh = (s.recentSkips || []).slice(0, 3).join(" ");
            return /nudge: FIRED|nudge: stood down|the register HELD|beat: request FAILED|reach-outs unacknowledged|QUIET MODE/.test(fresh) &&
              Date.now() >= since;
          },
          t0, { timeout: expected + 20000, polling: 150 },
        );
        const fresh = await page.evaluate(() => (window.FeierabendConcierge.status().recentSkips || []).slice(0, 3));
        measured = Date.now() - t0;
        const firedEntry = fresh.find((s) => /nudge: FIRED \(#1\)/.test(s));
        const ok = !!firedEntry && approx(measured, expected, Math.max(3000, expected * 0.5));
        row("First follow-up after typed reply (ms)", expected + " (nudge1 × dial " + mult.toFixed(2) + ")",
          (firedEntry ? "~" + measured : "gated: " + String(fresh[0] || "").slice(0, 110)), ok,
          firedEntry ? "" : "the beat was gated, not mistimed — the skip reason names the gate");
      } catch {
        const skip = await page.evaluate(() => window.FeierabendConcierge.status().lastSkip);
        row("First follow-up after typed reply (ms)", expected, "no beat within " + (expected + 20000) + "ms", false,
          "lastSkip at timeout: " + String(skip).slice(0, 120));
      }
    } catch {
      const skip = await page.evaluate(() => window.FeierabendConcierge.status().lastSkip).catch(() => "?");
      row("First follow-up after typed reply (ms)", expected, "typed reply never completed", false,
        "lastSkip: " + String(skip).slice(0, 120));
    }
  }

  // ── 5. Wrap chip visibility rule ────────────────────────────────────────────
  // This run never types, so there is no real exchange — the chip must be
  // hidden regardless of the follow-up rule. (The positive case needs a typed
  // conversation; covered manually or by a future signed-in extension.)
  {
    const minTurns = typeof o.wrapChipMinTurns === "number" && o.wrapChipMinTurns >= 0 ? o.wrapChipMinTurns : 3;
    const chip = await page.evaluate(() => !!document.querySelector(".cx-wrapend"));
    row("Wrap chip hidden before any real exchange", "hidden", chip ? "visible" : "hidden", !chip,
      "config: appears after " + minTurns + " patron turns or once a follow-up fired (needs a typed exchange first)");
  }

  // Not checkable from outside (no status surface / would need config writes):
  row("Chip budget (chipCap/linger/repeat)", "—", "—", null, "not exposed by status(); verify visually");
  row("Service rate limits", "—", "—", null, "server-enforced; deliberately not probed");
  row("Quiet-mode duration", "—", "—", null, "requires tapping 'That's all' mid-conversation; verify manually or extend");

  await browser.close();

  // ── Report ──────────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  let md = `## Config conformance — ${SITE}\n_${stamp} · dial ${dial} (×${mult.toFixed(2)})_\n\n` +
    "| parameter | configured | live | verdict |\n| --- | --- | --- | --- |\n";
  let fails = 0;
  for (const r of rows) {
    const verdict = r.ok === null ? "SKIP" : r.ok ? "PASS" : "**FAIL**";
    if (r.ok === false) fails++;
    md += `| ${r.param} | ${r.configured} | ${r.actual} | ${verdict}${r.note ? " — " + r.note : ""} |\n`;
  }
  md += `\n**${fails === 0 ? "Every checkable parameter conforms ✅" : fails + " parameter(s) do NOT match their configuration ⚠️"}**\n` +
    (fails ? "\nPaste this table back to the assistant to diagnose — each FAIL names the configured value and what the live widget actually ran.\n" : "");
  fs.writeFileSync(OUT, md);
  console.log("\n" + md);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error("conformance run failed:", e.message); process.exit(2); });
