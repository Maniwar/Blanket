# Backlog

Known future work, prioritized. None of it is needed for the demo today — the
scaling *blockers* are done (see [SCALING.md](SCALING.md) #1–#4). This is the
"we know exactly what to do when it's needed" list. Fuller detail lives in
[SCALING.md](SCALING.md) and [DESIGN.md](DESIGN.md) §8–§9.

## Scalability — do when volume demands it

- **[P1] Collapse per-request query fan-out (SCALING #5).** Fold `customerBlock`'s
  ~3 sequential reads into one `security definer` RPC bundle; keep PostgREST on
  the pooler. *Payoff:* lower per-message latency, fewer held DB connections under
  concurrency. *Effort:* moderate. *Trigger:* hundreds+ of concurrent signed-in
  chats.
- **[Later] Monthly range partitioning (SCALING #2, further step).** Retention
  already bounds the high-write tables via `prune_high_write`. For true web-scale,
  convert `concierge_messages`/`concierge_actions` to monthly range partitions so
  retention is an instant `drop partition` (no delete bloat) and scans prune by
  partition. *Effort:* high (data-migrating). *Trigger:* billions of rows / delete
  bloat from retention becomes visible.
- **[Watch — no code] Cost & quotas (SCALING #8).** Right-size the Supabase plan,
  request Anthropic rate-limit increases, verify a Resend domain for volume. The
  semantic cache (built) is the main code-side lever.
- **[Skip unless repurposed] Serial-allocation contention (SCALING #6).** The
  single-row `FOR UPDATE` is correct for a 15,000-piece scarce edition; only
  matters if the engine is reused for a high-volume, non-scarce product.

## Product / features

- **Configurable colorways per run.** Currently hardcoded (`ungefaerbt/loden/
  graphit`) across ~13 places incl. a DB `CHECK`. Make them admin-editable
  (name/description/swatch), replacing the constraint, wired through checkout,
  the concierge, and validation. (Deferred by choice; storefront card art would
  also need per-colorway images.)
- **Demo auto-progression of fulfillment (DESIGN §8).** A timed job that advances
  orders through `placed → … → shipped` on their own, so the edition visibly moves
  without an admin acting.
- **Scheduled idle-close job (DESIGN §9).** A server-side sweep that ends
  conversations idle for N hours, so leave-detection doesn't depend on the
  best-effort `pagehide`/`visibilitychange` beacon.

## Quality — inherent limitations (DESIGN §9)

- **Multi-judge goal scoring.** Goal scoring and client-book summaries are single
  async LLM calls; an adversarial / multi-judge pass would raise confidence.
- **Auto cache invalidation.** Stale semantic-cache answers aren't auto-evicted
  when the knowledge changes; an admin clears them. Tie eviction to KB/SOP edits.
