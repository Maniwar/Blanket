# Model cost & efficiency

Where the concierge spends Claude tokens, and the levers that keep it cheap. All
model work runs through the **concierge** edge function; the commission function
makes no model calls.

## Every Claude call, and when it fires

| Call | Trigger | Notes |
| --- | --- | --- |
| **Signed-in chat** (agentic loop) | each message from a signed-in visitor | **up to 4 calls per message** — it loops to run tools (get_my_orders → answer, etc.). A no-tool reply is 1 round. |
| **Anonymous chat** | each message when signed out | 1 call — **or 0** on a semantic-cache hit (see below). |
| **Proactive nudge / opener** | an idle in-panel nudge, or the greeting spoken on panel open | 1 call each. Capped per conversation by the outreach budget. |
| **Re-engagement line** (`?reengage`) | each time the closed-panel bubble fires | 1 call (~120 tok). Has a client-side fallback line, so it can be skipped. |
| **Goal grading** (`scheduleGoalEval`) | after a turn, sampled by `goal_sample_rate` | +1 call (~500 tok). `goal_sample_rate` 1.0 = every turn; lower to cut. |
| **Wrap-up note** | signed-in visitor leaves, real exchange happened | 1 small call (~90 tok) to write a client-book line. |

## The levers (in place)

### 1. Prompt caching — the big one
Every call used to re-send the whole system prompt (brand voice + **full KB** +
tool definitions + SOPs + hooks/objections + tuning) as fresh input — several
thousand tokens, and the dominant cost given how many calls there are.

`buildSystemPrompt` now returns **`{ prefix, suffix }`**:
- **`prefix`** — everything static (brand, KB, tool guidance, SOPs, selling
  angles, objections, assertiveness, admin tuning notes). Sent as a
  `cache_control: { type: "ephemeral" }` content block.
- **`suffix`** — everything dynamic (LIVE STATE = browsing context + the
  customer's orders/standing, plus the per-conversation goal agenda). A second,
  uncached block, so it never busts the cached prefix.

Because the **tools array precedes `system`** in Claude's cache order, the
signed-in tool definitions are cached under the same breakpoint. Result: any call
that reuses the prefix within the **5-minute cache TTL** — the 2nd–4th agentic
rounds of one message, nudges, back-to-back turns — pays **~10%** of that input
instead of 100%. Realistically a 70–90% cut on input tokens.

Implementation notes: live state was moved out of `BRAND_SYSTEM` (kb.ts) to the
dynamic tail so the prefix is stable; the three chat call sites send `system` as a
two-block array and carry the `anthropic-beta: prompt-caching-2024-07-31` header.

### 2. Semantic answer cache (anonymous)
Anonymous, single-turn questions are embedded (gte-small, local — **not** a Claude
call) and matched against `concierge_cache`. A hit returns the stored answer with
**zero** model calls. Skipped for anything about live/personal state.

### 3. `goal_sample_rate`
Admin-tunable (Tuning → Engagement pace). At `1.0` the grader runs on every
eligible turn; drop to ~`0.2` to grade 1 in 5 — analytics stay representative and
a whole class of calls falls away. No deploy.

### 4. Trimmed CUSTOMER block
The signed-in LIVE STATE tail (uncached, re-sent every turn) used to list **every**
order inline — ~600–700 tokens on a heavy account, for data the prompt tells the
bot to ignore in favour of `get_my_orders`. Now: ≤3 orders still list inline
(cheap, natural greeting); **>3 collapse to a cloth tally + the two most recent**,
with an explicit "call `get_my_orders` for the full list." Cheaper per turn, and
one authoritative order source (which also prevents miscounts).

### 5. Config cache
`concierge_config`/KB/SOPs/tools are read once and held in module memory for 60s,
so the prompt is assembled from memory, not a DB round-trip, on most calls. (This
also keeps the cached prefix identical for the TTL.)

## Backlog (deliberately deferred)

These are held back on purpose: each trades some **quality** for cost, and with
prompt caching already doing the heavy lifting, the tradeoff isn't worth it yet.
Revisit if spend becomes a concern at scale.

- **Template the re-engagement line** — the client already has a solid fallback;
  skip the `?reengage` model call entirely, or only use the model at higher
  assertiveness.
- **Trim `get_my_orders`** — a patron with many orders makes a large JSON that is
  re-sent each agentic round; return a leaner shape.
- **Cap agentic rounds** lower than 4 if the 4th is rarely reached.
- **Cache the grader prompt** — the goal-grading system prompt is static and could
  take its own cache breakpoint.

## Rough cost intuition

For a signed-in order question (~3 agentic rounds) the system prefix is the bulk
of input. Uncached that's ~3× the full prompt; with caching it's ~1 write + 2
hits ≈ 1.2× — and across a conversation's many turns/nudges within the TTL, the
prefix is written once and hit thereafter. Output tokens (the reply itself) are
unaffected by caching, so keep `max_tokens` sane and lean on the semantic cache
and `goal_sample_rate` for the rest.
