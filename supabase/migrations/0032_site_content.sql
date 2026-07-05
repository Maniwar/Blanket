-- 0032_site_content.sql — storefront CMS content.
-- One row per editable slot on the marketing page (index.html): copy, image
-- src, or SEO/meta value. The hardcoded HTML holds the defaults; a slug here
-- overrides it. Read by the concierge function (?site=1, service role) and the
-- deploy-time <head> bake; written by admins in the Studio. Mirrored in
-- setup.sql. Anonymous visitors never read this table directly.

create table if not exists public.site_content (
  slug        text primary key,               -- 'benefits.headline', 'ritual.image', 'seo.title'
  kind        text not null default 'text',   -- 'text' | 'image' | 'meta'
  value       text,                           -- copy, image src (http/data:), or meta value
  alt         text,                           -- image alt (kind='image')
  updated_at  timestamptz not null default now()
);

alter table public.site_content enable row level security;

drop policy if exists "admin all" on public.site_content;
create policy "admin all" on public.site_content for all to authenticated
  using (public.is_concierge_admin()) with check (public.is_concierge_admin());
