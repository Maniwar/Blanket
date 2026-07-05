-- 0035_goal_sections.sql — a conversation goal may fit MORE THAN ONE journey
-- stage. Replace the single `section` text with a `sections text[]` the admin
-- edits as checkboxes; the concierge leads with a goal when the visitor is in
-- ANY of its sections. Backfilled from the old single column, which is kept for
-- back-compat during rollout. Mirrored in setup.sql.

alter table public.concierge_goals
  add column if not exists sections text[];

update public.concierge_goals
  set sections = array[section]
  where section is not null and section <> ''
    and (sections is null or cardinality(sections) = 0);
