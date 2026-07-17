-- T27: judge_findings classes the live veto vocabulary into its TRUE families
\set ON_ERROR_STOP on
do $$
declare v jsonb; k text; got jsonb := '{}'::jsonb;
begin
  delete from public.concierge_actions where action like 'beat_%';
  insert into public.concierge_actions (action, payload, result) values
    ('beat_veto', jsonb_build_object('kind','nudge','line','x','reason',
      'INVENTORIES THE SHOPPER: RECITES STORED DATA ABOUT THEIR LIFE AS A TALLY.'), null),
    ('beat_veto', jsonb_build_object('kind','nudge','line','x','reason',
      'Invents care instructions not authorized by house rules; house rules forbid claims beyond cloth properties.'), null),
    ('beat_veto', jsonb_build_object('kind','nudge','line','x','reason',
      'Reading records aloud — quotes stored phone number from house register.'), null),
    ('beat_veto', jsonb_build_object('kind','nudge','line','x','reason',
      'pre-filter: unrenderable plumbing token {{tool:x}}'), null),
    ('beat_veto', jsonb_build_object('kind','nudge','line','x','reason',
      'narrates sign-in mechanics instead of genuine service'), null);
  v := public.judge_findings(14);
  for k in select c->>'key' from jsonb_array_elements(v->'classes') c loop
    got := got || jsonb_build_object(k, coalesce((got->>k)::int, 0) + 1);
  end loop;
  -- expected: inventorying x2 rows -> class 'inventorying' n=2 (tally + read-aloud),
  -- invented n=1 (care instructions), prefilter n=1, plumbing n=1 (sign-in narration)
  if not (got ? 'inventorying') then raise exception 'T27: inventorying class missing (%)', got; end if;
  if not (got ? 'invented') then raise exception 'T27: invented class missing (%)', got; end if;
  if (select (c->>'n')::int from jsonb_array_elements(v->'classes') c where c->>'key' = 'inventorying') <> 2 then
    raise exception 'T27: inventorying should own the tally AND the read-aloud rows: %', v->'classes'; end if;
  if (select (c->>'n')::int from jsonb_array_elements(v->'classes') c where c->>'key' = 'invented') <> 1 then
    raise exception 'T27: care-instructions veto should be invented, got %', v->'classes'; end if;
  if (select (c->>'n')::int from jsonb_array_elements(v->'classes') c where c->>'key' = 'plumbing') <> 1 then
    raise exception 'T27: sign-in narration should be the only plumbing row: %', v->'classes'; end if;
  raise notice 'T27 ok — inventories/care/read-aloud/prefilter/narration all land true: %', got;
end $$;
