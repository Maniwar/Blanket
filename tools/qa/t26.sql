-- T26: change_callback — ownership, done-refusal, nothing-to-change
\set ON_ERROR_STOP on
do $$
declare cid bigint; r jsonb;
begin
  delete from public.concierge_appointments where kind = 'callback';
  insert into public.concierge_appointments
    (kind, status, visitor_name, visitor_contact, contact_kind, window_pref, session_key, qa)
    values ('callback','open','Rex','6199944228','phone','as soon as possible','sess-A', false)
    returning id into cid;
  r := public.change_callback(cid, 'tomorrow morning', null, null, 'sess-B');
  if (r->>'ok')::boolean then raise exception 'T26: wrong session changed it'; end if;
  if r->>'reason' <> 'not_yours' then raise exception 'T26: wrong refusal %', r; end if;
  r := public.change_callback(cid, null, null, null, 'sess-A');
  if (r->>'ok')::boolean then raise exception 'T26: empty change accepted'; end if;
  r := public.change_callback(cid, 'tomorrow morning', '6190000000', null, 'sess-A');
  if not (r->>'ok')::boolean then raise exception 'T26: rightful change refused %', r; end if;
  if (select window_pref from public.concierge_appointments where id = cid) <> 'tomorrow morning'
     or (select visitor_contact from public.concierge_appointments where id = cid) <> '6190000000' then
    raise exception 'T26: change did not land'; end if;
  update public.concierge_appointments set status = 'done' where id = cid;
  r := public.change_callback(cid, 'friday', null, null, 'sess-A');
  if (r->>'ok')::boolean then raise exception 'T26: changed a handled callback'; end if;
  if r->>'reason' <> 'not_found' then raise exception 'T26: done refusal wrong %', r; end if;
  raise notice 'T26 ok — theirs to change while open; handled calls are history';
end $$;
