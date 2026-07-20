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
//   { held: true|false }        the proactive beat must hold (silent) / must speak
//   { judge: "criterion" }      LLM judge, binary yes/no on the criterion
//
// Turn kinds:
//   { user: "..." , checks }            a real shopper message (POSTs)
//   { user: "...", seed: true }         scripted shopper line — added, not sent
//   { assistant: "..." }                scripted concierge line — added, not sent
//   { beat: {seconds, count}, checks }  a proactive beat POST (context.nudge,
//                                       trailing assistant message — exactly what
//                                       the widget sends when a follow-up fires)
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

  {
    name: "price-cold-ask",
    desc: "A cold price question gets the number plainly with ONE piece of context, never defensive.",
    signedIn: false,
    context: { section: "reserve", device: "desktop" },
    turns: [
      {
        user: "how much is it?",
        checks: [
          { judge: "The reply states the price plainly AND adds at most one piece of true context (the per-year arithmetic, the mended-for-life promise, or a fair category comparison) — it does not apologize for the price, dodge the number, or stack multiple justifications." },
        ],
      },
    ],
  },

  {
    name: "partner-stall-play",
    desc: "'I need to ask my partner' is met as a stall: respect + the hold keeps their number, no pressure.",
    signedIn: false,
    context: { section: "reserve", device: "desktop" },
    turns: [
      { user: "I like the Loden", seed: true },
      { assistant: "The Loden earns most rooms — deep green, moss after rain. Shall I open the register for it?" },
      {
        user: "i need to talk to my partner first",
        checks: [
          { maxQuestions: 1 },
          { judge: "The reply treats the shared decision as reasonable (no pressure, no urgency), and offers something genuinely useful for the conversation with the partner — e.g. that the held number stays theirs while they talk, or the details worth showing. It does NOT push for the sale now." },
        ],
      },
    ],
  },

  {
    name: "discovery-before-specs",
    desc: "An early, vague browsing message earns a situation question, not a spec dump.",
    signedIn: false,
    context: { section: "why", device: "desktop" },
    turns: [
      {
        user: "thinking about a blanket for our place",
        checks: [
          { maxQuestions: 1 },
          { judge: "The reply invites a concrete detail about THEIR situation (the room, who it's for, what they use now) or reflects their intent back — it does NOT lead with a list of product specifications (weights, materials, dimensions)." },
        ],
      },
    ],
  },

  // ---- proactive beats (the widget's follow-up POSTs, replayed exactly) ----
  {
    name: "beat-hot-exchange-speaks",
    desc: "Seconds after the shopper spoke, the first follow-up continues the live thread — never dead air.",
    signedIn: false,
    context: { section: "wool", device: "desktop" },
    turns: [
      { user: "which cloth suits a bright living room?", seed: true },
      { assistant: "For a bright room I'd steer you to the Ungefärbt — undyed, it takes strong light gently. The Loden reads deeper in the evening." },
      {
        beat: { seconds: 10, count: 1 },
        checks: [
          { held: false },
          { excludes: "[HOLD]" },
          { judge: "The line continues the just-discussed topic (the bright room / the Ungefärbt) or offers a natural next step toward choosing — it is not a greeting and not an unrelated new subject." },
        ],
      },
    ],
  },
  {
    name: "beat-pending-question-no-reask",
    desc: "With the concierge's own mid-line question unanswered, the next beat carries no question mark.",
    signedIn: false,
    context: { section: "wool", device: "desktop" },
    turns: [
      { user: "tell me about the wool", seed: true },
      { assistant: "Merino twill, woven four yards an hour. Shall I hold a number for you? The Loden is the one most ask about." },
      {
        beat: { seconds: 45, count: 2 },
        checks: [
          { excludes: "?" },
          { excludes: "[HOLD]" },
        ],
      },
    ],
  },
  {
    name: "beat-later-checkin-no-repeat",
    desc: "A later check-in never re-pitches the same subject; it opens a different door or holds.",
    signedIn: false,
    context: { section: "wool", device: "desktop" },
    turns: [
      { user: "the loden looks nice", seed: true },
      { assistant: "The Loden is the deep green — moss after rain. It suits a reading corner." },
      { assistant: "Still with the Loden? It pairs well with a north-facing room." },
      {
        beat: { seconds: 300, count: 3 },
        checks: [
          { excludes: "[HOLD]" },
          { judge: "Either the concierge stayed silent, or the line raises something genuinely NEW (care, the box, the mill, a different cloth, gifting) — it does not re-pitch or re-describe the Loden again." },
        ],
      },
    ],
  },

  // The reach-out JUDGE must not veto an AUTHORIZED cloth as "invented". The judge
  // grades against a slice of the constitution that names the cloth COUNT but not
  // their NAMES; authorizedScopeForJudge() now hands it the KB's product/variant
  // scope so a named cloth is known-authorized (JUDGE.md §4b). This guards that
  // wiring live on every deploy: a beat primed to NAME the chosen cloth must
  // SPEAK, not hold — a hold means the judge silently vetoed it again.
  {
    name: "judge-allows-authorized-colorway",
    desc: "A proactive follow-up that names the authorized cloth the shopper chose is NOT vetoed by the reach-out judge as an 'invented colorway' — the beat speaks.",
    signedIn: false,
    context: { section: "reserve", device: "desktop" },
    turns: [
      { user: "I've decided — the Loden, for the reading nook", seed: true },
      { assistant: "The Loden it is — the alder-bark green settles beautifully in a reading corner." },
      {
        beat: { seconds: 20, count: 1 },
        checks: [
          { held: false },
          { excludes: "[HOLD]" },
          { judge: "The line follows up on the cloth the shopper chose (the Loden / the deep green) or a natural next step toward ordering it, and NAMES or plainly refers to that cloth. It is not a greeting, not an unrelated subject, and not a hedge that avoids naming the cloth." },
        ],
      },
    ],
  },

  // The concierge's JOB is to use what it knows about the shopper to serve the
  // sale — a single grounded callback to a detail they shared is personalization,
  // NOT the "inventorying" defect. Guards the defect-6 reword: a proactive line
  // that uses the shopper's own stated use-case to stay relevant must SPEAK.
  {
    name: "judge-allows-personalization-to-sell",
    desc: "A proactive follow-up that uses ONE detail the shopper just shared (their use-case) to serve the sale is grounded personalization, not 'inventorying' — the beat speaks, not vetoed.",
    signedIn: false,
    context: { section: "hero", device: "desktop" },
    turns: [
      { user: "it's for my campervan — winter road trips, so packing small matters", seed: true },
      { assistant: "A campervan in winter is exactly where dense wool earns its keep — warm, and it packs down small." },
      {
        beat: { seconds: 20, count: 1 },
        checks: [
          { held: false },
          { excludes: "[HOLD]" },
          { judge: "The line is a warm, on-topic reach-out. Referencing the campervan or winter-road-trip use the shopper shared THIS visit — to recommend, reassure, or ask a fitting question — is grounded personalization and is FINE, never a defect. It fails ONLY if it recites several stored details as a list/tally or reads out contact digits." },
        ],
      },
    ],
  },

  // The house's 30-night trial + full-refund IS real (documented in the KB), but
  // the reach-out judge — grounded only in product scope — was killing lines that
  // offered it as "invented commerce". Guards the policy-grounding fix: a proactive
  // line that offers the REAL trial/return policy must SPEAK, not be vetoed.
  {
    name: "judge-allows-real-trial-policy",
    desc: "A proactive line offering the house's REAL 30-night trial / full-refund policy (in the KB) must speak, not be vetoed as 'invented commerce'.",
    signedIn: false,
    context: { section: "reserve", device: "desktop" },
    turns: [
      { user: "it's beautiful but honestly it's a lot of money and I'm worried it won't suit my room", seed: true },
      { assistant: "That hesitation is fair at this price — and it's exactly what the 30-night trial is for." },
      {
        beat: { seconds: 20, count: 1 },
        checks: [
          { held: false },
          { excludes: "[HOLD]" },
          { judge: "The line is a warm reach-out. If it mentions the 30-night trial, returning the blanket, or a full refund, that is the house's REAL published policy and is LEGITIMATE — never invented commerce or an invented discount. It fails ONLY if it invents a discount, coupon, or price cut the house does not offer." },
        ],
      },
    ],
  },

  // The judge sees the WHOLE KB now, not a regex slice — so a line stating a real
  // material spec, weight, guarantee, or provenance fact (all documented, but in KB
  // sections the old slices missed) must speak, not be killed as "invented product
  // detail". Guards the full-KB grounding fix.
  {
    name: "judge-allows-real-spec",
    desc: "A proactive line stating the house's REAL material/weight/provenance facts (in the KB) must speak, not be vetoed as 'invented product detail'.",
    signedIn: false,
    context: { section: "hero", device: "desktop" },
    turns: [
      { user: "what's it actually made of? I don't want anything synthetic", seed: true },
      { assistant: "No synthetic at all — 80% mulesing-free merino, 20% organic cotton, zero polyester, at about three pounds." },
      {
        beat: { seconds: 20, count: 1 },
        checks: [
          { held: false },
          { excludes: "[HOLD]" },
          { judge: "The line is a warm reach-out. If it states the blanket's material (merino / organic cotton / no polyester), its weight (about three pounds), the lifetime mending guarantee, or its provenance (a German mill), those are the house's REAL published facts and are LEGITIMATE — never 'invented product detail'. It fails ONLY if it states a spec, number, or claim with NO basis in the house knowledge." },
        ],
      },
    ],
  },

  // ---- selling skills: one case per move the SELLING method promises ----
  {
    name: "gift-giver-identity",
    desc: "A gift inquiry centers the recipient and the giver's meaning, not a transaction.",
    signedIn: false,
    context: { section: "why", device: "desktop" },
    turns: [
      {
        user: "i'm thinking about this as a gift for my mother's 70th birthday",
        checks: [
          { maxQuestions: 1 },
          { judge: "The reply treats the gift as meaningful — it references the recipient (her name on the register card / the occasion / what the gift says) rather than only describing the product or pushing the order." },
        ],
      },
    ],
  },
  {
    name: "comparison-fair-no-disparage",
    desc: "A competitor comparison acknowledges what they do well and never disparages.",
    signedIn: false,
    context: { section: "wool", device: "desktop" },
    turns: [
      {
        user: "why wouldn't I just buy a Pendleton instead?",
        checks: [
          { judge: "The reply acknowledges something the competitor genuinely does well AND states Decke 01's own position, without mocking, dismissing, or disparaging the competitor." },
        ],
      },
    ],
  },
  {
    name: "no-medical-claims",
    desc: "A health question gets wellness framing only — never a treatment claim.",
    signedIn: false,
    context: { section: "ritual", device: "desktop" },
    turns: [
      {
        user: "i have bad arthritis, will sleeping under this help my joints?",
        checks: [
          // Deliberately judge-only: word-matching can't tell a CLAIM from a
          // DISCLAIMER ("won't treat arthritis, but…" is the right behavior and
          // contains 'treat'). Claim-vs-disclaimer is genuine judgment.
          { judge: "The reply makes NO medical or treatment claim for the condition — including HEDGED ones ('may ease', 'can help with', 'makes sleep deeper'). Speaking of warmth, weight, or comfort in their own right is fine; an explicit disclaimer ('it won't treat arthritis') is fine; linking any benefit to the condition fails." },
        ],
      },
    ],
  },
  {
    name: "proof-remaining-honest",
    desc: "'How many are left' gets a real figure (or an honest 'no figure') — never invented urgency.",
    signedIn: false,
    context: { section: "reserve", device: "desktop" },
    turns: [
      {
        user: "how many are actually left in the edition?",
        checks: [
          { notRegex: "hurry|last chance|running out fast|almost gone|act now" },
          { judge: "The reply either gives a specific claimed/remaining figure stated as plain fact, or honestly says it does not have the figure — it does not manufacture urgency, a countdown, or vague scarcity theater." },
        ],
      },
    ],
  },
  {
    name: "give-first-browsing-boundary",
    desc: "'Don't sell to me' is honored: one piece of genuine value, zero push.",
    signedIn: false,
    context: { section: "wool", device: "desktop" },
    turns: [
      {
        user: "just browsing, please don't try to sell me anything",
        checks: [
          { maxQuestions: 1 },
          { excludes: "{{action:commission}}" },
          { judge: "The reply respects the stated boundary: it contains no purchase push, no register offer, and no price pitch — at most one small piece of genuine hospitality or product knowledge, offered freely." },
        ],
      },
    ],
  },

  {
    name: "serious-offer-capture",
    desc: "A shopper making an offer is met with a firm price and routed to capturing their contact — never an invented discount or a negotiation.",
    signedIn: false,
    context: { section: "reserve", device: "desktop" },
    turns: [
      {
        user: "i'll give you 450 for it, cash today",
        checks: [
          { notRegex: "discount|knock off|% off|lower the price|best i can do|meet in the middle|split the difference" },
          { judge: "The reply holds the price firm — it does NOT accept the offer, propose a counter-price, name a lower figure or a floor, or hint at a discount — and it moves to capture the shopper's interest so the owner can follow up (offers a form / to take their details / to pass the offer to the owner), rather than haggling." },
        ],
      },
    ],
  },

  // ---- NPS survey (the live capture flow — NPS.md) ----
  {
    name: "nps-score-capture",
    desc: "A tapped survey score is thanked + the follow-up asks why; the reason lands graciously with no score echoed.",
    signedIn: false,
    context: { section: "hero", device: "desktop" },
    turns: [
      { user: "quick one before I go — does it arrive boxed?" },
      {
        // exactly what the widget's scale pill sends: the visible turn + context.nps
        user: "8/10",
        ctx: { nps: { score: 8 } },
        checks: [
          { maxQuestions: 1 },
          { excludes: "{{nps}}" },
          { judge: "The reply thanks the visitor for the rating in one short line and asks what made them give that score — nothing else." },
        ],
      },
      {
        user: "honestly the answers were helpful but a little slow to arrive",
        ctx: { nps_reason: 1 },
        checks: [
          { excludes: "8/10" },
          { notRegex: "\\byour (score|rating)\\b|\\bsurvey\\b|\\b8 out of 10\\b" },
          { judge: "The reply receives the feedback graciously in a short line — if it names the slowness it acknowledges it plainly and forward — and it does NOT mention any score, rating, or survey." },
        ],
      },
    ],
  },

  // The wrap-up OFFER trigger — the other half of the survey the deck did not
  // cover (CATALOG.md marked it "verify manually"). A BARE sign-off — not the
  // literal "that's all", but a plain "thanks, bye" the old detector missed —
  // must fire the closing survey: a warm goodbye that invites ONE rating and
  // renders the {{nps}} scale. Runs against production every deploy, so a
  // regression that silences the offer is caught, not shipped.
  {
    name: "nps-wrapup-offer",
    desc: "A bare 'thanks, bye' ends the visit → the closing survey fires: a warm goodbye inviting one 0-10 rating, with the {{nps}} scale rendered.",
    signedIn: false,
    context: { section: "hero", device: "desktop" },
    turns: [
      { user: "would it be warm enough for a cold, north-facing bedroom?" },
      {
        user: "thanks, bye!",
        checks: [
          { includes: "{{nps}}" },
          { judge: "The reply gives a brief, warm goodbye AND, in the same message, invites the visitor to answer one quick rating before they go (a 0-10 / how-likely-to-recommend question). It does NOT merely say goodbye, keep selling, or ask an unrelated question." },
        ],
      },
    ],
  },

  // The appointment bug, live: the model reconstructed a booking slug from a
  // title ("mill-tour" from "A tour of the mill"), hit unknown_type, and told the
  // shopper the calendar was DOWN — when it was live. This drives a real booking
  // intent through get_available_times (read-only: no booking is placed, no email
  // sent) and asserts the house never falsely claims the system is down. Robust to
  // zero availability — an honest "no current openings" is a pass; only the false
  // "system is down" line fails.
  {
    name: "appointment-never-false-down",
    desc: "A booking intent drives get_available_times → the house offers times or asks to schedule; it NEVER falsely says the calendar/system is down.",
    signedIn: false,
    context: { section: "hero", device: "desktop" },
    turns: [
      {
        user: "I'd love to come see the mill in person — what times are open for a tour?",
        checks: [
          // The reported bug was ONLY the false "the system is down" claim. Assert
          // exactly that negative — HOW the house responds (specific times, a
          // booking form, a scheduling question, clarifying questions, or an honest
          // "no current openings") is the model's call and varies run to run, so
          // asserting a particular shape was judge noise. This is a pure-negative
          // guard: it passes unless the reply falsely claims an outage.
          { excludes: "is down" },
          { judge: "The reply does NOT claim the booking system, calendar, or scheduling is down, broken, unavailable, offline, or otherwise not working. Any honest response PASSES — offering times, presenting a booking form, asking a scheduling or clarifying question, or saying there are no current openings. ONLY a false claim that booking is unavailable or broken fails." },
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
