-- Add Landry's non-overlapping P1 invoice number range.

with configured(email, prefix, start_number) as (
  values (
    'landryd@phospitality.com'::text,
    'P1-D-'::text,
    4000::bigint
  )
),
resolved as (
  select
    users.id as user_id,
    configured.prefix,
    greatest(
      configured.start_number,
      coalesce(existing.max_number + 1, configured.start_number)
    ) as next_number
  from configured
  join auth.users users
    on lower(users.email) = configured.email
  left join lateral (
    select max(
      substring(invoices.num from '([0-9]+)$')::bigint
    ) as max_number
    from public.invoices
    where invoices.invoice_type = 'staff'
      and invoices.num like configured.prefix || '%'
      and invoices.num ~ '[0-9]+$'
  ) existing on true
)
insert into public.staff_invoice_number_series (
  user_id,
  prefix,
  next_number
)
select user_id, prefix, next_number
from resolved
on conflict (user_id) do update
set
  prefix = excluded.prefix,
  next_number = greatest(
    public.staff_invoice_number_series.next_number,
    excluded.next_number
  ),
  updated_at = now();

create or replace function public.next_staff_invoice_num(
  p_actor_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  allocated_prefix text;
  allocated_number bigint;
  configured_start bigint;
  actor_email text;
begin
  update public.staff_invoice_number_series
  set
    next_number = next_number + 1,
    updated_at = now()
  where user_id = p_actor_id
  returning prefix, next_number - 1
  into allocated_prefix, allocated_number;

  if not found then
    select lower(users.email)
    into actor_email
    from auth.users users
    where users.id = p_actor_id;

    select mapping.prefix, mapping.start_number
    into allocated_prefix, configured_start
    from (
      values
        ('lynzy@p1pros.com'::text, 'P1-L-'::text, 1000::bigint),
        ('mandy@p1pros.com'::text, 'P1-M-'::text, 2000::bigint),
        ('lynette@p1pros.com'::text, 'P1-N-'::text, 3000::bigint),
        ('landryd@phospitality.com'::text, 'P1-D-'::text, 4000::bigint)
    ) as mapping(email, prefix, start_number)
    where mapping.email = actor_email;

    if allocated_prefix is null then
      return null;
    end if;

    insert into public.staff_invoice_number_series (
      user_id,
      prefix,
      next_number
    )
    select
      p_actor_id,
      allocated_prefix,
      greatest(
        configured_start,
        coalesce(
          max(substring(invoices.num from '([0-9]+)$')::bigint) + 1,
          configured_start
        )
      )
    from public.invoices
    where invoices.invoice_type = 'staff'
      and invoices.num like allocated_prefix || '%'
      and invoices.num ~ '[0-9]+$'
    on conflict (user_id) do nothing;

    update public.staff_invoice_number_series
    set
      next_number = next_number + 1,
      updated_at = now()
    where user_id = p_actor_id
    returning prefix, next_number - 1
    into allocated_prefix, allocated_number;

    if not found then
      return null;
    end if;
  end if;

  return allocated_prefix || allocated_number::text;
end;
$$;

revoke all on function public.next_staff_invoice_num(uuid)
  from public, anon, authenticated;
grant execute on function public.next_staff_invoice_num(uuid)
  to service_role;
