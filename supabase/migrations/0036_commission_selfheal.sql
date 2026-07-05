-- 0036_commission_selfheal.sql — make commission_order resilient to serial /
-- hold / counter drift (e.g. after heavy testing): if the chosen number is
-- already on the register, advance to the next free one instead of hard-failing
-- the placement on unique(serial). Mirrored in setup.sql.

drop function if exists public.commission_order(text,text,text,text,text,text,text,text,uuid);
drop function if exists public.commission_order(text,text,text,text,text,text,text,text,uuid,text);
drop function if exists public.commission_order(text,text,text,text,text,text,text,text,uuid,text,text,boolean);
create or replace function public.commission_order(
  p_email text, p_name text, p_address text, p_address2 text, p_city text, p_state text,
  p_zip text, p_colorway text, p_user_id uuid, p_session text default null,
  p_recipient text default null, p_is_gift boolean default false, p_billing jsonb default null
) returns int language plpgsql security definer set search_path = '' as $$
declare v_serial int; v_run int; v_tries int := 0;
begin
  if p_session is not null and length(p_session) > 0 then
    delete from public.serial_holds h where h.serial = (
      select h2.serial from public.serial_holds h2 where h2.session_key = p_session
      order by (h2.expires_at > now()) desc, h2.serial limit 1 for update skip locked)
    returning h.serial into v_serial;
  end if;
  if v_serial is null then
    delete from public.serial_holds h where h.serial = (
      select h2.serial from public.serial_holds h2 where h2.expires_at <= now()
      order by h2.serial limit 1 for update skip locked)
    returning h.serial into v_serial;
  end if;
  if v_serial is null then
    -- Read the run size; self-heal if the run_size column hasn't been added yet
    -- (schema drift) so placement never hard-fails on a slightly-behind DB.
    begin
      select next_serial, run_size into v_serial, v_run from public.allocation_counter where id = 1 for update;
    exception when undefined_column then
      select next_serial into v_serial from public.allocation_counter where id = 1 for update;
      v_run := 15000;
    end;
    if v_serial is null or v_serial > coalesce(v_run, 15000) then return -1; end if;
    update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
  end if;
  -- Insert, self-healing if the chosen number is somehow already on the register
  -- (serial / hold / counter drift, e.g. after heavy testing or a reused hold):
  -- advance to the next genuinely-free number and keep the counter ahead, rather
  -- than hard-failing the placement on the unique(serial) constraint.
  loop
    begin
      insert into public.orders (user_id, email, name, address, address2, city, state, zip, colorway,
          serial, status, recipient_name, is_gift, billing)
        values (p_user_id, p_email, p_name, p_address, nullif(p_address2,''), p_city, p_state, p_zip,
          p_colorway, v_serial, 'placed', nullif(p_recipient,''), coalesce(p_is_gift,false), p_billing);
      return v_serial;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 100 then raise; end if;
      select run_size into v_run from public.allocation_counter where id = 1;
      select greatest(
               coalesce((select max(o.serial) from public.orders o), 0) + 1,
               coalesce((select c.next_serial from public.allocation_counter c where c.id = 1), 1)
             ) into v_serial;
      if v_serial > coalesce(v_run, 15000) then return -1; end if;
      update public.allocation_counter set next_serial = v_serial + 1 where id = 1;
    end;
  end loop;
end; $$;
revoke execute on function public.commission_order(text,text,text,text,text,text,text,text,uuid,text,text,boolean,jsonb) from public, anon, authenticated;
