-- ============================================================================
-- 0016_greeting_pills.sql — Feierabend (Decke 01) opening question
-- A human sales rep opens with a question, not a menu. The concierge's
-- greeting now ends with tappable discovery pills so the very first move is
-- the shopper telling us who the blanket is for — the start of clienteling.
-- Admin-editable in the Studio's Tuning tab like any greeting.
-- ============================================================================

update public.concierge_config
   set value = to_jsonb($greet$Good evening — I am the mill's concierge. Before the wool and the weave: tell me who the blanket is for, and I'll point you to the right cloth.

{{reply:It's for me}}
{{reply:It's a gift}}
{{reply:Just looking}}$greet$::text),
       updated_at = now()
 where key = 'greeting';
