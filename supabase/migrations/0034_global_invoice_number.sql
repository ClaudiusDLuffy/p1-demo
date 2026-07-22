-- Contractor invoice numbers are globally unique, but contractors can only
-- read their own invoices through RLS. Resolve the next numeric value inside
-- a narrowly scoped security-definer function so retries do not reuse a
-- number that belongs to another contractor.

create or replace function public.next_contractor_invoice_num()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_num bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication required'
      using errcode = '42501';
  end if;

  select greatest(
    6500::bigint,
    coalesce(
      max(
        case
          when num ~ '^[0-9]+$' then num::bigint
          else null
        end
      ),
      6500::bigint
    )
  ) + 1
  into next_num
  from public.invoices;

  return next_num::text;
end;
$$;

revoke all on function public.next_contractor_invoice_num() from public;
grant execute on function public.next_contractor_invoice_num() to authenticated;
grant execute on function public.next_contractor_invoice_num() to service_role;
