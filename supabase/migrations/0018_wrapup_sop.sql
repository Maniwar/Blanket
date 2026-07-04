-- ============================================================================
-- 0018_wrapup_sop.sql — Feierabend (Decke 01) conversation wrap-up
-- Every conversation ends the way a good clerk ends one: a check that the
-- customer's needs are met, and — for a signed-in patron — a note in the
-- client book so the next conversation begins from memory. Admin-editable.
-- ============================================================================

insert into public.concierge_sops (slug, title, content_md, sort_order) values
('wrap-up', 'Wrapping up a conversation', $sop$Close every conversation with care, the way a good clerk sees a customer to the door.

CHECK THEIR NEEDS ARE MET
- Before you let a conversation rest, make sure nothing is left hanging. If a question was answered, ask lightly whether that settled it or whether anything else is on their mind ({{reply:That's everything}} / {{reply:One more thing}} where it fits).
- If they were mid-decision (a cloth, a room, a gift), offer the natural next step once; if they were mid-task (an order change, checkout), confirm it completed.

LEAVE A NOTE IN THE CLIENT BOOK
- For a SIGNED-IN patron, before the conversation winds down — when they say goodbye, go quiet on your final follow-up, or complete a commission — call remember_customer with ONE durable, factual line capturing what you learned this visit: the room, the person they're buying for, the cloth they favored, a hesitation, a thread to pick up next time. One clerk-worthy line; nothing sensitive.
- Do not record a note for anonymous shoppers (there is no one to remember) and do not note trivial or one-off exchanges — only what would help serve them better next time.
- If nothing durable was learned, that is fine — do not invent a note.

Then rest. The next conversation should feel like it resumes a relationship, not restarts one.$sop$, 9)
on conflict (slug) do update
  set content_md = excluded.content_md, title = excluded.title,
      sort_order = excluded.sort_order, updated_at = now();
