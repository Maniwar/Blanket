-- ============================================================================
-- APPLY_NOW_6.sql — paste into the Supabase SQL Editor and Run (after APPLY_NOW_5).
-- A cancelled commission now truly returns its number to the year's edition:
-- the entry is struck (status 'cancelled', the number archived in
-- cancelled_serial), the live serial is freed, and the number joins the
-- recycling pool as an already-lapsed hold — the next visitor's hold picks it
-- up, lowest number first, through the existing hold_serial machinery.
-- Also teaches the concierge's SOPs the interactive selection flow
-- ({{reply:...}} pills for choosing and confirming).
-- ============================================================================

-- ── 1. Orders may release their serial when struck ───────────────────────────

alter table public.orders alter column serial drop not null;
alter table public.orders add column if not exists cancelled_serial int;

-- ── 2. Atomic strike-and-release RPC (service role only) ─────────────────────

create or replace function public.cancel_order_return(
  p_serial  int,
  p_user_id uuid,
  p_email   text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select o.id into v_id
    from public.orders o
    where o.serial = p_serial
      and (o.user_id = p_user_id
           or (p_email is not null and o.email = p_email))
    for update;

  if v_id is null then
    return 'no such order on this owner''s register';
  end if;

  update public.orders o
     set status = 'cancelled',
         cancelled_serial = p_serial,
         serial = null
   where o.id = v_id and o.status = 'placed';

  if not found then
    return 'only ''placed'' orders can be cancelled';
  end if;

  -- The number rejoins the edition's pool as an already-lapsed hold.
  insert into public.serial_holds (serial, session_key, expires_at)
    values (p_serial, 'released', now() - interval '1 second')
    on conflict (serial) do update
      set session_key = 'released', expires_at = now() - interval '1 second';

  return 'ok';
end;
$$;

revoke execute on function public.cancel_order_return(int, uuid, text)
  from public, anon, authenticated;

-- ── 3. SOPs learn the interactive flow ───────────────────────────────────────

update public.concierge_sops set content_md = $sop$An owner may cancel an order only while it is still 'placed' (the loom has not started):
1. Call get_my_orders — never rely on memory.
2. List every cancellable order (Nº, cloth, status), then offer one tappable pill per order, each on its own line: {{reply:Cancel Nº 14,228}}. At most 6; if there are more, offer the most recent and say so.
3. When they pick one, restate in one line that the number returns to the year's edition and cannot be held for them again, then offer exactly two pills: {{reply:Yes, cancel Nº 14,228}} and {{reply:Keep Nº 14,228}}.
4. Call cancel_order only after the explicit Yes. Confirm from the tool result — the entry is struck and the number truly returns to the edition's pool.
5. Once weaving has begun the cloth carries their number — no cancellation, but the 30-night trial still applies on arrival. Offer that instead.$sop$,
  updated_at = now()
  where slug = 'cancellation';

update public.concierge_sops set content_md = $sop$An owner may change the shipping address on an order that has not shipped (status placed, weaving, or finishing):
1. Call get_my_orders to confirm the order exists and is still on the loom.
2. If several orders are eligible, list them (Nº, cloth, status) and offer one pill per order: {{reply:Change the address on Nº 14,228}}.
3. Confirm the full new address back to the owner — street, unit if any, city, state, ZIP — and offer {{reply:Yes, record that address}} and {{reply:Hold on}} before acting.
4. Only after the owner confirms, call update_shipping_address with the serial and the complete new address, and read the recorded address back from the tool result.
5. If the order has already shipped or been delivered, the register is closed on it — apologize once and offer hello@feierabend.example for a carrier redirect.$sop$,
  updated_at = now()
  where slug = 'address-change';

update public.concierge_sops set content_md = $sop$When a signed-in owner asks about their orders, deliveries, or tracking:
1. Call get_my_orders first — never answer from memory.
2. Report each order separately: number (Nº), colorway, status, and tracking when present.
3. If they ask about "my order" and several could be meant, list them and offer one pill per order, e.g. {{reply:Status of Nº 14,228}}.
4. Status words are verbatim from the register: placed, weaving, finishing, shipped, delivered, returned, cancelled. Never invent anything more precise.
5. If an order has no tracking yet, say tracking begins the day it ships and will appear right here.
6. If the shopper is not signed in, explain that the register takes signed entries and offer {{action:signin}}.$sop$,
  updated_at = now()
  where slug = 'order-status';


-- ----------------------------------------------------------------------------
-- Mark this repo migration as applied (so future 'db push' stays clean)
-- ----------------------------------------------------------------------------

insert into supabase_migrations.schema_migrations (version, name)
values ('0010','cancel_release')
on conflict (version) do nothing;
