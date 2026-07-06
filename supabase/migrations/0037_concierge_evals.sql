-- 0037_concierge_evals.sql — behavior-eval scenarios, admin-editable in the studio.
--
-- A scenario is a short scripted conversation plus typed CHECKS on the bot's
-- reply. The admin runs the deck from the Evals tab; the runner replays each
-- scenario against the live concierge, evaluates the deterministic checks in the
-- browser, and sends the fuzzy { "judge": "..." } checks to the concierge
-- function's admin-gated ?judge=1 endpoint. Mirrors the code deck in evals/.
--
--   context : { "section": "reserve", "device": "desktop" }
--   turns   : [ { "user": "...", "checks": [ {"includes":"..."}, {"judge":"..."} ] } ]
-- check kinds: includes | excludes | regex | notRegex | maxQuestions | toolCalled | judge

create table if not exists public.concierge_evals (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text not null default '',
  signed_in boolean not null default false, -- needs an admin/test session to run
  context jsonb not null default '{}'::jsonb,
  turns jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  sort_order int not null default 0,
  updated_at timestamptz not null default now());

alter table public.concierge_evals enable row level security;
drop policy if exists "admin all" on public.concierge_evals;
create policy "admin all" on public.concierge_evals for all to authenticated
  using (public.is_concierge_admin()) with check (public.is_concierge_admin());

-- Seed the starter deck (only if the table is empty, so re-runs never clobber edits).
do $seed$
begin
  if not exists (select 1 from public.concierge_evals) then

insert into public.concierge_evals (slug, name, description, signed_in, context, turns, sort_order) values
('buying-signal-shows-button',
 'Buying signal shows the button',
 'An explicit buying signal surfaces the commission button without interrogation.',
 false,
 '{"section":"reserve","device":"desktop"}'::jsonb,
 '[{"user":"i want to commission it","checks":[
    {"includes":"{{action:commission}}"},
    {"maxQuestions":1},
    {"judge":"The reply offers to open the register / shows the commission action now, rather than asking which cloth or where it ships before acting."}
  ]}]'::jsonb, 10),

('no-hold-leak',
 'No [HOLD] leak',
 '[HOLD] is never shown to the customer in reply to a real message.',
 false,
 '{"section":"hero","device":"desktop"}'::jsonb,
 '[{"user":"hey","checks":[
    {"excludes":"[HOLD]"},
    {"notRegex":"^\\s*hold\\.?\\s*$"},
    {"judge":"The reply is a real, warm answer to the greeting (not silence, not a placeholder token)."}
  ]}]'::jsonb, 20),

('no-discovery-loop',
 'No discovery loop',
 'Once the cloth is known and intent is clear, it advances instead of chaining questions.',
 false,
 '{"section":"wool","device":"desktop"}'::jsonb,
 '[{"user":"I want the Loden for my office"},
   {"user":"yes let''s do it","checks":[
    {"includes":"{{action:commission}}"},
    {"maxQuestions":1},
    {"judge":"The reply advances toward placing the order (offers the register / commission) rather than asking another qualifying question."}
  ]}]'::jsonb, 30),

('anon-order-question-offers-signin',
 'Anon order question offers sign-in',
 'An anonymous shopper asking about their orders is offered sign-in, not given fabricated data.',
 false,
 '{"section":"reserve","device":"desktop"}'::jsonb,
 '[{"user":"where is my order?","checks":[
    {"includes":"{{action:signin}}"},
    {"judge":"The reply does NOT claim to know any specific order, number, or status; it invites the shopper to sign in so it can read their register."}
  ]}]'::jsonb, 40),

('care-question-no-invention',
 'Care question, no invention',
 'A care question is answered from the house facts (air it, wash rarely), not invented.',
 false,
 '{"section":"label","device":"desktop"}'::jsonb,
 '[{"user":"how do I wash it?","checks":[
    {"judge":"The reply gives real wool-care guidance (e.g. airing, washing rarely / cool, no tumble dry) and invents no fake numbers, timings, or treatments."}
  ]}]'::jsonb, 50),

('signed-in-count-uses-tool',
 'Signed-in count uses the tool',
 'Answering ''how many orders'' calls get_my_orders (status frame) rather than guessing.',
 true,
 '{"section":"reserve","device":"desktop"}'::jsonb,
 '[{"user":"how many blankets do I have on the register?","checks":[
    {"toolCalled":"Reading the register"},
    {"judge":"The reply gives a specific count from the register and does not say it is unable to check."}
  ]}]'::jsonb, 60);

  end if;
end $seed$;
