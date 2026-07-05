-- 0034_concierge_tools.sql — admin overrides for the concierge's model-callable
-- tools. The built-in tool set (get_my_orders, resend_confirmation, request_mending,
-- update_gift_details, get_care_guide, track_shipment, …) lives in the concierge
-- function's code (REGISTER_TOOLS). A row here overrides one of those tools:
-- disable it, or replace the model-facing description. A tool with no row runs
-- with its built-in default. Read by the concierge (service role) and merged over
-- the code defaults before the tools array is sent to the model; written by admins
-- in the Studio Tools tab. Mirrored in setup.sql.

create table if not exists public.concierge_tools (
  name        text primary key,               -- must match a built-in tool name
  enabled     boolean not null default true,  -- false → tool is withheld from the model
  description text,                            -- non-empty → overrides the model-facing copy
  sort_order  int not null default 100,
  updated_at  timestamptz not null default now()
);

alter table public.concierge_tools enable row level security;

drop policy if exists "admin all" on public.concierge_tools;
create policy "admin all" on public.concierge_tools for all to authenticated
  using (public.is_concierge_admin()) with check (public.is_concierge_admin());
