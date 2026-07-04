-- Advisor hardening (applied 2026-07-03 via Supabase MCP; kept here for reproducibility).
-- 1. Pin search_path on the admin-check helper (advisor: function_search_path_mutable).
-- 2. Web roles must not execute the platform's RLS auto-enable event-trigger function
--    (advisors: anon/authenticated_security_definer_function_executable).
alter function public.is_concierge_admin() set search_path = '';
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
