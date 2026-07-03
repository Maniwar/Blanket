-- ============================================================================
-- 0001_concierge.sql — Feierabend (Decke 01) AI sales concierge: schema + RLS + seed
-- Supabase project: kvkjxjdpqoqasiehdlcw (Postgres 17)
-- Safe to run once on a fresh project. The concierge edge function uses the
-- service role and bypasses RLS; no anon read policies exist on config/kb.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

-- Admin-tunable concierge settings (model, greeting, starters, ...)
create table public.concierge_config (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Knowledge base: one row per markdown section, served to the edge function
create table public.concierge_kb (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  title       text not null,
  content_md  text not null,
  sort_order  int not null default 0,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now()
);

-- Emails allowed into the concierge admin dashboard
create table public.concierge_admins (
  email text primary key
);

-- One row per chat session/thread
create table public.concierge_conversations (
  id          uuid primary key default gen_random_uuid(),
  session_key text not null,
  user_id     uuid references auth.users(id) on delete set null,
  user_email  text,
  section     text,
  created_at  timestamptz not null default now()
);

create index concierge_conversations_session_key_idx
  on public.concierge_conversations (session_key);
create index concierge_conversations_created_at_idx
  on public.concierge_conversations (created_at desc);

-- Chat transcript
create table public.concierge_messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.concierge_conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  content         text not null,
  model           text,
  latency_ms      int,
  created_at      timestamptz not null default now()
);

create index concierge_messages_conversation_id_idx
  on public.concierge_messages (conversation_id);

-- Thumbs up/down per assistant message
create table public.concierge_feedback (
  message_id  bigint primary key references public.concierge_messages(id) on delete cascade,
  rating      smallint not null check (rating in (-1, 1)),
  note        text,
  created_at  timestamptz not null default now()
);

-- Shop customers (mirrors auth.users)
create table public.customers (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  name        text,
  created_at  timestamptz not null default now()
);

-- Orders; the edge function also matches orders by email, so user_id may be null
create table public.orders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  email      text not null,
  serial     int unique not null,
  status     text not null check (status in ('placed','weaving','finishing','shipped','delivered','returned')),
  tracking   text,
  city       text,
  placed_at  timestamptz not null default now()
);

create index orders_email_idx on public.orders (email);
create index orders_user_id_idx on public.orders (user_id);

-- ----------------------------------------------------------------------------
-- 2. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

alter table public.concierge_config        enable row level security;
alter table public.concierge_kb            enable row level security;
alter table public.concierge_admins        enable row level security;
alter table public.concierge_conversations enable row level security;
alter table public.concierge_messages      enable row level security;
alter table public.concierge_feedback      enable row level security;
alter table public.customers               enable row level security;
alter table public.orders                  enable row level security;

-- Helper: is the current JWT's email in concierge_admins?
create or replace function public.is_concierge_admin() returns boolean language sql security definer stable as
$$ select exists(select 1 from public.concierge_admins a where a.email = coalesce(auth.jwt()->>'email','')) $$;

-- Admin-only tables: full access for concierge admins, nothing for anyone else
create policy "admin all" on public.concierge_config
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

create policy "admin all" on public.concierge_kb
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

create policy "admin all" on public.concierge_admins
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

create policy "admin all" on public.concierge_conversations
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

create policy "admin all" on public.concierge_messages
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

-- Feedback: admins manage everything; anyone may insert a rating.
-- The FK to concierge_messages enforces that the message exists.
create policy "admin all" on public.concierge_feedback
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

create policy "anyone can insert feedback" on public.concierge_feedback
  for insert to anon, authenticated
  with check (true);

-- Customers: users manage their own row; admins see all
create policy "select own customer row" on public.customers
  for select to authenticated
  using (id = auth.uid());

create policy "insert own customer row" on public.customers
  for insert to authenticated
  with check (id = auth.uid());

create policy "update own customer row" on public.customers
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "admin all" on public.customers
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

-- Orders: users see orders tied to their id or their JWT email; admins see all
create policy "select own orders" on public.orders
  for select to authenticated
  using (user_id = auth.uid() or email = coalesce(auth.jwt()->>'email',''));

create policy "admin all" on public.orders
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

-- ----------------------------------------------------------------------------
-- 3. SEED DATA
-- ----------------------------------------------------------------------------

-- 3.1 Admins ------------------------------------------------------------------

insert into public.concierge_admins (email) values
  ('mberenji@gmail.com');

-- 3.2 Config ------------------------------------------------------------------
-- 'starters' mirrors window.FEIER_KB.suggested in assets/concierge-kb.js.

insert into public.concierge_config (key, value) values
  ('enabled',    'true'::jsonb),
  ('model',      '"claude-sonnet-4-5"'::jsonb),
  ('max_tokens', '1024'::jsonb),
  ('greeting',   to_jsonb($cfg$Good evening from the Allgäu. I am the mill's concierge — ask me anything about the wool, the weave, or the number that will be yours.$cfg$::text)),
  ('voice_notes', '""'::jsonb),
  ('starters', '{
    "hero": [
      "What makes Decke 01 different?",
      "How much does it cost?",
      "What is it made of?"
    ],
    "why": [
      "Why only 15,000 a year?",
      "Who is Weberei Brandt?",
      "Is it worth $589?"
    ],
    "wool": [
      "Is the merino mulesing-free?",
      "Will it be too hot?",
      "How heavy is it?"
    ],
    "label": [
      "How do I wash it?",
      "Can it go in the dryer?",
      "What if it gets damaged?"
    ],
    "ritual": [
      "How is it packaged?",
      "Is it good as a gift?",
      "What is the beeswax seal?"
    ],
    "arrival": [
      "How long does delivery take?",
      "Are duties included?",
      "Does it ship in plastic?"
    ],
    "reserve": [
      "What does the 30-night trial cover?",
      "How do returns work?",
      "What is lifetime mending?"
    ],
    "default": [
      "What are the full specs?",
      "How does it compare to Pendleton?",
      "Which colorways are there?"
    ]
  }'::jsonb);

-- 3.3 Knowledge base ----------------------------------------------------------
-- One row per '## ' section of KB_MARKDOWN in supabase/functions/concierge/kb.ts,
-- bodies verbatim. Dollar-quoted to keep the markdown untouched.

insert into public.concierge_kb (slug, title, content_md, sort_order) values

('product', 'Product', $kb$Decke 01 is a premium German wool blanket, sold to American buyers at **$589 with duties and U.S. delivery included**. Size **55 × 79 in (140 × 200 cm)**, weight **3.1 lb (1.4 kg)**. The cloth is a dense **480 g/m² 2/2 twill**, teasel-raised for the nap. Woven to order; allow **3–5 weeks to your door**. Edition: **15,000 numbered blankets a year, never more**.$kb$, 1),

('materials', 'Materials', $kb$**80% mulesing-free merino, 20% GOTS organic cotton. Zero polyester** — no synthetic fiber anywhere in the blanket. Certified **OEKO-TEX Standard 100 Class I**, the infant-textile grade. The nap is raised with dried teasel heads, not steel, which is slower and gentler on the fiber.$kb$, 2),

('mill-provenance', 'Mill & provenance', $kb$Made by **Weberei Brandt**, a third-generation family mill in the **Allgäu, Bavaria, established 1897**. The looms weave **about four yards an hour**; the annual edition of 15,000 reflects that pace, not a marketing decision. The mill's hand-kept weave register — the **Webbuch** — has recorded every bolt since 1897.$kb$, 3),

('care', 'Care', $kb$- **Cold wool cycle, 86°F (30°C)**, wool-safe detergent
- **Line dry** — never tumble dry
- **Wash it less than you think**; wool self-cleans, and airing out handles most everyday use
- Plant-dyed or undyed cloth dislikes hot water and harsh detergent; avoid both$kb$, 4),

('shipping-duties', 'Shipping & duties', $kb$Every blanket is **woven to order — allow 3–5 weeks to your door**. **Duties and U.S. delivery are included** in the $589; nothing is owed on arrival. It ships wrapped in **cotton twill, never plastic**. Order-specific matters (tracking, addresses, holds) are handled by hello@feierabend.example.$kb$, 5),

('trial-returns', 'Trial & returns', $kb$A **30-night trial**: sleep under it, and if it is not right, return it **clean** within 30 nights for a **full refund**. Returned blankets are inspected at the mill.$kb$, 6),

('lifetime-mending', 'Lifetime mending', $kb$Decke 01 is **mended by the mill for life**. Holes, pulled threads, moth damage — send it to Weberei Brandt and it is repaired on the looms that made it. The serial number identifies the exact cloth, dye lot, and weaver. Heirloom positioning: **a blanket like this isn't replaced, it's inherited.**$kb$, 7),

('edition-weave-register', 'Edition & weave register', $kb$Each blanket is **numbered on the selvedge** and entered by hand in the **Webbuch**, kept since 1897. The owner receives a heavy **register card** carrying the number, the owner's name, and the weaver's initials. 15,000 per year is the ceiling, set by loom speed.$kb$, 8),

('packaging', 'Packaging', $kb$- **Forest-green rigid box**, made to be kept
- Blanket wrapped in **unbleached cotton twill, tied by hand** — no tape
- **Beeswax seal** pressed with the 1897 stamp
- Heavy **register card** with number, name, and weaver's initials
- No plastic at any stage; as a gift it needs no further wrapping$kb$, 9),

('colorways', 'Colorways', $kb$Undyed or plant-dyed only — no synthetic dyes, ever.
- **Ungefärbt** — undyed fleece
- **Loden** — deep green from alder-bark dye
- **Graphit** — soft charcoal from walnut-hull dye$kb$, 10),

('comparisons', 'Comparisons', $kb$Fair and specific; never disparage.

| | Price | Material | Weight | Guarantee |
| --- | --- | --- | --- | --- |
| **Decke 01** | $589 | 80% mulesing-free merino, 20% GOTS cotton, zero polyester | 3.1 lb | 30-night trial, mended for life |
| Pendleton | ~$300 | Wool blends, coarser hand, US-made | varies | standard warranty |
| Weighted blanket | ~$100–300 | Polyester shell, ~20 lb glass beads | ~20 lb | varies |
| Cashmere throw | $500–2,000 | Cashmere; softer but fragile, pills, dry-clean | ~1–2 lb | rarely any |

Notes: Pendleton is a fine brand with real heritage. Weighted blankets work via deep-pressure stimulation but run hot; Decke 01 gives a calming, even weight at 3.1 lb without the heat. Cashmere is softer but fragile. Hermès and Loro Piana throws ($1,500–6,000) are exquisite at 3–10× the price. Decke 01's position: **German mill provenance + zero synthetic + lifetime mend + numbered edition at $589**.$kb$, 11),

('value', 'Value', $kb$Built for the fifty years it takes to be inherited, Decke 01 works out to **about twelve dollars a year**. The 30-night trial and lifetime mending carry the risk; the buyer carries the blanket.$kb$, 12);

-- 3.4 Demo order --------------------------------------------------------------
-- user_id stays null; the edge function also matches orders by email.
