-- 0040_admin_directives.sql — human admin directives in the client book.
-- A 'directive' note is a standing instruction the team leaves for a specific
-- patron (order exceptions, special handling) that the concierge MUST follow on
-- the patron's next contact. One-time directives can be marked resolved once the
-- concierge (or an admin) has carried them out; standing ones stay open.
alter table public.customer_notes
  add column if not exists resolved boolean not null default false,
  add column if not exists resolved_at timestamptz,
  add column if not exists author text;

create index if not exists customer_notes_directive_idx
  on public.customer_notes (email, resolved) where kind = 'directive';
