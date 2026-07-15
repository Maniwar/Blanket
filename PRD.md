# Product Requirements Document — AI Sales Concierge

*Reference implementation: Feierabend "Decke 01" (this repo). Companion documents:
[MRD.md](MRD.md) (market) · [TRD.md](TRD.md) (technical) · [DESIGN.md](DESIGN.md)
(design rationale & full user stories) · [SALES.md](SALES.md) · [BEHAVIOR.md](BEHAVIOR.md)
· [TOOLS.md](TOOLS.md) · [ATTRIBUTION.md](ATTRIBUTION.md).*

**Status:** living · **Owner:** Product · **Reference build:** shipped & live-demoable.

---

## 1. Overview & vision

A storefront concierge that behaves like the best sales associate a brand has — warm,
expert, patient, honest — **as software**. It greets and remembers patrons, guides a
considered purchase with a real selling method, answers from a curated knowledge base
(never invents), acts on the customer's behalf (reads orders, changes a cloth, cancels,
captures a lead), and is **entirely tunable and provable** by a non-engineer operator.

**Product principle:** *persuasion may shape when and how true things are said — never
what is true.* Capability and honesty ship together or not at all.

## 2. Goals & non-goals

**Goals**
- G1 — Convert more considered-purchase visitors via guided, on-brand selling.
- G2 — Raise AOV and LTV through companions, gifts, standing, and re-engagement.
- G3 — Capture high-value leads where there is no checkout.
- G4 — Give operators full, deploy-free control **and** proof of behavior.
- G5 — Be honest and safe by construction (a precondition, not a feature).

**Non-goals**
- Not a general support/deflection bot; not catalog search for high-SKU stores.
- Not a payment processor; not a CMS replacement (it augments the storefront).
- Not RAG over a large corpus — the KB is injected whole (see [KNOWLEDGE.md](KNOWLEDGE.md)).

## 3. Success metrics (product KPIs)

| KPI | Definition | Instrumented by |
|---|---|---|
| Concierge-attributed conversion | orders where the concierge initiated/assisted | [ATTRIBUTION.md](ATTRIBUTION.md) tiers (✳ / assisted / unassisted) |
| AOV lift | order value on assisted vs. unassisted | Conversion tab |
| Lead capture | inquiries per session (checkout-less) | [INQUIRIES.md](INQUIRIES.md), Leads card |
| Behavior pass rate | eval deck pass % against the live model | eval harness (CI-gated) |
| Config parity | configured settings == live widget behavior | conformance report |
| Cost / conversation | model spend per customer conversation | the meter (`concierge_llm_usage`) → Spend tab; [COST.md](COST.md) |
| Silence health | held vs. spoken vs. vetoed proactive lines | beat audit / Actions tab |

## 4. Personas & core user stories

(Full set in [DESIGN.md](DESIGN.md); the essentials.)

- **Guest (browsing→evaluating):** *As a shopper, I want expert, no-pressure guidance so
  I can decide confidently.*
- **Signed-in Customer:** *As a patron, I want to be remembered and to change/track/cancel
  my order in chat.*
- **Gift-giver:** *As a gift-giver, I want the concierge to sell the meaning of the gift
  and put the recipient at the center.*
- **Merchant:** *As a brand, I want more conversion/AOV without cheapening or risking my
  brand.*
- **Operator:** *As an operator, I want to tune voice, procedures, and how-hard-to-sell
  without a deploy, and see exactly what the bot did.*
- **Super Admin:** *As the owner, I want irreversible-safe controls (the super-admin
  cannot be demoted) and full audit.*
- **Serious Lead:** *As a serious buyer with no account, I want to make an offer / book a
  viewing / ask the owner.*

## 5. Functional requirements

### 5.1 Conversation & selling
- FR-1 Multi-turn streaming chat in the brand voice; answer-then-one-move per turn.
- FR-2 A configurable **selling method** — silent stage read, SPIN-shaped discovery,
  give-first, six moves + three close shapes, price psychology, honest scarcity, gift
  psychology, an assertiveness **dial (1–5)**. Spec: [SALES.md](SALES.md).
- FR-3 Honesty constraints enforced independently of the prompt (constitution +
  reach-out judge + honesty lint). No invented facts/urgency/discounts/medical claims.
- FR-4 Knowledge answered from a curated KB injected whole per turn (not RAG); a semantic
  answer cache serves common anonymous questions with zero model calls.

### 5.2 Actions (tools)
- FR-5 The concierge can **act** for a signed-in patron via native tool use: read orders,
  change colorway, cancel, resend confirmation, track, care guide, gift details, mending,
  remember/recall, waitlist. Spec: [TOOLS.md](TOOLS.md).
- FR-6 Every action is **signed-in only, ownership-scoped, and audited**; address edits go
  through a structured **form**, not free-text (see [FORMS.md](FORMS.md)).
- FR-7 Admins can enable/disable/re-instruct model tools and **create form tools** (over an
  existing write path) without a deploy.

### 5.3 Lead capture (checkout-less mode)
- FR-8 An anonymous-capable **inquiry** primitive (offer / viewing / question / callback)
  that stores a row and emails the house, rate-limited and fail-soft. [INQUIRIES.md](INQUIRIES.md).

### 5.4 Proactive engagement
- FR-9 The concierge speaks first on open, re-engages on quiet (in-panel ladder + closed-
  panel bubble), never repeats a door, remembers a "no" on an escalating cadence, and can
  be told "that's all for now." Substance-or-silence; a runtime judge vetoes bad lines.
  Spec: [BEHAVIOR.md](BEHAVIOR.md).

### 5.5 Merchant / operator studio
- FR-10 Edit voice, KB, SOPs, selling method, exemplars, goals, tools, forms, engagement
  pacing, and the model — as **data, live, no deploy**; every save versioned with rollback.
- FR-11 Manage the register: set the edition run, advance fulfillment (placed→…→shipped +
  tracking), edit addresses, send branded emails.
- FR-12 Work leads and orders with **server-side search + filters + pagination**.
- FR-13 A **conversion/analytics** surface with honest attribution and a leads card.

### 5.6 Content (CMS)
- FR-14 Edit storefront copy/images/SEO without a deploy (hydrate over HTML defaults);
  two-layer SEO (runtime + deploy-time head bake). Spec: [CMS.md](CMS.md).

### 5.7 Identity
- FR-15 Passwordless magic-link auth; anonymous browsing fully supported; signed-in unlocks
  memory + actions.

### 5.8 Quality & proof
- FR-16 A behavior-eval deck, a config-conformance report, and persona evals — runnable on
  demand and gating deploys. Spec: [evals/](evals/), [TRD.md](TRD.md) §7.

## 6. Key flows

1. **Browse → guided sell → commission:** discovery → recommend/show → advance with the
   register button on the same message → checkout sheet.
2. **Return → recognized → act:** magic-link → greeting by name + standing → "change my
   Loden to Graphit" → tool call → confirmation.
3. **No checkout → lead:** "I'd like to make an offer" → inquiry form → owner emailed →
   admin works the lead.
4. **Operator tune:** Studio → Selling → adjust dial/exemplars → save → live in ~60s →
   verify via conformance.

## 7. Configurability model (a first-class product surface)

Voice/knowledge/procedures/selling/goals/tools/forms/pacing/model are **rows**, not code,
with edit history + rollback and an advisory honesty lint at save time. This is what makes
the product operable by a merchant and is a core differentiator (see MRD §7).

## 8. Release phases

| Phase | Scope | State |
|---|---|---|
| P0 | Core concierge: chat, KB, selling method, register, auth, admin | ✅ shipped |
| P1 | Actions/tools, forms, gifts, standing, goals, proactive beats | ✅ shipped |
| P2 | Attribution & conversion analytics; retention/pruning | ✅ shipped |
| P3 | Eval harness + conformance + persona + CI gates | ✅ shipped |
| P4 | Inquiry mode (checkout-less), storefront CMS, cost/scaling hardening | ✅ shipped |
| P5 | **Productization** — stamp the engine onto a new storefront (`concierge-kit`) | in progress |

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Model says something untrue/off-brand | constitution + reach-out judge + honesty lint + eval gates |
| Bot is annoying (over-outreach) | substance-gate, escalating cool-off, "that's all," judge veto |
| Operator misconfigures behavior | conformance proof, versioned edits + rollback, honesty lint |
| Model cost at scale | prompt caching, semantic cache, goal-sampling ([COST.md](COST.md)) |
| A user tries to forge a tool call | structured channels + JWT identity + RLS ([TOOLS.md](TOOLS.md)) |
| Attribution overclaims | lead≠sale walls, tiered attribution, test-traffic exclusions |

## 10. Open questions

- Select/radio form field type (constrained choices) — backlogged.
- Table partitioning at true web-scale ([SCALING.md](SCALING.md) #2) — when volume demands.
- Templating re-engagement lines to skip a model call at low assertiveness ([COST.md](COST.md)).

## 11. Out of scope

High-SKU catalog search · payment processing · a full CMS · support-ticket deflection.
