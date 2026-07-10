# How the knowledge base & SOPs work (and why it isn't RAG)

This is the concierge's single source of "what does the bot know, and how does
it come to know it each turn." Short version: **the curated knowledge base and
the relevant procedures are injected whole into the system prompt every turn.**
There is no vector search over the knowledge base. The only place embeddings
appear is a *cache* for repeated answers — not retrieval.

See the [prompt-assembly diagram](docs/prompt-assembly.svg) for the picture, and
`DESIGN.md` §2.9 (prompt architecture), §4.3 (the two caches), §4.10 (the client
book) for the fuller treatment. This page is the "how the KB works" summary.

## Where the knowledge lives

| what | stored as | edited in |
| --- | --- | --- |
| **Knowledge base** (the facts the bot may state) | `concierge_kb` rows (markdown) — with a code fallback `KB_MARKDOWN` in `kb.ts` for a fresh install | Studio → **Knowledge** |
| **SOPs** (procedures — how to handle a situation) | `concierge_sops` rows, each carrying an **audience** (`all` · `signed_in` · `anon`) | Studio → **Procedures** |
| **The constitution** (identity, objective, voice, honesty rules) | `BRAND_SYSTEM` in `kb.ts`, editable base + override | Studio → Tuning |
| **Selling method, engagement, goals** | `concierge_config` / `concierge_goals` rows | Studio → Selling / Goals |

Everything is **data**, versioned in `concierge_edit_history`, and an edit
**flushes the answer cache** so a stale answer is never served after a policy
change.

## How it reaches the model, each turn

`assemblePromptSections()` in `index.ts` builds one ordered prompt:

1. A small always-on **CORE constitution** (`BRAND_SYSTEM`): identity, the
   `{{OBJECTIVE}}`, voice, the display-token contract, and the honesty/scope
   rules that never bend. It carries a **precedence block** — *facts →
   KNOWLEDGE, tasks → the matching SOP, live facts → LIVE STATE* — so every rule
   has exactly one owner and the tie-break order is explicit.
2. The **`{{KB}}` block** — the knowledge base, injected in full.
3. A handful of **named sections**, each the single owner of its concern:
   Recognition & client book, Register desk (signed-in only), Selling,
   Engagement & pacing, and the **SOPs** for this audience.
4. A dynamic **LIVE STATE + goal** suffix (stock, the customer's own record) —
   the only part that is never cached.

The admin can see this exact assembly live via Tuning → **"See the assembled
prompt"** (`?preview=1`). What the model is fed is auditable to the byte.

## Why it isn't RAG

RAG (retrieval-augmented generation) embeds a large corpus, and at query time
retrieves the *few* chunks it guesses are relevant and puts only those in the
prompt. That's the right tool when the corpus is too big to fit in context. Here
it would be the wrong tool, for four reasons:

1. **The catalog is bounded.** One considered product (a blanket; a car). The
   entire curated KB fits comfortably in the context window, so there is nothing
   to *retrieve from* — you just include all of it. Retrieval only adds a step
   that can fail.
2. **Retrieval misses are silent and expensive.** In RAG, if the relevant chunk
   isn't in the top-k, the model answers without it — confidently, and wrong, or
   with an "I don't know" for a fact that was right there. For a sales concierge
   whose entire premise is *honest, on-the-record answers*, a retrieval miss is
   exactly the failure you can't tolerate. Full injection has no top-k to miss.
3. **Auditability and honesty.** Every fact the bot can state is curated, sits in
   one place, and is visible in the assembled prompt. The honesty lint checks
   that KB claims trace to a source; the bot is told, by the constitution, to
   answer *only* from KNOWLEDGE. A vector store pulling probabilistic chunks
   makes "what can it say, and why?" much harder to reason about.
4. **The cost RAG saves is already handled** — by two caches (below), not by
   trimming the prompt.

So: not RAG, by design. The lever RAG pulls (shrink the prompt via retrieval)
buys us nothing at this scale and costs us the guarantee we care about most.

## The one place embeddings *are* used — and it's a cache, not retrieval

The **semantic answer cache** (`concierge_cache`, pgvector) stores whole
finished *answers*, keyed by a question's meaning:

- On an eligible turn (anonymous, one user turn, ≤300 chars, not a live/personal
  ask), the question is embedded locally with **gte-small** (384-dim, via
  `Supabase.ai.Session` — *not* a model call).
- `match_cached_answer` returns the nearest stored answer above a **0.90** cosine
  threshold; a hit streams back with **zero** model calls.
- On a miss the model answers normally; if the answer is state-free it's written
  back for the next asker. A polarity guard keeps "is it X? — no" from ever
  matching "is it X? — yes."

This is caching (skip the whole call on a repeat) — it never chooses *what
knowledge the model sees*. The KB is still injected in full on every miss.

## The one retrieval-shaped thing — per-customer memory

The product KB is fully injected; **per-customer memory** is not. The client book
injects a rolling summary plus the newest notes, and older detail is reachable
on demand through a **`recall_context`** tool the model can call. That's the only
retrieval-shaped mechanism, and it's about *who the customer is*, never about the
product facts. See `DESIGN.md` §4.10.

## Managing it

- **Edit** in the Studio (Knowledge, Procedures, Selling, Goals). Everything is
  data; no deploy needed to change what the bot knows or how it behaves.
- **Version history** on every base field and row (`concierge_edit_history`),
  one-click revertible.
- **Honesty lint** (`?lint=1`) runs on prompt-text saves — a KB claim with no
  supporting source is flagged.
- **Cache flush** fires automatically on KB/config/SOP edits, so a changed policy
  is never served from an old cached answer.
- **See the assembled prompt** (`?preview=1`) and **ask the prompt tuner**
  (`?promptreview=1`) to inspect and improve the result.

## When you *would* reach for RAG

If the engine were ever pointed at a genuinely large, open-ended corpus — a
multi-hundred-product catalog, a documentation site, a support knowledge base too
big to fit in context — then retrieval becomes the right tool, and it would slot
in *ahead of* the `{{KB}}` block (retrieve the relevant rows, inject those). The
architecture leaves room for it; today's single-product scope simply doesn't need
it. See `SCALING.md`.
