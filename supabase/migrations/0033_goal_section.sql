-- 0033_goal_section.sql — tie a conversation goal to a page section / journey
-- stage, so the concierge prioritizes the goal that fits where the visitor is
-- (e.g. handle-doubt → specs, advance → reserve). Nullable: a goal with no
-- section is pursued regardless of where they are. Mirrored in setup.sql.

alter table public.concierge_goals
  add column if not exists section text;
