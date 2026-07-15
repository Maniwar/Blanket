# Model spend — the meter

Every model call the concierge makes is metered at the source and written to a
ledger, so "what does a conversation cost?" and "where did that spike come
from?" are answered by the system's own numbers — not by squinting at the
provider's daily bar chart.

## The ledger — `concierge_llm_usage`

One row per model call, written fire-and-forget by the edge function (the
meter **never** blocks or breaks serving; every failure path swallows):

| column | meaning |
| --- | --- |
| `purpose` | which job made the call — the full vocabulary is below |
| `model` | the model that actually answered (from the API response, not the request) |
| `input_tokens` / `output_tokens` | what the API reported for this call |
| `cache_read_tokens` / `cache_write_tokens` | prompt-cache traffic (priced differently) |
| `conversation_id` | set when the call belongs to a conversation (main replies, tool rounds) |
| `qa` | `true` when the session key starts with `qa-` — CI smoke and the eval deck |

Writes are service-role only (RLS with no policies), and admins read
**aggregates** via the RPC — never rows. Retention: `prune_high_write(p_days)`
deletes ledger rows past the cutoff along with the other high-write tables.

## The purpose vocabulary

Conversation-attributed (carry `conversation_id`):

- `chat` — the main streamed reply (usage captured from the SSE
  `message_start` / `message_delta` events)
- `chat-tools` — the non-streamed register tool rounds ("Consulting the
  register…"), up to 4 per turn

Session-flagged (QA detectable, no conversation row):

- `beat` — proactive beat lines (opener / nudge / outreach drafting)

Overhead (aggregate attribution only):

- `judge` / `coach` — the inline judge gate and the sales-coach grounding
- `nps-categorize` / `nps-report` — survey reason tagging; the analyst report
- `directives` / `clientbook` / `notes` / `goals` — house-note reconciliation,
  client-book consolidation, note writing, goal grading
- `starters` — admin "AI generate" conversation starters
- `eval-judge` / `lint` / `prompt-review` — the eval grader and the advisory
  honesty lint
- `reengage` — the return-visit bubble line

## The report — `llm_cost_metrics(p_days)`

Same guard as `nps_metrics` (concierge admin JWT or service role), aggregate
only. Returns per-purpose×model token totals with QA splits (including cache
splits), conversation-attributed totals by model, distinct customer/QA
conversation counts, and per-day buckets.

The admin surface is the **Model spend** card (Conversion tab):

- **Customer spend** — every non-QA call in the range, priced.
- **Per conversation** — customer spend on conversation-attributed calls ÷
  distinct customer conversations that made model calls in the range.
- **QA / dev spend** — `qa-` sessions only. The eval deck runs on **every
  deploy** (multi-turn persona simulations plus judge grading), so heavy
  shipping days spike HERE — this is the first place to look when the
  provider's daily chart jumps.
- Tokens-per-day chart (customer vs QA), a costliest-first purpose table, and
  the editable price table.

## Pricing — estimates, labeled as such

The ledger stores **tokens**; dollars are computed in the admin from an
editable per-model price table (defaults: haiku 1/5, sonnet 3/15, opus 5/25
$ per million in/out) stored in the browser (`cx_llm_prices`). Cache reads
are priced at 10% of the input rate and cache writes at 125% — the standard
prompt-caching shape. When provider prices change, edit the table; history
reprices instantly because only tokens are stored.

## Honesty notes

- The ledger begins at its ship date — **no historical backfill exists**, so
  the card cannot explain spend from before it shipped.
- Purposes without `conversation_id` are real cost but can't be pinned to one
  conversation; they appear in totals and the purpose table, not in the
  per-conversation figure. The per-conversation number is therefore a floor
  for "fully loaded" cost — the purpose table shows the rest.
- `qa` is keyed on the `qa-` session prefix; the judge/coach/housekeeping
  calls made *on behalf of* a QA conversation are not conversation-linked and
  so land in overhead — QA spend is likewise a floor, not a ceiling.
- A `beat` row is written even when the beat later holds or is vetoed — the
  drafting call was made and paid for either way.
