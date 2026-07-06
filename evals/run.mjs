#!/usr/bin/env node
// evals/run.mjs — replay behavior scenarios against the deployed concierge and
// report a PASS RATE per check. Deterministic checks + an optional LLM judge.
//
//   node evals/run.mjs                 # run all scenarios
//   node evals/run.mjs --filter no-hold  # only scenarios whose name includes this
//   node evals/run.mjs --reps 10       # override repetitions
//   node evals/run.mjs --selftest      # prove the SSE parser + checks offline
//
// Env:
//   EVAL_ENDPOINT   (required)  e.g. https://<ref>.supabase.co/functions/v1/concierge
//   EVAL_TOKEN      (optional)  magic-link access token for a test account (signed-in scenarios)
//   EVAL_REPS       (default 5)
//   EVAL_THRESHOLD  (default 0.8)  a check below this pass-rate fails the run (exit 1)
//   ANTHROPIC_API_KEY (optional) enables { judge: ... } checks; skipped if absent
//   EVAL_JUDGE_MODEL  (optional) default claude-haiku-4-5-20251001
//
// Exit code: 0 if every check meets the threshold, 1 otherwise (CI-friendly).

import { scenarios } from "./scenarios.mjs";
import { judge } from "./judge.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const ENDPOINT = process.env.EVAL_ENDPOINT || "";
const TOKEN = process.env.EVAL_TOKEN || "";
const REPS = parseInt(flag("--reps", process.env.EVAL_REPS || "5"), 10);
const THRESHOLD = parseFloat(process.env.EVAL_THRESHOLD || "0.8");
const FILTER = flag("--filter", "");

// ── SSE: collect the assistant reply (t frames) and status labels (s frames) ──
async function readSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", reply = "";
  const statuses = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (p === "[DONE]" || p === "") continue;
        try {
          const o = JSON.parse(p);
          if (typeof o.t === "string") reply += o.t;
          if (typeof o.s === "string") statuses.push(o.s);
          if (o.hold) statuses.push("[hold]");
        } catch { /* meta frame we don't need */ }
      }
    }
  }
  return { reply, statuses };
}

async function postTurn(messages, context, sessionKey) {
  const headers = { "Content-Type": "application/json" };
  if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages, context, session_key: sessionKey }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 160)}`);
  }
  return readSSE(res);
}

// ── deterministic checks — return {ok, label, detail} ────────────────────────
function deterministic(check, reply, statuses) {
  const r = reply.toLowerCase();
  if ("includes" in check) {
    return { ok: r.includes(check.includes.toLowerCase()), label: `includes "${check.includes}"` };
  }
  if ("excludes" in check) {
    return { ok: !r.includes(check.excludes.toLowerCase()), label: `excludes "${check.excludes}"` };
  }
  if ("regex" in check) {
    return { ok: new RegExp(check.regex, "i").test(reply), label: `regex /${check.regex}/` };
  }
  if ("notRegex" in check) {
    return { ok: !new RegExp(check.notRegex, "i").test(reply), label: `notRegex /${check.notRegex}/` };
  }
  if ("maxQuestions" in check) {
    const n = (reply.match(/\?/g) || []).length;
    return { ok: n <= check.maxQuestions, label: `<=${check.maxQuestions} question(s)`, detail: `saw ${n}` };
  }
  if ("toolCalled" in check) {
    const hit = statuses.some((s) => s.toLowerCase().includes(check.toolCalled.toLowerCase()));
    return { ok: hit, label: `tool ran ("${check.toolCalled}")`, detail: hit ? "" : `statuses: ${statuses.join(" | ") || "none"}` };
  }
  return null; // not deterministic (judge)
}

function transcriptFor(messages, reply) {
  const lines = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
  lines.push(`Assistant: ${reply}`);
  return lines.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────
async function runScenario(sc, agg) {
  for (let rep = 0; rep < REPS; rep++) {
    const sessionKey = "eval-" + crypto.randomUUID();
    const messages = [];
    for (const turn of sc.turns) {
      messages.push({ role: "user", content: turn.user });
      let out;
      try {
        out = await postTurn(messages, sc.context || {}, sessionKey);
      } catch (e) {
        console.error(`  ! ${sc.name} rep ${rep + 1}: request failed — ${e.message}`);
        // count all this turn's checks as failures for this rep
        for (const c of (turn.checks || [])) key(agg, sc.name, describe(c)).total++;
        break;
      }
      const assistant = out.reply.trim();
      // evaluate checks (last content is what the judge sees)
      for (const c of (turn.checks || [])) {
        const a = key(agg, sc.name, describe(c));
        a.total++;
        const det = deterministic(c, assistant, out.statuses);
        if (det) { if (det.ok) a.pass++; else a.lastFail = det.detail || assistant.slice(0, 100); }
        else if ("judge" in c) {
          const v = await judge(c.judge, transcriptFor(messages, assistant));
          if (v.error) { a.skipped = v.error; a.total--; }
          else if (v.pass) a.pass++;
          else a.lastFail = v.reason || assistant.slice(0, 100);
        }
      }
      messages.push({ role: "assistant", content: assistant });
    }
  }
}

const describe = (c) => "judge" in c ? `judge: ${c.judge.slice(0, 60)}…` : JSON.stringify(c);
function key(agg, scenario, check) {
  const k = scenario + " :: " + check;
  return (agg[k] = agg[k] || { scenario, check, pass: 0, total: 0, lastFail: "", skipped: "" });
}

// Optionally pull the SAME deck the admin panel edits, from the admin-gated
// ?evals=1 endpoint (needs EVAL_TOKEN = a test-admin access token). Keeps one
// source of truth; falls back to the local scenarios.mjs on any error.
async function loadDeck() {
  if (!has("--remote")) return scenarios;
  if (!TOKEN) { console.error("--remote needs EVAL_TOKEN (a test-admin token)."); process.exit(2); }
  try {
    const res = await fetch(ENDPOINT + "?evals=1", { headers: { "Authorization": "Bearer " + TOKEN } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j.scenarios) || !j.scenarios.length) throw new Error("empty deck");
    console.log(`(loaded ${j.scenarios.length} scenario(s) from the DB deck via ?evals=1)\n`);
    return j.scenarios;
  } catch (e) {
    console.error(`--remote deck fetch failed (${e.message}); using local scenarios.mjs`);
    return scenarios;
  }
}

async function main() {
  if (has("--selftest")) return selftest();
  if (!ENDPOINT) { console.error("EVAL_ENDPOINT is required. See evals/README.md."); process.exit(2); }

  const list = (await loadDeck()).filter((s) => !FILTER || s.name.includes(FILTER));
  const runnable = list.filter((s) => !s.signedIn || TOKEN);
  const skipped = list.filter((s) => s.signedIn && !TOKEN);
  if (skipped.length) console.log(`(skipping ${skipped.length} signed-in scenario(s) — set EVAL_TOKEN to run them)\n`);

  console.log(`Running ${runnable.length} scenario(s) × ${REPS} reps against ${ENDPOINT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.log("(no ANTHROPIC_API_KEY — judge checks skipped)\n"); else console.log("");

  const agg = {};
  for (const sc of runnable) { process.stdout.write(`• ${sc.name} … `); await runScenario(sc, agg); console.log("done"); }

  // report
  console.log("\n─── results (pass rate over reps) " + "─".repeat(30));
  let failed = 0, anyScored = false;
  for (const k of Object.keys(agg).sort()) {
    const a = agg[k];
    if (a.total === 0) { console.log(`  SKIP  ${a.scenario} :: ${a.check}  (${a.skipped})`); continue; }
    anyScored = true;
    const rate = a.pass / a.total;
    const bad = rate < THRESHOLD;
    if (bad) failed++;
    const bar = bad ? "FAIL" : "ok  ";
    console.log(`  ${bar}  ${(rate * 100).toFixed(0).padStart(3)}%  ${a.scenario} :: ${a.check}` +
      (bad && a.lastFail ? `\n           ↳ e.g. ${a.lastFail}` : ""));
  }
  console.log("─".repeat(63));
  if (!anyScored) { console.log("No checks scored."); process.exit(0); }
  console.log(failed === 0 ? "All checks met the threshold ✅" : `${failed} check(s) below ${THRESHOLD * 100}% ⚠️`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── offline self-test: prove the SSE parser + deterministic checks work ──────
function selftest() {
  const sse =
    'data: {"s":"Reading the register…"}\n\n' +
    'data: {"t":"You have "}\n\n' +
    'data: {"t":"6 Loden. "}\n\n' +
    'data: {"t":"Shall I open the register? {{action:commission}}"}\n\n' +
    'data: {"m":{"cid":"x","mid":1}}\n\n' +
    'data: [DONE]\n\n';
  // feed it through the same frame logic
  let reply = ""; const statuses = [];
  for (const chunk of sse.split("\n\n")) {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim(); if (p === "[DONE]" || p === "") continue;
      try { const o = JSON.parse(p); if (typeof o.t === "string") reply += o.t; if (typeof o.s === "string") statuses.push(o.s); } catch {}
    }
  }
  const cases = [
    [deterministic({ includes: "{{action:commission}}" }, reply, statuses).ok, "includes token"],
    [!deterministic({ excludes: "{{action:commission}}" }, reply, statuses).ok, "excludes token (should fail→false)"],
    [deterministic({ toolCalled: "Reading the register" }, reply, statuses).ok, "toolCalled from status frame"],
    [deterministic({ maxQuestions: 1 }, reply, statuses).ok, "maxQuestions 1 (reply has 1 '?')"],
    [!deterministic({ maxQuestions: 0 }, reply, statuses).ok, "maxQuestions 0 (should fail)"],
    [reply === "You have 6 Loden. Shall I open the register? {{action:commission}}", "reply reassembled"],
  ];
  let ok = 0;
  for (const [pass, name] of cases) { console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`); if (pass) ok++; }
  console.log(`\nself-test: ${ok}/${cases.length}`);
  process.exit(ok === cases.length ? 0 : 1);
}

main();
