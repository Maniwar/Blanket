#!/usr/bin/env node
// evals/persona.mjs — persona-simulated multi-turn evals (ADVISORY).
//
// The behavior deck (run.mjs) replays SCRIPTED turns — precise, but it can't
// catch failures that only emerge over a live back-and-forth (interrogation
// loops, spec-dumping before discovery, pressure creep). This harness closes
// that gap: a cheap model PLAYS a shopper persona against the DEPLOYED
// concierge for a few turns, then the whole conversation is graded — a few
// mechanical checks plus a binary conversation-level judge per criterion.
//
// ADVISORY by design: personas are non-deterministic twice over (two models
// improvising), so a red row here is a lead to read, not a gate to trip.
// The exit code is always 0; read the transcript when a criterion fails.
//
//   node evals/persona.mjs                    # all personas
//   node evals/persona.mjs --filter gift      # only matching persona names
//
// Env:
//   EVAL_ENDPOINT      (required)  the deployed concierge function URL
//   ANTHROPIC_API_KEY  (required)  drives the shopper + the judge
//   EVAL_JUDGE_MODEL   (optional)  default claude-haiku-4-5-20251001

import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.EVAL_ENDPOINT || "";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.EVAL_JUDGE_MODEL || "claude-haiku-4-5-20251001";
const args = process.argv.slice(2);
const FILTER = (() => { const i = args.indexOf("--filter"); return i >= 0 ? args[i + 1] : ""; })();

// ── Personas: who the simulator plays, and what the conversation must show ──
// Judge criteria are CONVERSATION-level and binary. Mechanical checks run in
// code (cheap, exact); the judge handles only what needs judgment.
const PERSONAS = [
  {
    name: "hesitant-comparer",
    brief:
      "You are browsing for a wool blanket for your living-room sofa. You are tempted but hesitant: " +
      "a department store sells a throw for a quarter of the price and you keep bringing that up. " +
      "You answer questions honestly but volunteer little. You warm up only if the concierge shows " +
      "it understands YOUR room and use, not if it recites specifications.",
    opening: "Nice blanket, but honestly I saw a wool throw at Kaufhof for a quarter of this price.",
    maxTurns: 5,
    judge: [
      "At some point BEFORE presenting detailed product specifications, the assistant asked about the shopper's room, sofa, household, or intended use.",
      "The assistant never offered a discount, price reduction, or invented promotion anywhere in the conversation.",
      "When the shopper compared the blanket to a cheaper throw, the assistant acknowledged the comparison rather than ignoring or dismissing it.",
    ],
  },
  {
    name: "gift-buyer-hurry",
    brief:
      "You need a significant gift for your sister's housewarming in two weeks and you are short on " +
      "time. You are decisive and a little impatient: you reward short, concrete answers and get " +
      "irritated by long explanations. You want to know if it can arrive as a gift, in time, and " +
      "what it costs — then you are ready to decide.",
    opening: "I need a housewarming gift for my sister, two weeks from now. Would this work?",
    maxTurns: 4,
    judge: [
      "The assistant addressed the gift framing (a card or register entry in another name, or gifting explicitly) at some point.",
      "The assistant gave the shopper a clear next step toward ordering (an offer to open the register, a commission button, or an explicit path to buy).",
    ],
  },
  {
    name: "post-purchase-browser",
    brief:
      "You bought one of these blankets last week (Nº in the low 14,000s, Loden) and you are back on " +
      "the site just browsing. You are happy with the purchase. If pushed to justify the purchase " +
      "you already made, you get annoyed; if offered something genuinely new (care advice, a gift " +
      "idea for someone else), you engage.",
    opening: "Back again — my blanket arrived last week, the Loden one. Just looking around.",
    maxTurns: 4,
    judge: [
      "The assistant never treated the shopper as undecided about the blanket they already own (no 'still thinking it over' framing).",
      "Any suggestion of a further purchase was framed as a companion cloth or a gift for someone else — never as re-selling the blanket they already have.",
    ],
  },
  {
    name: "serious-offer-maker",
    brief:
      "You are seriously interested in the piece and you do want it, but you open by " +
      "lowballing: you name a price well under asking and press for a deal, cash today. " +
      "You are not rude, just a haggler — you push at least twice for a discount, a lower " +
      "figure, or a meet-in-the-middle. If the house holds the price firm but offers to " +
      "take your details or pass your offer to the owner, you accept and give a first name " +
      "and an email so they can follow up.",
    opening: "Love it. I'll give you 450 cash today, right now — deal?",
    maxTurns: 5,
    judge: [
      "The assistant NEVER accepted the lowball, proposed a counter-price, named a lower figure or a floor, or hinted at a discount, promotion, or meeting in the middle — anywhere in the conversation.",
      "The assistant moved to capture the shopper's interest for the owner to follow up (offered a form, offered to take their details, or offered to pass the offer along) rather than negotiating the price.",
      "The assistant kept the price firm while staying warm — framing the offer as opening a conversation with the owner, not a flat rejection.",
    ],
  },
];

// ── Minimal SSE client (mirrors run.mjs) ─────────────────────────────────────
async function readSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", reply = "";
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
        } catch { /* meta frame */ }
      }
    }
  }
  return reply;
}

async function concierge(messages, sessionKey) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, context: {}, session_key: sessionKey }),
  });
  if (!res.ok) throw new Error(`concierge HTTP ${res.status}`);
  return readSSE(res);
}

// ── The shopper simulator: persona brief + transcript → next line ───────────
async function shopperNext(persona, transcript) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 200, temperature: 0.7,
      system:
        "You play a SHOPPER talking to an online sales concierge. Stay strictly in character per the " +
        "persona brief. Write like a real person typing in a chat: short (5–30 words), no markdown, " +
        "no stage directions. If the conversation has reached its natural end for this persona " +
        "(you'd close the tab or you've decided), set done=true.",
      tool_choice: { type: "tool", name: "shopper_turn" },
      tools: [{
        name: "shopper_turn",
        description: "Your next chat message as the shopper.",
        input_schema: {
          type: "object",
          properties: {
            say: { type: "string", description: "your next message (5-30 words, plain chat text)" },
            done: { type: "boolean", description: "true if the conversation has naturally ended" },
          },
          required: ["say", "done"],
        },
      }],
      messages: [{
        role: "user",
        content: "PERSONA BRIEF:\n" + persona.brief + "\n\nTRANSCRIPT SO FAR:\n" + transcript +
          "\n\nWrite your next message as this shopper.",
      }],
    }),
  });
  if (!res.ok) throw new Error(`shopper HTTP ${res.status}`);
  const j = await res.json();
  const tu = (j.content || []).find((b) => b.type === "tool_use" && b.name === "shopper_turn");
  if (!tu || typeof tu.input?.say !== "string") return { say: "", done: true };
  return { say: tu.input.say.trim(), done: tu.input.done === true };
}

// ── Conversation-level judge (binary, pinned — judge.mjs is per-message) ────
async function judgeConversation(criterion, transcript) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 200, temperature: 0,
      system:
        "You are a strict, literal evaluator of a sales-concierge chatbot. You are given ONE " +
        "criterion and a full chat transcript. Decide ONLY whether the CONVERSATION AS A WHOLE " +
        "satisfies that exact criterion. Ignore tone, length, warmth, and politeness unless the " +
        "criterion is about them. Tokens like {{action:commission}}, {{reply:...}}, {{form:...}} and " +
        "{{img:...}} are UI elements the assistant legitimately emits. If the criterion is not clearly met, it fails. " +
        "Reply with a single tool call.",
      tool_choice: { type: "tool", name: "verdict" },
      tools: [{
        name: "verdict",
        description: "Record the pass/fail verdict.",
        input_schema: {
          type: "object",
          properties: {
            pass: { type: "boolean" },
            reason: { type: "string", description: "one short clause (<=20 words)" },
          },
          required: ["pass", "reason"],
        },
      }],
      messages: [{ role: "user", content: "CRITERION:\n" + criterion + "\n\nTRANSCRIPT:\n" + transcript }],
    }),
  });
  if (!res.ok) return { pass: null, reason: `judge HTTP ${res.status}` };
  const j = await res.json();
  const tu = (j.content || []).find((b) => b.type === "tool_use" && b.name === "verdict");
  if (!tu || typeof tu.input?.pass !== "boolean") return { pass: null, reason: "no verdict" };
  return { pass: tu.input.pass, reason: String(tu.input.reason || "").slice(0, 160) };
}

// ── Mechanical conversation checks (exact, free) ─────────────────────────────
function mechanical(assistantReplies) {
  const rows = [];
  const maxQ = Math.max(0, ...assistantReplies.map((r) => (r.match(/\?/g) || []).length));
  rows.push({ label: "≤2 questions in any single reply", ok: maxQ <= 2, detail: `max seen: ${maxQ}` });
  const leak = assistantReplies.some((r) => /\[hold\]|\bfunction_calls\b|\{\{(?!action:|reply:|img:|form:)/i.test(r));
  rows.push({ label: "no plumbing leaked into any reply", ok: !leak, detail: leak ? "leak found" : "" });
  const longest = Math.max(0, ...assistantReplies.map((r) => r.split(/\s+/).filter(Boolean).length));
  rows.push({ label: "no reply over 220 words", ok: longest <= 220, detail: `longest: ${longest} words` });
  return rows;
}

async function runPersona(p) {
  const sessionKey = "qa-persona-" + randomUUID();
  const messages = [];
  const assistantReplies = [];
  let userSay = p.opening;
  for (let turn = 0; turn < p.maxTurns; turn++) {
    messages.push({ role: "user", content: userSay });
    const reply = await concierge(messages, sessionKey);
    messages.push({ role: "assistant", content: reply });
    assistantReplies.push(reply);
    if (turn === p.maxTurns - 1) break;
    const transcript = messages.map((m) => (m.role === "user" ? "SHOPPER: " : "CONCIERGE: ") + m.content).join("\n");
    const next = await shopperNext(p, transcript);
    if (next.done || !next.say) break;
    userSay = next.say;
  }
  const transcript = messages.map((m) => (m.role === "user" ? "SHOPPER: " : "CONCIERGE: ") + m.content).join("\n");
  const rows = mechanical(assistantReplies);
  for (const criterion of p.judge) {
    const v = await judgeConversation(criterion, transcript);
    rows.push({
      label: criterion.length > 90 ? criterion.slice(0, 87) + "…" : criterion,
      ok: v.pass === true,
      detail: v.pass === null ? "judge unavailable: " + v.reason : v.reason,
    });
  }
  return { rows, transcript, turns: Math.ceil(messages.length / 2) };
}

async function main() {
  if (!ENDPOINT) { console.error("EVAL_ENDPOINT is required"); process.exit(0); }
  if (!API_KEY) { console.error("ANTHROPIC_API_KEY is required (drives the shopper + judge) — skipping"); process.exit(0); }
  const deck = PERSONAS.filter((p) => !FILTER || p.name.includes(FILTER));
  let red = 0;
  for (const p of deck) {
    console.log(`\n═══ persona: ${p.name} ═══`);
    try {
      const r = await runPersona(p);
      console.log(`(${r.turns} exchanges)`);
      for (const row of r.rows) {
        const mark = row.ok ? "PASS" : "FAIL";
        if (!row.ok) red++;
        console.log(`  ${mark}  ${row.label}${row.detail ? "  — " + row.detail : ""}`);
      }
      if (r.rows.some((x) => !x.ok)) {
        console.log("  ── transcript ──");
        console.log(r.transcript.split("\n").map((l) => "  " + l).join("\n"));
      }
    } catch (e) {
      red++;
      console.log(`  ERROR  ${e.message}`);
    }
  }
  console.log(`\n${red === 0 ? "All persona criteria green." : red + " criterion/criteria to read — advisory only, not a gate."}`);
  process.exit(0); // ADVISORY: personas inform, they never block
}

main();
