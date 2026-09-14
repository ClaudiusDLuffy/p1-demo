-- Apply only after the server processor uses record_email_intake_result_v1.
-- No historical row is repaired, deleted, recalculated or granted provenance.
begin;
drop policy if exists email_intake_log_insert on public.email_intake_log;
revoke all on public.email_intake_log from public, anon, authenticated, service_role;
grant select on public.email_intake_log to authenticated, service_role;
-- SECURITY DEFINER plus deliberate service-only EXECUTE owns every new write;
-- service BYPASSRLS is not a table-privilege or business-authority exemption.
revoke all on public.email_intake_log_write_guards from public, anon, authenticated, service_role;
commit;
