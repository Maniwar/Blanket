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

## Gaps become knowledge — the drafting loop

The findings ledger (Knowledge → **Knowledge gaps**) fills with questions the
concierge could not answer — from live conversations (`knowledge_gap`), from
starters the bake pass refused to invent an answer for (`starter_bake`), and
from Draft-with-AI sections the knowledge couldn't support (`starter_gap`).
The **gap-draft pass** turns that ledger into knowledge work:

- **One model call per pass** clusters the open gaps into missing *topics* and
  gives each a merchant-facing title. Per cluster it answers one question:
  can the existing knowledge already answer this?
  - **Grounded** — the facts are already in enabled knowledge, just not
    findable as one entry: the model drafts content *restating those facts*
    and citing the `[slug]`s it used. Nothing new may be claimed.
  - **Needs your facts** — the house must supply the answer: the **server**
    (never the model) composes a deterministic fill-in draft — the visitors'
    own questions plus *"replace this line with the facts, then enable"*. An
    ungrounded draft is structurally incapable of containing an invented fact.
  - **Not knowledge** — junk and abuse are skipped, untouched.
- **Every draft is born disabled** (`origin='gap'` — the studio shows
  *"drafted from visitor questions"*). The gaps it covers are linked to it
  (`kb_slug`), and each gap row shows *"draft ready below."*
- **Enabling the draft clears its gaps** — eagerly when you press Save in the
  studio, and swept by the pass as the net. Because the flush trigger is
  enabled-aware, creating and editing *disabled* drafts never flushes the
  answer cache or stales the baked starters; the flush fires only when
  knowledge the model can actually see changes.
- **Auto-wired**: the hourly self-scheduled pass (atomic claim, one model
  call, 6 drafts max) plus the **Draft knowledge from gaps** button on the
  gaps card for right-now. Costs nothing when the ledger is empty.

The full circle: a starter the knowledge can't answer → filed as a gap → the
pass drafts the fill-in entry → the merchant adds the facts and enables → the
flush marks the related baked answers stale → the bake pass re-authors them →
the starter serves for zero calls. Every step is automatic except the one that
must be human: supplying the facts.

**Proof.** The **Gap probe** workflow (Actions → *Gap probe*) plants two QA
gaps, kicks the pass with a zero-cost tap, watches until both gaps are linked
to a disabled draft (and prints it), then enables the draft and asserts both
gaps clear — removing every row it created.

## Site watch — when the page changes and the knowledge doesn't

A storefront carries **three tiers of copy**, and the concierge can read exactly
one of them:

| tier | where it lives | can the bot see it? |
| --- | --- | --- |
| Hard-coded markup | `index.html` | **No** |
| The site editor | `site_content` (Studio → Site) | **No** |
| Knowledge sections | `concierge_kb` | **Yes — only this** |

That gap is the quiet failure mode of the whole design. Add a payment method to
the listing on Tuesday and the bot will still be answering Monday's question
with last quarter's facts on Friday — confidently, because nothing told it
otherwise. A page edit fires no event this server can hear.

**Site watch closes it by reading the rendered page.** Rendered, not the CMS:
hard-coded copy and editor copy are both HTML by the time a reader sees them, so
watching the output catches both tiers at once. It runs the diff, drafts a
knowledge entry for whatever moved, and stops.

### It drafts. It never publishes.

This is the load-bearing decision, and it is deliberate on two counts.

**Page copy is not knowledge.** Marketing prose is written to *move* someone;
a knowledge entry is written to *answer* someone. Auto-injecting page text into
the prompt would bloat every turn, repeat itself, and quietly duplicate the
curated KB with a persuasive variant of the same facts.

**A model that reads copy and writes "knowledge" is one bad inference from
inventing policy** — the same failure that once had the concierge treating a
shopper's passing worry as a standing requirement (see `BEHAVIOR.md` → the
client book writes no policy). So the drafting prompt is mostly prohibition:

- Write only what the page says. No fee, price, timeline, guarantee, policy,
  eligibility condition, or party's obligation that isn't in the copy.
- Never resolve an ambiguity by picking the likely answer.
- **Never import outside knowledge about a company the page happens to name.**
  If the page names a payment processor the model recognises, it still knows
  only what *this page* says about it.
- Where the copy leaves an obvious question open, end with a
  **`NOT STATED HERE:`** line naming the gaps. That line is the most valuable
  thing the pass writes: it tells the concierge the edge of its own knowledge,
  so it offers to find out instead of improvising past it.

### How the diff works

Section-granular, keyed off headings. A whole-page hash would tell you
"something changed" and nothing more — useless for drafting. Keys come from
**heading text, not position**, so inserting a section at the top doesn't
renumber everything below it and report the page as wholly rewritten. Nav,
header, footer and aside are dropped as chrome: a cart count and a copyright
year change on their own schedule and are never the answer to a question.

Three properties worth knowing, because each is a bug that would otherwise be
invisible:

- **First contact is a baseline, not news.** A page nobody has watched yet is
  learned as it stands and produces *no* drafts. Otherwise day one buries the
  reviewer under thirty proposals.
- **The draft row — not the snapshot — is the durable record of a change.**
  Snapshots advance in the same transaction that books the draft, never ahead of
  it. If the drafting call fails, the before/after is still on the books, a
  human can write the entry, and the next sweep retries. Advancing the snapshot
  first would swallow the change forever.
- **A page that can't be read is not a page with nothing on it.** A failed fetch
  reports the failure and leaves the capture untouched, so a bad gateway is
  never mistaken for a wiped site.

At most **one open draft per section**: a section edited twice before anyone
looks updates the open draft rather than stacking two overlapping proposals.
`old_text` stays pinned to what the reviewer last had reason to believe was
live, not the intermediate they never saw.

### What the drafter is shown, and how much

The drafter is handed the section's own text up to **8,000 characters**
(extraction keeps up to 12,000 per section), the previous text for an edit, and
nothing else — deliberately no other sections, so an entry cannot quietly
borrow a claim from elsewhere on the page. It is told that a section dense with
figures — comparable sales, prices, dates, mileages, lot numbers — is *data, not
prose*, and to keep every figure; "2–8 bullets" is the shape for ordinary copy,
not a cap. A pricing argument reduced to eight bullets has lost the argument,
and the concierge would then invent the comps it cannot see.

**None of these caps touch the chat path.** At answer time the concierge is
given the *whole* knowledge base, every SOP for its audience, and its tool list,
every turn — nothing is retrieved, nothing is truncated. The 996 listing's KB is
~26,000 characters today and ~42,000 with every pending draft published: under a
tenth of the model's context. See *Why it isn't RAG*, above.

### Renames, order, and verdicts

- **A renamed heading is not a removal.** Keys come from headings, so
  *"$20,407 Invested"* → *"$24,332 Invested"* changes key, and a key-based diff
  sees a removal plus an addition. Before calling anything removed, the diff
  looks for a new section whose text is mostly the same (`pg_trgm` similarity
  ≥ 0.5) and records the pair as **one changed section** under the new key,
  with the old text as its baseline. Without this the drafter proposed *"service
  documentation no longer offered"* for a section that had grown by $3,925.
- **Longest first.** The undrafted queue is ordered by content length, so the
  market argument is proposed before the photo captions.
- **Batches to a ceiling.** Eight sections per model call, up to forty per
  sweep — a rewrite of thirty sections lands in one *Check now*, not five.
- **A "nothing to teach" verdict sticks.** When the drafter judges a change
  cosmetic it records a title with no body. That draft is not re-sent on the
  next sweep, and cannot be published (the RPC refuses an empty entry); the
  studio shows the verdict and the reviewer dismisses it or writes the entry.

### Reviewing

Studio → **Knowledge → Site watch**. Each draft leads with the evidence (what
the page now says, with *what it said before* one click away) and keeps the
proposed entry editable — approving a draft you cannot correct is not review.

- **Publish to knowledge** writes a real, enabled `concierge_kb` row, which
  trips the cache-flush triggers, so stale cached answers on that topic are
  dropped in the same breath.
- **Not knowledge** dismisses it. That's a real answer, not a deferral: the
  section stays quiet until it changes *again*.
- A **removed** section leads with its old text and a warning. Knowledge still
  promising a withdrawn offer is the expensive kind of wrong, so the draft is
  framed as a correction.

### Running it

- **Check now** in the studio, any time.
- **Every six hours** via the *Site Watch Sweep* workflow — deliberately far
  slower than the alert sweep, because a page is edited a few times a year, not
  a few times an hour. Needs `ALERT_CRON_SECRET` in both Supabase and GitHub
  (the same purpose-built credential the support sweep uses — never the
  service-role key).
- Watched pages must be **public `https://`**. The sweep runs server-side with
  the service role in scope, so an inward-pointing URL would read what the
  internet cannot; loopback, private ranges and cloud metadata hosts are
  refused (`safeWatchUrl`, unit-tested).

Schema: `site_snapshots`, `site_kb_drafts`, and the RPCs `site_watch_record`,
`site_kb_drafts_list`, `approve_site_kb_draft`, `dismiss_site_kb_draft`,
`site_watch_status`. See `supabase/SCHEMA.md`.

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
- **Draft knowledge from gaps** (Knowledge → gaps card) turns unanswered
  visitor questions into KB drafts — grounded restatements or fill-in
  skeletons, never inventions; enabling a draft clears the gaps it covers.
- **Site watch** (Knowledge → Site watch) turns *page* edits into KB drafts —
  the other inbound queue: gaps are what a visitor asked and the bot couldn't
  answer, site watch is what the page says and the bot was never told.
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
