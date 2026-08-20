-- Hotfix for migration 0076: the page RPCs run as SECURITY INVOKER and call
-- these cursor helpers as the authenticated user. 0076 revoked PUBLIC access
-- but originally omitted the explicit authenticated grants, so any page that
-- needed to encode or decode a cursor could fail with permission denied.

begin;

revoke all on function public.portal_encode_cursor(jsonb)
  from public, anon;
revoke all on function public.portal_decode_cursor(text)
  from public, anon;

grant execute on function public.portal_encode_cursor(jsonb)
  to authenticated, service_role;
grant execute on function public.portal_decode_cursor(text)
  to authenticated, service_role;

commit;
