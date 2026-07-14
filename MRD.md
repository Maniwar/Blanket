# Market Requirements Document — AI Sales Concierge for Considered Purchases

*Reference implementation: Feierabend "Decke 01" (this repo). The storefront brand and
figures are an illustrative, fictional demo; the engine and the requirements below are
real. Companion documents: [PRD.md](PRD.md) · [TRD.md](TRD.md) · [DESIGN.md](DESIGN.md).*

**Status:** living document · **Owner:** Product · **Last review:** see git history.

---

## 1. Purpose

Define the market problem, the buyers and users, the opportunity, the competitive
landscape, and the market-level requirements (the *what*, not the *how*) for a
software product that gives a considered-purchase storefront a **genuinely attentive
sales associate as software** — one that clientels, sells honestly, and acts on a
customer's behalf.

## 2. Problem statement

High-consideration commerce (luxury goods, limited editions, made-to-order, big-ticket
DTC) converts through **relationship and guidance**, not search-and-filter. Online,
that relationship layer is missing:

- **The best associate in the store never comes to the website.** A shopper who would
  get warm, expert, patient guidance in person gets a static product page and a
  contact form.
- **Existing chat is either a deflection FAQ bot or expensive human live-chat** that
  doesn't scale to every visitor, every hour.
- **Merchants can't see or shape the selling.** There is no dial for "how hard to
  sell," no memory of a returning patron, no honest scarcity, and no way to prove the
  bot behaves as configured.
- **Attribution is guesswork.** Merchants can't tell which sales the assistant
  actually caused, so they can't justify or tune it.

The result: considered-purchase brands leave conversion, average order value, and
lifetime value on the table, and distrust "AI chat" because the available options are
either unhelpful or unsafe (hallucinated claims, invented urgency, off-brand tone).

## 3. Market & segmentation

**Primary market — merchants (the buyer):** DTC and boutique brands selling
*high-consideration* products where a purchase is deliberated, not impulsive:

| Segment | Examples | Why they need it |
|---|---|---|
| Limited editions / numbered goods | craft textiles, watches, art prints, spirits | scarcity + provenance selling; allocation integrity |
| Made-to-order / bespoke | furniture, tailoring, instruments | long consideration, gifting, personalization |
| Luxury & heritage DTC | home, apparel, accessories | clienteling and brand voice are the moat |
| Considered single-SKU / big-ticket | a car sale, a boat, high-end electronics | one deep conversation converts; lead capture matters |

**Secondary market — end users (the people served):** shoppers, returning patrons,
gift-givers, and (for checkout-less pages) serious inquiry leads.

**Market sizing note:** the wedge is "brands with <50 SKUs and >$300 AOV where a human
would materially raise conversion." Expansion path is the productized engine
(`concierge-kit`) that stamps the same concierge onto any such storefront.

## 4. Why now

1. **Model capability crossed the threshold.** Frontier LLMs can hold a multi-turn,
   on-brand, tool-using sales conversation that was not possible two years ago.
2. **Tool use + evals make it safe to let a model *act*,** not just talk — the blocker
   for real commerce was trust, and that is now an engineering problem with a solution.
3. **DTC economics tightened.** Paid acquisition costs rose; squeezing conversion and
   AOV from existing traffic beats buying more of it.
4. **Cost fell enough to serve every visitor.** Prompt caching and a semantic answer
   cache make an always-on concierge economically viable at scale.

## 5. Personas (market view)

- **The Merchant / Brand Owner (economic buyer).** Wants more conversion and AOV
  without cheapening the brand or risking an off-brand or dishonest bot. Measures ROI.
- **The Operator / Clienteling Manager (day-to-day user).** Tunes voice, procedures,
  and how hard to sell; works the leads and orders; needs to *trust and audit* the bot.
- **The Shopper (browsing → evaluating).** Wants expert help, honest answers, no
  pressure, and to be remembered next time.
- **The Gift-Giver.** Buying meaning for someone else; needs a different conversation.
- **The Serious Lead (checkout-less pages).** Ready to make an offer / book a viewing /
  ask the owner — the highest-value non-purchase act.

## 6. Jobs to be done

- *When I'm considering an expensive, unfamiliar purchase,* help me decide with expert,
  honest guidance so I feel confident, not sold-to.
- *When I come back,* remember me and my context so I don't start over.
- *As a merchant,* let me capture the revenue a great associate would, provably, without
  hiring one per visitor or risking my brand.
- *As an operator,* let me shape and trust the selling — change behavior without a
  deploy and see exactly what the bot did.

## 7. Competitive landscape & differentiation

| Category | Examples | Gap we exploit |
|---|---|---|
| FAQ / deflection bots | Intercom/Zendesk answer bots, Tidio | deflect, don't *sell*; no clienteling, no honest scarcity |
| Human live chat | Gorgias, live agents | doesn't scale to every visitor; costly; inconsistent |
| Generic LLM chat widgets | drop-in "AI chat" | off-brand, hallucination-prone, no memory, no actions, no audit |
| Clienteling / VOC platforms | Salesfloor, Medallia | in-store or analytics-first, not an autonomous web seller |
| DIY on a model API | in-house builds | no selling method, no eval harness, no safety layer, no admin surface |

**Differentiators (the moat):**
1. **A seller, not a Q&A bot** — an explicit, tunable selling method (discovery, moves,
   close shapes, price psychology, honest scarcity).
2. **Honest by construction** — persuasion shapes *when/how* true things are said, never
   *what* is true; independent runtime judges enforce it. This is the trust unlock.
3. **It acts** — reads the register, changes/cancels orders, captures leads — safely
   (ownership-scoped, audited).
4. **Everything tunable is data** — voice, knowledge, procedures, goals, and how-hard-
   to-sell are editable live, no deploy; and **provable** via an eval + conformance suite.
5. **Provable attribution** — a lead-vs-sale-honest conversion model tells the merchant
   what the concierge actually caused.

## 8. Market requirements (the *what*)

Prioritized; each maps to PRD features and TRD requirements.

| # | Requirement | Priority |
|---|---|---|
| MR-1 | Hold an on-brand, multi-turn sales conversation that guides a considered purchase | Must |
| MR-2 | Sell honestly — no invented facts, urgency, discounts, or (hedged) medical claims | Must |
| MR-3 | Remember returning customers and personalize (clienteling / memory) | Must |
| MR-4 | Take real actions on a customer's behalf, safely and auditably | Must |
| MR-5 | Capture leads on checkout-less pages (offer / viewing / question / callback) | Must |
| MR-6 | Let a non-engineer operator tune behavior and voice without a deploy | Must |
| MR-7 | Prove the bot behaves as configured, and behaves safely, on demand | Must |
| MR-8 | Attribute revenue/leads to the concierge, honestly (lead ≠ sale) | Must |
| MR-9 | Proactively re-engage without being annoying, and go quiet on demand | Should |
| MR-10 | Edit storefront copy/images/SEO without a deploy | Should |
| MR-11 | Run economically at scale (per-conversation cost bounded) | Must |
| MR-12 | Be adoptable onto a new storefront in days, not months | Should (expansion) |

## 9. Success metrics (market level)

- **Conversion lift** on concierge-engaged sessions vs. baseline.
- **AOV lift** (companion items, gifts, standing tiers).
- **Lead capture rate** on checkout-less installs.
- **Assisted-revenue share** attributed to the concierge (honestly bucketed).
- **Operator trust:** eval pass rate + conformance parity; low veto/incident rate.
- **Unit economics:** model cost per converted conversation.

## 10. Constraints & assumptions

- The product must never require the merchant to hand a browser a secret or trust the
  model with authorization — safety is a precondition of adoption, not a feature.
- Merchants have few SKUs and a strong brand voice; the concierge must *carry* that
  voice, not flatten it.
- Regulatory: honest claims and privacy (GDPR/CCPA) are table stakes; see
  [PRIVACY_REVIEW.md](PRIVACY_REVIEW.md) and [SECURITY.md](SECURITY.md).

## 11. Out of scope (market)

- Marketplaces / high-SKU catalog search (a different shopping model).
- Impulse/low-consideration commerce where guidance doesn't move conversion.
- Payment processing (a hosted processor is assumed; the demo takes no payment).
