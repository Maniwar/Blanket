-- ============================================================================
-- 0013_cache_operator.sql — Feierabend (Decke 01) semantic-cache match fix
-- match_cached_answer pins search_path = '' (SECURITY DEFINER hygiene), but
-- the pgvector <#> operator lives in the extensions schema — with an empty
-- search path it cannot be resolved: 42883 "operator does not exist:
-- extensions.vector <#> extensions.vector". Diagnosed via ?cachecheck=1.
-- Qualify the operator explicitly with OPERATOR(extensions.<#>).
-- ============================================================================

create or replace function public.match_cached_answer(
  query_embedding extensions.vector(384),
  match_threshold float default 0.90
) returns table (id uuid, question text, answer_md text, similarity float)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id
    from public.concierge_cache c
    where c.enabled
    order by c.embedding operator(extensions.<#>) query_embedding
    limit 1;

  if v_id is null then return; end if;

  return query
    update public.concierge_cache c
      set hits = c.hits + 1, last_hit_at = now()
      where c.id = v_id
        and (c.embedding operator(extensions.<#>) query_embedding) * -1 >= match_threshold
      returning c.id, c.question, c.answer_md,
                (c.embedding operator(extensions.<#>) query_embedding) * -1;
end;
$$;

revoke execute on function public.match_cached_answer(extensions.vector, float)
  from public, anon, authenticated;
