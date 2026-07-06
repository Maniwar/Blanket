# Privacy compliance review

The output of a compliance check of [`privacy.html`](privacy.html) against the
**regulations** (EU/UK **GDPR** Art. 13/14, California **CCPA/CPRA**) — not merely
against the code. It records the required-disclosure gap analysis, the factual
corrections, and what still needs a human before a real launch.

> **Not legal advice.** This is a good-faith, standards-aligned engineering
> review. A production launch needs counsel review, a real legal entity + address,
> signed DPAs with each processor, and (if targeting the EU at scale) an Article 27
> representative.

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
| **International transfers + safeguard** | ❌ missing | ✅ §04 (US processors; Standard Contractual Clauses) |
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

## Still needs a human before production

- A **real legal entity name + postal address** and a monitored contact (the demo
  uses a fictional house and an `@…example` address).
- **Signed DPAs** with Supabase and Anthropic, and confirmation of the **transfer
  mechanism** actually in force (SCCs / UK IDTA / adequacy).
- An **EU Art. 27 representative** if you target EU data subjects at scale.
- If you add analytics or self-host vs. embed Google Fonts, revisit §03/§04 (fonts
  send the visitor's IP to Google — consider self-hosting to avoid it).
- A **cookie/consent banner** only if you later add non-essential cookies.

## Method

Requirements taken from GDPR Art. 13 and the CCPA/CPRA disclosure rules; each was
checked against the current `privacy.html` and against the codebase (schema,
functions) to confirm the policy matches actual data handling. See
[`SECURITY.md`](SECURITY.md) for the parallel security audit.
