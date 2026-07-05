# Scaling review — what holds, what breaks at millions of users

An honest read of where this architecture stands if traffic grew by orders of
magnitude, and the concrete work each gap needs. Written against the code as of
this review; re-check as it changes.

**Short version:** the *shape* is sound — static front end on a CDN, stateless
edge functions, Postgres with RLS as the boundary. Nothing here needs a rewrite
to scale. But a handful of specific things are built for a demo's volume and
would bite at scale. They're ranked below, worst first.

---

## Scales fine as-is

- **Front end (GitHub Pages).** Static, cache-busted, CDN-served. Millions of
  readers is what a CDN is *for*. No change.
- **Edge functions (stateless).** Deno functions autoscale horizontally; each
  request is independent. The compute model is fine.
- **RLS as the boundary.** Correctness doesn't degrade with volume — the same
  policies hold at any size.
- **Semantic cache lookup.** `match_cached_answer` rides the HNSW index
  (`vector_ip_ops`), so it's ~log-time, and it *offloads* the expensive path
  (the LLM) for common questions — it gets *more* valuable at scale.

---

## Blockers — fix before real scale

### 1. Rate limiting is in-memory per instance — ✅ FIXED (now DB-backed)
*Was:* `const hits = new Map()` in both functions counted requests **per warm
instance**, so the "20 / 10 min" limit was really "20 × however many instances,
reset on every cold start" — almost no protection at scale.
*Now:* a Postgres `rate_limits` table + `rate_hit(key, limit, window_seconds)`
`security definer` RPC (atomic upsert into a fixed window) gives one shared
window across every edge instance. Both functions call it; each **fails over to
the per-instance in-memory counter** if the DB is momentarily unreachable, so an
outage never blocks legitimate traffic. The table self-prunes to ~one row per
active key. *(Migration `0025` / `setup.sql`.)* A whole-table sweep of stale
windows (pg_cron) is the optional belt-and-suspenders for very high key churn.

### 2. Unbounded high-write tables — `concierge_messages`, `concierge_actions`, `order_events`
Every chat turn writes a message row; every tool call writes an action row.
At millions of users these become billions of rows in a single table — heavy
autovacuum, bloated indexes, slow range scans.
**Fix:** partition by time (monthly range partitions) and add a retention/archival
policy (drop or cold-store partitions older than N months). Decide a retention
window per table (messages can be shorter than orders).

### 3. Admin panel can't search — only shows the latest slice
Every admin loader fetches the most recent N with **no filtering and no real
pagination**: orders `limit(1000)` (then grouped client-side), conversations
`limit(50)`, actions `limit(20)`, cache `limit(100)`. The Customers search box
filters *only within* the 1000 already fetched. So at scale an admin literally
cannot find a specific customer's conversation, an order from last month, or an
action by a given email. **This is the feature this review triggers — see
[Immediate work](#immediate-work-admin-filtering) below.**

### 4. Analytics counts do full-table `count(exact)` — ✅ FIXED
*Was:* the Conversations summary ran `count: 'exact'` over whole tables
(`feedback`, `orders`) — full scans, seconds-to-minutes on huge tables.
*Now:* the date-bounded counts (today's conversations/messages, on the
`created_at` index) stay exact and cheap; the whole-table counts (feedback total,
👍 count, assisted orders) use `count: 'estimated'`, which PostgREST serves from
the planner's `reltuples` estimate on large tables (and still returns exact on
small ones) — O(1) regardless of size.

---

## Needs attention (not blockers, but plan for them)

### 5. Per-request query fan-out in the functions
`customerBlock` issues ~3 sequential queries (notes, last conversation, orders)
per chat request; the tool loop adds more. At high RPS this multiplies DB
round-trips. **Fix:** collapse into fewer round-trips (one RPC returning the
customer bundle), and make sure PostgREST goes through the pooler (Supavisor)
so connections don't exhaust.

### 6. Serial allocation serializes on one row
`hold_serial` / `commission_order` take `FOR UPDATE` on `allocation_counter`
(id=1). That's a single-row lock — correct, but a serialization point under a
stampede of concurrent commissions. For a **15,000-piece edition** this is a
non-issue (scarcity *is* the point; volume is low). It would only matter if the
model were reused for a high-volume, non-scarce product — then switch to a
sequence or sharded counter.

### 7. Async LLM work per conversation
Goal scoring and client-book summarization each fire an LLM call per
conversation. At scale that's real Anthropic spend and concurrency pressure
(their rate limits, not ours). **Fix:** sample (score a fraction), batch, or
queue this work rather than doing it inline on every conversation.

### 8. Cost & third-party quotas, not architecture
At millions of chats the binding constraint becomes Anthropic token cost and
per-account rate limits, plus Supabase plan limits (connections, egress,
function invocations). The semantic cache is the main lever; beyond that it's
capacity planning with the providers, not a code change.

---

## Immediate work: admin filtering

The one gap this review is asked to close now: **the audit surfaces need
server-side filtering by date range, email, and keyword, with pagination** —
so admins can actually find things when there are millions of rows, not just
scroll the latest slice.

Implemented in this pass (see the Conversations, Customers, and Register-actions
tabs):

- **Server-side filters** pushed into the query (`gte`/`lte` on the timestamp,
  `ilike` on email, keyword match) instead of filtering a capped client-side
  fetch — so a match is found even if it's the millionth row.
- **Keyword search** over the relevant text (order name/email, action
  name/result, and conversation *message content* via the messages table).
- **Pagination** ("load more" by keyset/range) so results aren't capped at the
  first page.
- **Supporting indexes** (see `supabase/setup.sql` / migration `0024`):
  `orders(placed_at)`, `orders(status)`, `concierge_actions(email, created_at)`,
  `concierge_conversations(user_email)`, and **pg_trgm GIN** indexes for
  keyword/`ILIKE` search on `orders`, `concierge_actions`, and
  `concierge_messages.content` — without which keyword search is a full scan.

This makes the admin panel usable at scale and is the prerequisite for auditing
a large system. The blockers above (rate limiting, partitioning, counts) remain
as the next scaling work when volume actually demands it.
