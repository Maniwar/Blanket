# Upsell & cross-sell — companion pieces

How Feierabend raises the order's worth with **companion pieces** the concierge
can sell alongside the numbered cloth — before the order is signed (pre-order)
and after (post-order) — and how the **Conversion** tab measures the lift in
average order value (AOV) the concierge drives. Written for the merchant first,
engineers second.

The register sells one blanket at a time. Companion pieces are the *only*
multi-item surface in the demo: small, true add-ons — a care kit, a matching
cushion, a lap-sized mini — that a shopper can add in one tap. They exist to
demonstrate three things: the concierge can **recommend** the right companion,
the register can **take the order** for it, and the dashboard can **prove** the
AOV impact and **attribute** it to the concierge.

---

## The catalog — one source of truth

Every surface reads the SAME catalog, so a price or a name can never drift
between what the concierge says, what the register charges, and what the
dashboard reports.

- **Definition:** `ADDONS_DEFAULT` in `supabase/functions/concierge/index.ts` —
  an array of `{ slug, name, price_cents, variants, phase, blurb }`. This is the
  single source of truth. Feierabend ships three demo pieces:

  | Slug | Name | Price | Variants | Phase |
  | --- | --- | --- | --- | --- |
  | `care-kit` | Wool Care Kit | $48 | no | both |
  | `kissen` | Matching Wool Cushion | $168 | yes (the cloth's colorway) | both |
  | `decke-mini` | Lap Decke Mini | $268 | yes | both |

  - `variants: true` → the piece is made to match the cloth's chosen colorway.
  - `phase` — `pre` (offer before signing), `post` (after), or `both`.
  - `blurb` — one true sensory line the concierge leans on; it is the grounding.

- **Override without a redeploy:** a brand may set `config.commerce.addons`
  (same shape) to replace the built-in default. `addonCatalog(data)` validates,
  de-dupes by slug, clamps every field, and caps the list at **24** items, so a
  bad config can never bloat the prompt or a payload.

- **Endpoints (public):**
  - `GET ?catalog=1` → `{ addons: [...] }` with a display `price` string. The
    commission server reads this to re-price every line.
  - `GET ?config=1` also carries `addons` (so the widget + register share one
    bootstrap) and `unit_price_cents` (the base price for the running total).

---

## How the concierge sells them

The engine adds a **COMPANION PIECES** block to the SELLING section (only when a
catalog exists — a brand with no add-ons never sees it). It grounds the
concierge on the real items and prices and gives the universal method:

> Earn the primary sale first. Then, when the shopper is warm, offer **one**
> fitting companion — a gift alongside their own, a second room, the care of
> what they're buying — never a pile-on, never instead of the close.

To offer one, the concierge puts an **`{{addon:<slug>}}`** token on its own line
(e.g. `{{addon:care-kit}}`). This is a first-class widget control, registered in
`beats.ts` (`WIDGET_TOKENS`), so the reach-out judge treats it as a real button,
not a plumbing leak — see [`JUDGE.md`](JUDGE.md).

In the chat, the token renders as a **“＋ Wool Care Kit · $48”** pill. Tapping it:

1. records the concierge's recommendation (`sessionStorage['cx-addons']`),
2. stamps the concierge-attribution marker (as the commission button does), and
3. opens the register with that piece **pre-selected**.

Because the tap came from the concierge's own recommendation, that line is
attributed **`concierge`** — the number the merchant optimizes on.

---

## The register — pre-order

In the review act, the register lists the companion pieces as toggles with a
**running total** (`the cloth $589 + Wool Care Kit $48 → total $637`). Pieces the
concierge recommended arrive **pre-selected** and marked *recommended*; a piece
the shopper toggles on themselves is attributed **`customer`**. The base price is
the configured `unit_price_cents` (with a $589 fallback), so the total is right
even if the merchant changes the price.

Selected lines ride the commission payload; the server **re-prices** each against
the catalog (never trusting a client price), so the AOV the dashboard reports
can't be inflated by a tampered request.

## The register — post-order

After the register card is signed, the card offers the remaining companion
pieces. Adding one takes a single tap — no second checkout — via the commission
`POST ?addon=1` endpoint → `add_order_addon`. These register-surface adds are
attributed **`page`**.

---

## Attribution — the `added_by` axis

Every companion line records who put it on the order. This is the axis the AOV
card reports on:

| `added_by` | Meaning | Source |
| --- | --- | --- |
| **`concierge`** | The concierge recommended it and the shopper took it — a causal upsell | The `{{addon:…}}` pill in chat |
| **`customer`** | The shopper toggled it on themselves in the register | Register toggle, pre-order |
| **`page`** | A page / register surface offered it, post-purchase | The register card's post-order offer |

This is a **separate** axis from the order-level tiers in
[`ATTRIBUTION.md`](ATTRIBUTION.md) (which credit the *whole order* to the chat).
`added_by` credits an individual *line*.

---

## Persistence

- **`order_addons`** — one line per companion piece per order: `order_id` (FK,
  cascade), `addon_slug`, a snapshotted `name` + `price_cents` (the shelf price at
  purchase, immune to later catalog edits), `colorway`, `qty`, `added_by`,
  `added_at`. A **unique `(order_id, addon_slug)`** index means one row per piece
  per order — a double-tap or a retried request can never duplicate a line and
  inflate the numbers. RLS: admin-read + owner-read-own; writes are service-role
  only. See [`SCHEMA.md`](supabase/SCHEMA.md).

- **`commission_order(..., p_addons jsonb)`** — companion lines enter in the
  **same transaction** as the order. The payload is de-duped by slug (qty summed,
  `concierge` wins the attribution if any line claims it) and upserted, so a
  malformed or duplicated line never fails the placement — the cloth still enters
  the register.

- **`add_order_addon(...)`** — the post-order path, **idempotent**: re-adding a
  piece already on the order is a no-op that returns the existing line.

---

## The dashboard — AOV impact

The **Conversion** tab's **Upsell & AOV** card (fed by the `addon_metrics(p_days)`
RPC, matched to the tab's window) shows:

- **Attach rate** — orders with a companion ÷ kept orders.
- **Add-on revenue** — total, and units.
- **Concierge-driven** — the revenue attributed `concierge`, and its share of
  all add-on revenue. *This is the bot's upsell performance.*
- **AOV** — average order value with add-ons folded in, and the **lift %** vs the
  base cloth price.
- **By companion piece** — units, revenue, and the concierge's share per item.
- **Top orders by add-on spend** — the per-customer view: which orders the bot
  lifted most.

`addon_metrics` is admin-only, aggregates over `order_addons`, and counts kept
(non-cancelled) orders only. It is brand-neutral (no colorway reference), so it
vendors into the kit unchanged.

---

## Robustness

- **No double-counting.** The unique index + de-duping `commission_order` +
  idempotent `add_order_addon` guarantee one row per piece per order. *Verified
  live: a duplicated `care-kit` collapses to one line at qty 2; a double
  post-order add stays one line at qty 1.*
- **Catalog resilience.** The commission server caches the catalog in-process
  (60 s TTL); a transient `?catalog=1` blip serves the last good copy instead of
  silently dropping a concierge-driven upsell. The register's `loadCatalog`
  re-checks the widget's published catalog on every open and only latches on
  success, so a late config or a failed early fetch recovers.
- **Price integrity.** The server always re-prices lines from the catalog; the
  client never sets a price the server trusts.
- **Bounds.** A config override is capped, slug-deduped, and field-clamped.

---

## Multi-brand (the kit)

The add-on *machinery* is universal; the *catalog* is brand content. The kit's
stamp neutralizes `ADDONS_DEFAULT` to `[]` for a stamped brand (the COMPANION
PIECES block and the register section then render nothing), so the universal
engine ships no catalog and each brand supplies its own via
`config.commerce.addons` or a re-stamp. `order_addons`, the RPCs, and
`addon_metrics` are brand-neutral and vendor unchanged; the `order_addons`
`colorway` column renames to the brand's variant field in lockstep with
`orders.colorway`. The Porsche variant (`porsche996turbo`) carries the machinery
with an **empty** catalog — it sells one car through offer/viewing forms and has
no orderable register — so the surface exists for parity and reports zeros.

---

## Files

| Concern | Where |
| --- | --- |
| Catalog + selling block + endpoints | `supabase/functions/concierge/index.ts` |
| `{{addon}}` token registry | `supabase/functions/concierge/beats.ts` |
| Schema, RPCs, metrics | `supabase/setup.sql` (`order_addons`, `commission_order`, `add_order_addon`, `addon_metrics`) |
| `?addon=1` + catalog re-pricing | `supabase/functions/commission/index.ts` |
| Chat pill | `assets/concierge.js` |
| Register toggles + post-order offer | `assets/checkout.js` |
| Upsell & AOV card | `admin.html` (Conversion tab) |
