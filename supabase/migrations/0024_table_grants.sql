-- Grant proper permissions to anon and authenticated roles
-- These grants are required for RLS policies to work correctly
-- The anon role needs SELECT for public-facing queries
-- The authenticated role needs full CRUD for app operations
-- service_role bypasses RLS and needs all permissions

grant select on public.profiles to anon;
grant select, insert, update on public.profiles to authenticated;

grant select on public.work_orders to anon;
grant select, insert, update, delete on public.work_orders to authenticated;

grant select on public.invoices to anon;
grant select, insert, update, delete on public.invoices to authenticated;

grant select on public.activities to anon;
grant select, insert, update, delete on public.activities to authenticated;

grant select on public.photos to anon;
grant select, insert, update, delete on public.photos to authenticated;

grant select on public.invoice_lines to anon;
grant select, insert, update, delete on public.invoice_lines to authenticated;

grant select on public.contractor_technicians to anon;
grant select, insert, update, delete on public.contractor_technicians to authenticated;

grant select on public.work_reports to anon;
grant select, insert, update, delete on public.work_reports to authenticated;

grant select on public.stores to anon;
grant select, insert, update, delete on public.stores to authenticated;

grant select on public.afms to anon;
grant select, insert, update, delete on public.afms to authenticated;

grant select on public.service_notes to anon;
grant select, insert, update, delete on public.service_notes to authenticated;

grant select on public.organizations to anon;
grant select, insert, update, delete on public.organizations to authenticated;

grant select on public.qbo_tokens to anon;
grant select, insert, update, delete on public.qbo_tokens to authenticated;

grant all on all tables in schema public to service_role;
