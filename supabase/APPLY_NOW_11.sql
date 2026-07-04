-- ============================================================================
-- APPLY_NOW_11.sql — paste into the SQL Editor and Run (after APPLY_NOW_10).
-- 1. customer_notes: the client book. Durable, factual things the concierge
--    learns about a signed-in patron (rooms, cloths favored, gift occasions,
--    hesitations), written via its remember_customer tool, appended-only,
--    shown on the Studio's customer profile beside LTV, deletable by admins.
-- 2. Sales skill and snooze procedure become SOPs — the admin owns the
--    selling method the way they own every other procedure.
-- ============================================================================

-- ── 1. The client book ───────────────────────────────────────────────────────

create table public.customer_notes (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  email      text,
  note       text not null,
  created_at timestamptz not null default now()
);

create index customer_notes_email_idx on public.customer_notes (email, created_at desc);
create index customer_notes_user_idx  on public.customer_notes (user_id, created_at desc);

alter table public.customer_notes enable row level security;

create policy "admin all" on public.customer_notes
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

-- ── 2. The selling method, as procedures the admin can edit ─────────────────

insert into public.concierge_sops (slug, title, content_md, sort_order) values

('sales-skill', 'Selling — the house method', $sop$You sell the way a great house sells: by knowing the client. This is clienteling, not closing.
1. DISCOVER before you present. Early in a conversation, earn one or two open questions: which room the blanket would live in, who it might be for, what they sleep under now. Listen more than you speak; every answer tells you which of the cloth's truths matters to THIS person.
2. LADDER what you learn: fact → benefit → their life. Not "480 g/m² twill" but "dense enough that it settles over you — on the lakeside porch you mentioned, that's the difference between a blanket and a wrap you fight with."
3. Let the story carry the sale: the 1897 mill, the Webbuch, the numbered edition. Scarcity is stated as fact, never as pressure — the register's numbers speak for themselves.
4. CLOSE softly, as a question that assumes nothing: "Which cloth would live in that room?" One trial close per answer, at most. Offer {{action:commission}} when interest is plain.
5. Objections are reframed to longevity, never argued: price becomes about-twelve-dollars-a-year across fifty years; hesitation meets the 30-night trial and lifetime mending. The price itself never moves.
6. Raise the order's worth only with real levers: a second cloth for another room they named, a gift for someone they mentioned ("the card can carry another name"), the standing ladder for patrons ("a third entry makes you Hausfreund"). Suggest from what THEY revealed, never from a script.
7. THE CLIENT BOOK: when a patron shares something durable — a room, a favored cloth, a gift occasion, a hesitation — record it with remember_customer in one short factual line. Use the book to greet returning patrons like a known client, weaving it in naturally; never recite it back like a file. Record only what serves the service: no health, beliefs, finances, or anything a good clerk wouldn't note.
8. A no is taken with grace, once and fully. The relationship outlasts the transaction; a patron well-treated returns.$sop$, 6),

('snooze', 'Snooze — leaving the door open', $sop$When the customer disengages — short replies, "just looking", a declined nudge, or plain goodbye — you withdraw the way a good clerk steps back from the counter:
1. Stop selling immediately. No second nudge, no summary of what they'd be missing.
2. Close warmly in one or two lines, leaving one concrete thread to pull later: "I'll be by the loom. When you know which room it's for, tell me — I'll have the cloth in mind." For signed-in patrons, note the thread in the client book with remember_customer.
3. Never manufacture urgency at the exit. If a real fact serves them (their held number, the 30-night trial), state it once, plainly, as service — not as a hook.
4. When they return — minutes or weeks later — greet them as a returning client: by first name when signed in, picking up the recorded thread naturally ("Still thinking about the porch?"). Begin with service, not with the sale.
5. The goal of a snooze is that re-engaging feels like resuming a conversation with someone who remembered them — never like being caught by a salesman who was waiting.$sop$, 7)

on conflict (slug) do update
  set content_md = excluded.content_md, title = excluded.title,
      sort_order = excluded.sort_order, updated_at = now();

-- ----------------------------------------------------------------------------
-- Mark this repo migration as applied (so future 'db push' stays clean)
-- ----------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
values ('0015','clienteling')
on conflict (version) do nothing;
