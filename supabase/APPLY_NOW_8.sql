-- ============================================================================
-- APPLY_NOW_8.sql — paste into the Supabase SQL Editor and Run (after APPLY_NOW_7).
-- Structured input for order modifications. The concierge emits
-- {{form:<slug>:<serial>}}; the client renders the form defined here and
-- submits it to the edge function, which validates and executes the mapped
-- register tool — the same verified, ownership-filtered, audited write path
-- the model's own tool calls use. Admins manage forms in the Studio.
--
-- fields jsonb: array of
--   { "name","label","type" ("text"|"state"|"zip"),
--     "required" bool, "maxlength" int, "autocomplete" str }
-- ============================================================================

create table public.concierge_forms (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  title       text not null,
  submit_tool text not null,
  fields      jsonb not null,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.concierge_forms enable row level security;

create policy "admin all" on public.concierge_forms
  for all to authenticated
  using (public.is_concierge_admin())
  with check (public.is_concierge_admin());

insert into public.concierge_forms (slug, title, submit_tool, fields) values
('address-change', 'New shipping address', 'update_shipping_address', '[
  {"name":"address",  "label":"Street address",            "type":"text",  "required":true,  "maxlength":120, "autocomplete":"address-line1"},
  {"name":"address2", "label":"Apt, suite — if needed",    "type":"text",  "required":false, "maxlength":120, "autocomplete":"address-line2"},
  {"name":"city",     "label":"City",                      "type":"text",  "required":true,  "maxlength":80,  "autocomplete":"address-level2"},
  {"name":"state",    "label":"State",                     "type":"state", "required":true},
  {"name":"zip",      "label":"ZIP",                       "type":"zip",   "required":true,  "autocomplete":"postal-code"}
]'::jsonb);

-- The address-change SOP now hands the owner a form instead of dictation.
update public.concierge_sops set content_md = $sop$An owner may change the shipping address on an order that has not shipped (status placed, weaving, or finishing):
1. Call get_my_orders to confirm the order exists and is still on the loom.
2. If several orders are eligible, list them (Nº, cloth, status) and offer one pill per order: {{reply:Change the address on Nº 14,228}}.
3. Once the order is chosen, emit {{form:address-change:14228}} on its own line (using the real serial). The form collects the full address with proper fields — do not ask the owner to type the address into chat.
4. The register records the submission directly and the chat shows the confirmation; acknowledge it and read the recorded address back.
5. If the order has already shipped or been delivered, the register is closed on it — apologize once and offer hello@feierabend.example for a carrier redirect.$sop$,
  updated_at = now()
  where slug = 'address-change';

-- ----------------------------------------------------------------------------
-- Mark this repo migration as applied (so future 'db push' stays clean)
-- ----------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
values ('0012','forms')
on conflict (version) do nothing;
