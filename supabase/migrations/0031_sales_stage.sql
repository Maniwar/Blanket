-- 0031_sales_stage.sql — funnel stage for each conversation.
-- The async goal grader now also classifies the shopper's sales stage
-- (browsing / engaged / evaluating / objection / ready / won / lost) and stores
-- it here, so the admin can see where conversations stall. Nullable; back-filled
-- as conversations are graded. Mirrored in setup.sql.

alter table public.concierge_conversations
  add column if not exists sales_stage text;
