# Privacy compliance review

The output of a compliance check of [`privacy.html`](privacy.html) against the
**regulations** (EU/UK **GDPR** Art. 13/14, California **CCPA/CPRA**) — not merely
against the code. It records the required-disclosure gap analysis, the factual
corrections, and what still needs a human before a real launch.

> **Not legal advice.** This is a good-faith, standards-aligned engineering
> review.

> **Scope.** The current deployment is a **US-based demonstration served to US
> visitors, with no real customers**. On those facts neither the **GDPR**
> (territorial scope keys on *targeting EU data subjects* — this demo doesn't) nor
> the **CCPA/CPRA** (applies to *businesses* over revenue/consumer thresholds — a
> demo meets none) *formally attaches*. The published notice is therefore a
> **good-faith transparency courtesy**, not a legal obligation. The items below are
> what would be required **if this went to production with real (or EU) customers**
> — not gaps in the demo.

## Part 1 — Factual accuracy (policy vs. what the code actually does)

| Claim in the old policy | Reality in code | Action |
| --- | --- | --- |
| §02 "we don't ask for **street addresses**" | `orders` stores `address/address2/city/state/zip`; checkout + address-change form collect them | **Fixed** — policy now states a shipping address is collected (register mirrors a real commission) |
| §01 "**Anonymous** chat messages" | signed-in chat is attributed (conversation carries `user_email`) | **Fixed** — "tied to your account when signed in" |
| IP addresses (not mentioned) | used transiently for rate-limiting (`rate_limits`), never on a conversation/order | **Added** — disclosed as transient security data |
| "No payment data, ever" | no card/payment fields anywhere in schema/functions | **Verified accurate** |
| "No third-party ad trackers" | no analytics/ad scripts; only Google Fonts (not a tracker) | **Verified accurate** |
| Supabase (US) + Anthropic sub-processor, not used to train | matches deployment + Anthropic commercial terms | **Verified accurate** |

## Part 2 — GDPR Article 13 required disclosures

| Required element | Before | After |
| --- | --- | --- |
| Identity of the controller | ⚠️ implicit | ✅ §10 names the controller |
| Purposes of processing | ✅ | ✅ §02 |
| **Legal basis** for each purpose | ❌ missing | ✅ §02 (contract / legitimate interest / consent) |
| Legitimate interests, where relied on | ❌ | ✅ §02 (answering, improving, rate-limiting) |
| Recipients / sub-processors | ✅ | ✅ §04 (Supabase, Anthropic) |
| **International transfers** | ❌ missing | ✅ §04 — **N/A**: US-only demo, US processors, no cross-border transfer to safeguard |
| Retention period / criteria | ✅ | ✅ §07 |
| Rights: access, rectification, erasure | ✅ partial | ✅ §05 |
| Rights: **restriction, portability, objection, withdraw consent** | ❌ missing | ✅ §05 |
| **Right to lodge a complaint with a supervisory authority** | ❌ missing | ✅ §05 |
| Existence of **automated decision-making / profiling** | ❌ missing | ✅ §06 (light profiling; no Art. 22 significant-effect decisions) |

## Part 3 — CCPA / CPRA required elements

| Required element | Status |
| --- | --- |
| Categories of personal information collected | ✅ §01 |
| Purposes of use | ✅ §02 |
| Sale / sharing disclosure | ✅ §03 — we do **not** sell or share |
| "Do Not Sell or Share" link | ✅ §03 — N/A stated (nothing sold/shared) |
| Sensitive PI + right to limit | ✅ §02/§03 — none collected |
| Consumer rights: know, delete, correct | ✅ §05 |
| Non-discrimination | ✅ §05 |
| Request method + verification | ✅ §05 (email, reply-from-file) |
| Response timeline | ✅ §05 (45 days) |
| Authorized agent | ✅ §05 |
| Global Privacy Control honored | ✅ §03 |
| Retention by category/criteria | ✅ §07 |
| Effective/last-updated date | ✅ header + §10 |

## Part 4 — Added for good practice (not strictly required)

- **Security measures** (§08) — RLS, encryption in transit, server-only secrets.
- **Children's data** (§09) — not directed to under-16s; removal on notice.

## Only if this goes to production (real customers) — not needed for the demo

These are **not gaps in the current US-only demo** (see Scope). They apply if you
later serve real customers or target the EU:

- A **real legal entity name + postal address** and a **monitored contact inbox**
  (the demo uses a fictional house and an `@…example` address) — so the delete /
  access rights the notice promises are actually actionable.
- A **signed DPA with each processor** (Anthropic and Supabase both offer one) —
  needed once a privacy law attaches; **not required for this demo**, and the
  policy no longer claims one is in force.
- **EU-only items** — an Article 27 representative and Standard Contractual
  Clauses — **only if you serve EU data subjects**, which this US-only demo does
  not. The policy makes no EU-transfer claim.
- A **cookie/consent banner** only if you later add non-essential cookies (none
  today).

Resolved in code (needs nothing further):

- ~~Google Fonts send the visitor's IP to Google.~~ **Done** — typefaces are
  self-hosted (`fonts/`); the pages load no third-party resources at all (§04).

## Method

Requirements taken from GDPR Art. 13 and the CCPA/CPRA disclosure rules; each was
checked against the current `privacy.html` and against the codebase (schema,
functions) to confirm the policy matches actual data handling. See
[`SECURITY.md`](SECURITY.md) for the parallel security audit.
