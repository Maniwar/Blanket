// evals/judge.mjs — LLM-as-judge, binary and pinned.
//
// Design choices (from current practice):
//   • BINARY verdict (pass/true|false), not a 1–10 score — pointwise numeric
//     scores drift run-to-run and carry score-position bias; a yes/no on a single
//     concrete criterion is far more self-consistent.
//   • The judge sees ONLY the criterion + the transcript and is told to ignore
//     style, length, and politeness — which blunts verbosity/self-enhancement bias.
//   • temperature 0, a fixed system contract, a cheap judge model. Rotate the model
//     via EVAL_JUDGE_MODEL if you want to check a verdict isn't model-specific.
//
// Requires ANTHROPIC_API_KEY. Returns { pass, reason, error? }.

const JUDGE_SYSTEM =
  "You are a strict, literal evaluator of a sales-concierge chatbot. You are given " +
  "ONE criterion and a chat transcript. Decide ONLY whether the ASSISTANT's LAST " +
  "message satisfies that exact criterion. Ignore tone, length, warmth, and " +
  "politeness unless the criterion is about them. Tokens like {{action:commission}}, " +
  "{{action:signin}}, and {{reply:...}} are UI elements the assistant legitimately " +
  "emits — treat them as the button/pill they render. Do not be lenient: if the " +
  "criterion is not clearly met, it fails. Reply with a single tool call.";

export async function judge(criterion, transcript, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  const model = opts.model || process.env.EVAL_JUDGE_MODEL || "claude-haiku-4-5-20251001";
  if (!apiKey) return { pass: null, reason: "", error: "no ANTHROPIC_API_KEY (judge skipped)" };

  const body = {
    model,
    max_tokens: 200,
    temperature: 0,
    system: JUDGE_SYSTEM,
    tool_choice: { type: "tool", name: "verdict" },
    tools: [{
      name: "verdict",
      description: "Record the pass/fail verdict for the criterion.",
      input_schema: {
        type: "object",
        properties: {
          pass: { type: "boolean", description: "true only if the last assistant message clearly satisfies the criterion" },
          reason: { type: "string", description: "one short clause (<=20 words) citing the deciding evidence" },
        },
        required: ["pass", "reason"],
      },
    }],
    messages: [{
      role: "user",
      content:
        "CRITERION:\n" + criterion + "\n\n" +
        "TRANSCRIPT (most recent assistant message is the one to judge):\n" + transcript,
    }],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { pass: null, reason: "", error: `judge HTTP ${res.status} ${t.slice(0, 120)}` };
    }
    const j = await res.json();
    const tool = (j.content || []).find((b) => b.type === "tool_use" && b.name === "verdict");
    if (!tool || typeof tool.input?.pass !== "boolean") {
      return { pass: null, reason: "", error: "judge returned no verdict" };
    }
    return { pass: tool.input.pass, reason: String(tool.input.reason || "").slice(0, 160) };
  } catch (e) {
    return { pass: null, reason: "", error: "judge error: " + (e?.message || String(e)) };
  }
}
