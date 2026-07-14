# Technical Requirements Document — AI Sales Concierge

*Reference implementation: Feierabend "Decke 01" (this repo). Companion documents:
[MRD.md](MRD.md) · [PRD.md](PRD.md) · [DESIGN.md](DESIGN.md) · [supabase/SCHEMA.md](supabase/SCHEMA.md)
· [TOOLS.md](TOOLS.md) · [COST.md](COST.md) · [SCALING.md](SCALING.md) · [SECURITY.md](SECURITY.md).
Diagrams: [architecture](docs/architecture.svg) · [prompt assembly](docs/prompt-assembly.svg)
· [tool sequence](docs/tool-sequence.svg) · [cost model](docs/cost-model.svg).*

**Status:** living · **Owner:** Engineering · **Realized in:** this repository.

---

## 1. Architecture overview

A **serverless, static-first** system with three tiers and one authorization boundary:

```
Browser (static site, GitHub Pages/CDN)
   │  fetch + SSE, publishable anon key
   ▼
Edge functions (Supabase, Deno) — concierge + commission        ← all model calls here
   │  service role (server-only)                                  ← all secrets here
   ▼
Postgres (managed) + pgvector — RLS is the authorization boundary
   │
   ├─► Anthropic Claude API (streaming + tool use)  [sub-processor]
   └─► Resend (transactional email)                 [optional]
```

- **Front end:** self-contained static HTML/ES5 + `assets/*.js`, cache-busted, CDN-served.
- **Edge functions:** stateless Deno functions; autoscale horizontally.
- **Data:** managed Postgres with Row-Level Security; pgvector for the semantic cache.
- **No server to run, no container to patch.**

## 2. Components & responsibilities

| Component | Responsibility |
|---|---|
| `index.html` + `assets/concierge.js` | widget UI, SSE stream, proactive beats client, CMS hydrator |
| `assets/checkout.js` | commission/register sheet (edition/serial/hold commerce) |
| `admin.html` | operator studio — tuning, register ops, analytics, tools/forms, evals |
| `supabase/functions/concierge` | chat + agentic tool loop, prompt assembly, KB, beats, evals, config/CMS/inquiry endpoints |
| `supabase/functions/commission` | register writes (serial allocation, orders), service-only resend |
| Postgres + RLS | source of truth + the authorization boundary |
| `evals/` | behavior deck, conformance, persona, judge |
| `.github/workflows/*` | deploy (functions + Pages + SEO bake), eval gauntlet |

## 3. Data model (summary)

Full reference: [supabase/SCHEMA.md](supabase/SCHEMA.md). Key tables (24 total, all RLS-on):

- **Commerce:** `orders`, `allocation_counter`, `serial_holds`, `order_events`, `waitlist`.
- **Concierge:** `concierge_conversations`, `concierge_messages`, `customer_notes`
  (client book), `concierge_config`, `concierge_kb`, `concierge_sops`,
  `concierge_tools`, `concierge_forms`, `concierge_goals`, `concierge_evals`,
  `concierge_actions` (audit), `concierge_edit_history`, `concierge_cache` (pgvector).
- **Ops:** `rate_limits`, `email_log`, `site_content` (CMS), `concierge_inquiries`.

## 4. Interfaces & APIs

- **Chat:** `POST /concierge` — SSE stream; native Anthropic **tool use** loop
  (`while stop_reason==="tool_use"`, ≤4 rounds). Contract: [TOOLS.md](TOOLS.md),
  [docs/tool-sequence.svg](docs/tool-sequence.svg).
- **Public GET reads** (config-cached ~60s): `?config` `?site` `?tools` `?defaults`
  `?starters`. **Admin/JWT:** `?judge` `?secrets` `?tools`(write) `?cachecheck` etc.
  **Service-only:** commission `?custresend`. **Public rate-limited:** `?reengage`,
  `?wrapup`, `?form`, waitlist.
- **Auth:** Supabase passwordless magic-link (JWT bearer, not cookies).
- **Model:** Anthropic Messages API — streaming, tool use, prompt caching header.
- **Email:** Resend (fail-soft; every attempt logged to `email_log`).

## 5. Non-functional requirements

| # | Requirement | How it's met |
|---|---|---|
| TR-1 | **AuthZ in the database, not the UI** | RLS on all 24 tables; owner-scoped (`ownershipFilter`), admin via `is_concierge_admin()`, silent-deny tables via `security definer` RPCs. [SECURITY.md](SECURITY.md) |
| TR-2 | **No secret reaches the browser** | keys only in `Deno.env`; `?secrets` returns booleans; frontend holds only the publishable key |
| TR-3 | **Actions are safe** | signed-in only + ownership-scoped + audited; address edits via structured forms; input schema-validated server-side |
| TR-4 | **No exploitable injection / XSS** | numeric coercion, whitelists, UUID validation, `textContent`/output-encoding, link-token allowlist |
| TR-5 | **Privacy** | US-only demo; GDPR Art. 13/CCPA disclosures; PII admin-gated; retention pruning. [PRIVACY_REVIEW.md](PRIVACY_REVIEW.md) |
| TR-6 | **Bounded model cost** | prompt caching (static prefix / dynamic suffix, ~70–90% input cut), semantic answer cache (0 model calls on hit), goal-sampling. [COST.md](COST.md) |
| TR-7 | **Scales horizontally** | static CDN front end + stateless functions + RLS; DB-backed shared rate limiting; retention keeps high-write tables bounded. [SCALING.md](SCALING.md) |
| TR-8 | **Reliable / fail-soft** | rate-limit fail-over to in-memory; email fail-soft; reach-out judge fail-open; cache lapse ⇒ one extra write, never a wrong answer |
| TR-9 | **Observable & auditable** | append-only `order_events` + `concierge_actions` + `email_log`; each reply logs the exact model; beat vetoes logged with the killed line |
| TR-10 | **Config takes effect without deploy** | config/KB/SOPs/tools cached ~60s in module memory; edits versioned in `concierge_edit_history` with rollback |
| TR-11 | **Correctness under concurrency** | serial allocation via `FOR UPDATE`/`SKIP LOCKED`; holds return numbers lowest-first |

## 6. Model & prompt architecture

- **Assembly:** `buildSystemPrompt` returns `{prefix, suffix}` — a **static cached prefix**
  (brand, KB, tool guidance, SOPs, selling method, tuning) marked
  `cache_control: ephemeral`, and a **dynamic suffix** (LIVE STATE + goal agenda) left
  uncached. Cache order `tools → system → messages`. Diagram: [docs/prompt-assembly.svg](docs/prompt-assembly.svg), [docs/cost-model.svg](docs/cost-model.svg).
- **Knowledge:** injected whole per turn (not RAG) with named sections + precedence; a
  pgvector semantic cache answers common anonymous questions with zero model calls.
  [KNOWLEDGE.md](KNOWLEDGE.md).
- **Behavior control:** an editable constitution (`kb.ts`), selling method + exemplars,
  an assertiveness dial, hooks/objections — all data, all versioned.
- **Safety at runtime:** a reach-out **judge** (second, stricter read of proactive lines)
  and an advisory honesty **lint** at save time, both independent of the prompt.

## 7. Quality strategy

- **Behavior evals** — scripted conversations replayed against the live model;
  deterministic checks + a pinned binary LLM judge; reported as a pass rate.
- **Config conformance** — boots the real widget headless and proves, parameter by
  parameter, that configured settings == live behavior (dial scaling, timings included).
- **Persona evals** — a model plays distinct shoppers for multi-turn conversations,
  graded whole.
- **Gates:** the eval gauntlet runs in CI/deploy; catalog in [evals/CATALOG.md](evals/CATALOG.md);
  flow in [docs/testing-flows.svg](docs/testing-flows.svg).
- **Load testing:** a k6 harness ([loadtest/](loadtest/)) to measure the capacity ladder.

## 8. Deployment & operations

- **Front end:** GitHub Actions builds + publishes Pages on push; a best-effort
  `bake_seo.py` step writes SEO/OG into `<head>` for social crawlers ([CMS.md](CMS.md)).
- **Functions:** deployed via the Deploy Concierge workflow; secrets set with
  `supabase secrets set` (from GitHub secrets); `pages-retry.yml` handles transient
  deploy errors.
- **Schema:** idempotent `supabase/setup.sql` (+ numbered migrations); applies twice
  cleanly. Setup + verification: [SETUP.md](SETUP.md).

## 9. Key technical decisions & trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| KB injected whole, not RAG | small corpus; determinism; no retrieval infra | costs input tokens (mitigated by caching) |
| Static site + edge functions | zero servers; CDN scale; simple ops | logic split across client/edge |
| RLS as the authorization boundary | correctness independent of UI/volume | policy discipline required on every table |
| Everything tunable = data | operable by non-engineers; no deploys | a config surface to secure + validate |
| Native tool use (not a custom parser) | safety via structured channels; standard API | bounded to the model's tool-calling |
| Prompt caching prefix/suffix split | ~70–90% input-cost cut | byte-stable prefix constrains assembly |

## 10. Dependencies & risks

- **Anthropic API** (model + tokens + rate limits) — the binding cost/availability
  dependency at scale ([SCALING.md](SCALING.md) #8); semantic cache is the main lever.
- **Supabase** (Postgres, edge, auth) — plan limits (connections, egress) at scale.
- **Resend** (email) — optional; fail-soft.
- **Risk:** unbounded high-write tables → mitigated by retention now, partitioning later.
- **Risk:** per-request query fan-out → collapse into one RPC + pooler when RPS demands.

## 11. Requirements traceability

MRD market requirement → PRD feature → TRD control:
- MR-2 (honest selling) → FR-3 → §6 safety layers (constitution/judge/lint).
- MR-4 (safe actions) → FR-5/6 → TR-1/TR-3 (RLS, ownership, audit, forms).
- MR-7 (provable) → FR-16 → §7 eval + conformance suite.
- MR-11 (economical) → FR (caching/cache/sampling) → TR-6 ([COST.md](COST.md)).
- MR-12 (adoptable) → PRD P5 → `concierge-kit` stamping (external repo).
