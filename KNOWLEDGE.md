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
finished *answers*, keyed by a question's meaning. (Its exact-match sibling —
**baked starter answers**, pinned rows served without even the embedding call —
has its own section below.)

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

## Conversation starters — hand-written or drafted from the KB

The tappable opening questions in the widget (per page section, plus a `default`
fallback trio) live in `concierge_config.starters` and are edited in Studio →
Tuning → **Conversation starters**. A freshly-adopted site ships these blank or
generic, because the stamp can retarget the *section keys* but can't write good
per-section starter *copy*.

**Draft with AI** (the `✳` button on that panel) fixes that in one click:

- The studio POSTs the section keys to `?genstarters=1` (admin-only); the server
  reads the **live knowledge base** and the house voice and drafts a few short,
  tappable shopper questions per section — grounded *only* in what the KB says
  (it is told never to reference a spec, price, or feature the KB doesn't
  contain, same honesty rule as everything else here).
- It fills **only empty** input slots, so anything you already typed is
  preserved. Nothing is saved automatically — you review, edit, and press **Save
  starters**. The human stays in the loop.

It's the same pattern as the prompt tuner (`?promptreview=1`) and the honesty
lint (`?lint=1`): an admin-only, KB-grounded helper that proposes, never commits.

## Baked starter answers — a tap never spends a model call

Starters are the most-tapped inputs on the page, and the house knows in advance
exactly what they say — so their answers are **pre-authored** ("baked") and
served without a model call *or* an embedding call. The bake happens once, at
setup time; the taps are free forever after.

**Serving.** A baked answer is a **pinned** row in `concierge_cache`
(`pinned=true`), exact-matched by `norm_key` — the question lower-cased,
whitespace collapsed, trailing `?.!…` dropped (`normalizeQuestionKey` in
`beats.ts`, the one shared normalizer every writer and reader calls). The match
runs *ahead of* the semantic cache, on **any** turn for **any** visitor
(signed-in included — baked answers are grounded in house knowledge only, never
in a register), and streams with the cache marker, logged as `model='baked'`.
A tap or a retyped copy of the same starter lands on the same row.

**Baking.** One setup-time model call per starter authors its reply from the
**live knowledge base only** — the same honesty rule as everything else:

- The judge answers with a verdict: **ok** (bake it), **live** (a correct
  answer needs live state — availability, remaining counts, a patron's own
  orders — so the tap stays a real model call by design), or **ungroundable**
  (the knowledge can't answer its own starter — filed to the findings ledger
  as a `starter_bake` flag: *add the facts to Knowledge, or reword the
  starter*; never invented).
- Every baked answer names the KB entry that grounds it (`kb_slug`); when the
  facts exist but no single entry holds them, the bake **drafts one** (capped),
  so each answer stays traceable to knowledge the merchant can edit.

**Auto-wiring.** Saving the starters card fires the bake; the **Bake starter
answers** button (Studio → Saved answers) runs it on demand; and an hourly
self-scheduler catches anything left (the pass is capped at 8 model calls, so a
long list finishes over a few passes). Adding a starter is enough — no other
setup.

**Knowledge edits re-bake, never orphan.** The cache flush that fires on
KB/config/SOP edits deletes *learned* rows but only marks pinned rows
**stale** — a starter tap keeps serving the last good answer until the next
pass re-bakes it from the updated knowledge. A merchant who edits a baked
answer by hand marks it `hand_edited` ("your wording"), and the auto-bake never
overwrites it.

**Proof.** The **Starter probe** workflow (Actions → *Starter probe*) is the
definitive live test: it plants a pinned row, taps it over the real wire, and
asserts the streamed reply is **byte-identical** to the stored answer with
**zero** rows in `concierge_llm_usage` for that conversation — then watches the
real starters until every one is pinned or accounted for (live /
needs-knowledge / queued), and deletes everything it created.

## Managing it

- **Edit** in the Studio (Knowledge, Procedures, Selling, Goals). Everything is
  data; no deploy needed to change what the bot knows or how it behaves.
- **Draft starters** from the KB (Tuning → Conversation starters → *Draft with
  AI*) — grounded in the live knowledge base, fills only blank slots, review then
  Save.
- **Version history** on every base field and row (`concierge_edit_history`),
  one-click revertible.
- **Honesty lint** (`?lint=1`) runs on prompt-text saves — a KB claim with no
  supporting source is flagged.
- **Cache flush** fires automatically on KB/config/SOP edits, so a changed policy
  is never served from an old cached answer. Learned rows flush clean; baked
  starter answers survive as **stale** and re-bake within the hour.
- **See the assembled prompt** (`?preview=1`) and **ask the prompt tuner**
  (`?promptreview=1`) to inspect and improve the result.

## When you *would* reach for RAG

If the engine were ever pointed at a genuinely large, open-ended corpus — a
multi-hundred-product catalog, a documentation site, a support knowledge base too
big to fit in context — then retrieval becomes the right tool, and it would slot
in *ahead of* the `{{KB}}` block (retrieve the relevant rows, inject those). The
architecture leaves room for it; today's single-product scope simply doesn't need
it. See `SCALING.md`.
