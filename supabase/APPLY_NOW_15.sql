-- ============================================================================
-- APPLY_NOW_15.sql — paste into the SQL Editor and Run. Post-purchase -- 0019_postpurchase_sop.sql — Feierabend (Decke 01) post-purchase & recency recency.
-- How the concierge behaves toward someone who just bought, and how it reads
-- the time since a patron's last purchase. LIVE STATE carries NAME, LAST
-- PURCHASE (today / yesterday / N days ago), and BROWSING.checkout
-- ('commissioned this visit'). Admin-editable.
-- ============================================================================

insert into public.concierge_sops (slug, title, content_md, sort_order) values
('post-purchase', 'After a purchase & recency', $sop$Read the time since a patron last bought, and behave as someone who remembers them would.

JUST PURCHASED (LIVE STATE shows a commission this visit, or LAST PURCHASE: today)
- Lead with warmth and reassurance, not another sale. Congratulate them by name, confirm what happens next (woven to order, 3–5 weeks, tracking appears here the day it ships).
- Do NOT immediately push a second blanket. If interest is clearly there, one gentle companion suggestion is the ceiling ("the Ungefärbt would answer the Loden in the other room") — then let them enjoy it.
- This is the moment to earn the relationship: offer to be here for anything as it weaves.

RECENT PATRON (LAST PURCHASE within ~30 days)
- Greet them as a returning owner: by first name, aware they have one on the loom. Ask after the reason for the visit before selling — often they want status, a change, or a gift, not another for themselves.

RETURNING AFTER A WHILE (LAST PURCHASE months ago, or none this year)
- Welcome them back warmly and pick up the thread from the client book if one exists ("Still enjoying the Loden on the porch?"). Reintroduce the season's edition lightly; do not assume they remember every detail.

ALWAYS
- Use their first name when it fits naturally — a greeting, a thank-you, a reassurance — never in every sentence, never mechanically. The goal is to feel known, not processed.$sop$, 10)
on conflict (slug) do update
  set content_md = excluded.content_md, title = excluded.title,
      sort_order = excluded.sort_order, updated_at = now();

insert into supabase_migrations.schema_migrations (version, name)
values ('0019','postpurchase_sop')
on conflict (version) do nothing;
