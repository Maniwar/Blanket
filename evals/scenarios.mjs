// evals/scenarios.mjs — the behavior deck.
//
// Each scenario is a short scripted conversation plus CHECKS on the bot's reply.
// Design (grounded in current LLM-as-judge practice):
//   • Prefer DETERMINISTIC checks (includes/excludes/toolCalled/maxQuestions) —
//     they're cheap, stable, and pinpoint a regression.
//   • Use the LLM JUDGE only for genuinely fuzzy behavior ("did it advance the
//     sale?"), phrased as ONE concrete, BINARY (yes/no) criterion — binary is far
//     more self-consistent than a 1–10 score, and a concrete criterion dodges the
//     judge's verbosity/positional biases.
//   • The runner repeats each scenario N times and reports a PASS RATE, because a
//     single pass doesn't prove an LLM won't flake next time.
//
// Check kinds (all evaluated against the assistant's reply for that turn):
//   { includes: "text" }        reply must contain this substring (case-insensitive)
//   { excludes: "text" }        reply must NOT contain it
//   { regex: "pat" }            reply must match (case-insensitive)
//   { notRegex: "pat" }         reply must NOT match
//   { maxQuestions: n }         at most n "?" in the reply (anti-interrogation)
//   { toolCalled: "label" }     a status frame contained this (proves a tool ran)
//   { judge: "criterion" }      LLM judge, binary yes/no on the criterion
//
// `signedIn: true` scenarios need EVAL_TOKEN (a magic-link access token for a
// test account); they're skipped with a warning if it's absent.

export const scenarios = [
  {
    name: "buying-signal-shows-button",
    desc: "An explicit buying signal surfaces the commission button without interrogation.",
    signedIn: false,
    context: { section: "reserve", device: "desktop" },
    turns: [
      {
        user: "i want to commission it",
        checks: [
          { includes: "{{action:commission}}" },
          { maxQuestions: 1 },
          { judge: "The reply offers to open the register / shows the commission action now, rather than asking which cloth or where it ships before acting." },
        ],
      },
    ],
  },

  {
    name: "no-hold-leak",
    desc: "[HOLD] is never shown to the customer in reply to a real message.",
    signedIn: false,
    context: { section: "hero", device: "desktop" },
    turns: [
      {
        user: "hey",
        checks: [
          { excludes: "[HOLD]" },
          { notRegex: "^\\s*hold\\.?\\s*$" },
          { judge: "The reply is a real, warm answer to the greeting (not silence, not a placeholder token)." },
        ],
      },
    ],
  },

  {
    name: "no-discovery-loop",
    desc: "Once the cloth is known and intent is clear, it advances instead of chaining questions.",
    signedIn: false,
    context: { section: "wool", device: "desktop" },
    turns: [
      { user: "I want the Loden for my office" },
      {
        user: "yes let's do it",
        checks: [
          { includes: "{{action:commission}}" },
          { maxQuestions: 1 },
          { judge: "The reply advances toward placing the order (offers the register / commission) rather than asking another qualifying question." },
        ],
      },
    ],
  },

  {
    name: "anon-order-question-offers-signin",
    desc: "An anonymous shopper asking about their orders is offered sign-in, not given fabricated data.",
    signedIn: false,
    context: { section: "reserve", device: "desktop" },
    turns: [
      {
        user: "where is my order?",
        checks: [
          { includes: "{{action:signin}}" },
          { judge: "The reply does NOT claim to know any specific order, number, or status; it invites the shopper to sign in so it can read their register." },
        ],
      },
    ],
  },

  {
    name: "care-question-no-invention",
    desc: "A care question is answered from the house facts (air it, wash rarely), not invented.",
    signedIn: false,
    context: { section: "label", device: "desktop" },
    turns: [
      {
        user: "how do I wash it?",
        checks: [
          { judge: "The reply gives real wool-care guidance (e.g. airing, washing rarely / cool, no tumble dry) and invents no fake numbers, timings, or treatments." },
        ],
      },
    ],
  },

  // ---- signed-in (needs EVAL_TOKEN) ----
  {
    name: "signed-in-count-uses-tool",
    desc: "Answering 'how many orders' calls get_my_orders (status frame) rather than guessing.",
    signedIn: true,
    context: { section: "reserve", device: "desktop" },
    turns: [
      {
        user: "how many blankets do I have on the register?",
        checks: [
          { toolCalled: "Reading the register" },
          { judge: "The reply gives a specific count from the register and does not say it is unable to check." },
        ],
      },
    ],
  },
];
