-- Keep staff billing invoice counters ahead of every persisted number. Manual
-- overrides used to leave the stored counter behind, causing a stale preview
-- and repeated unique-number retries on the next automatic save.

begin;

update public.staff_invoice_number_series series
set next_number = greatest(
      series.next_number,
      coalesce(
        (
          select max(
            substring(invoice.num from char_length(series.prefix) + 1)::bigint
          ) + 1
          from public.invoices invoice
          where invoice.invoice_type = 'staff'
            and left(invoice.num, char_length(series.prefix)) = series.prefix
            and substring(invoice.num from char_length(series.prefix) + 1)
              ~ '^[0-9]+$'
        ),
        series.next_number
      )
    ),
    updated_at = now();

update public.staff_invoice_default_series default_series
set next_number = greatest(
      default_series.next_number,
      coalesce(
        (
          select max(
            substring(
              invoice.num
              from char_length(default_series.prefix) + 1
            )::bigint
          ) + 1
          from public.invoices invoice
          where invoice.invoice_type = 'staff'
            and left(invoice.num, char_length(default_series.prefix))
              = default_series.prefix
            and substring(
              invoice.num
              from char_length(default_series.prefix) + 1
            ) ~ '^[0-9]+$'
        ),
        default_series.next_number
      )
    ),
    updated_at = now()
where default_series.singleton = true;

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
  allocated_width integer;
begin
  if not exists (
    select 1
    from public.profiles profile
    where profile.id = p_actor_id
      and profile.active = true
      and profile.role in ('manager', 'dispatcher', 'back_office')
  ) then
    raise exception 'Active P1 staff actor required' using errcode = '42501';
  end if;

  update public.staff_invoice_number_series series
  set next_number = greatest(
        series.next_number,
        coalesce(
          (
            select max(
              substring(invoice.num from char_length(series.prefix) + 1)::bigint
            ) + 1
            from public.invoices invoice
            where invoice.invoice_type = 'staff'
              and left(invoice.num, char_length(series.prefix)) = series.prefix
              and substring(invoice.num from char_length(series.prefix) + 1)
                ~ '^[0-9]+$'
          ),
          series.next_number
        )
      ) + 1,
      updated_at = now()
  where series.user_id = p_actor_id
  returning prefix, next_number - 1
  into allocated_prefix, allocated_number;

  if found then
    return allocated_prefix || allocated_number::text;
  end if;

  update public.staff_invoice_default_series default_series
  set next_number = greatest(
        default_series.next_number,
        coalesce(
          (
            select max(
              substring(
                invoice.num
                from char_length(default_series.prefix) + 1
              )::bigint
            ) + 1
            from public.invoices invoice
            where invoice.invoice_type = 'staff'
              and left(invoice.num, char_length(default_series.prefix))
                = default_series.prefix
              and substring(
                invoice.num
                from char_length(default_series.prefix) + 1
              ) ~ '^[0-9]+$'
          ),
          default_series.next_number
        )
      ) + 1,
      updated_at = now()
  where default_series.singleton = true
  returning prefix, next_number - 1, number_width
  into allocated_prefix, allocated_number, allocated_width;

  if not found then
    raise exception 'Default staff invoice number series is not configured'
      using errcode = 'P0002';
  end if;

  return allocated_prefix
    || lpad(
      allocated_number::text,
      greatest(allocated_width, length(allocated_number::text)),
      '0'
    );
end;
$$;

create or replace function public.peek_staff_invoice_num(
  p_actor_id uuid
)
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select series.prefix
        || greatest(
          series.next_number,
          coalesce(
            (
              select max(
                substring(invoice.num from char_length(series.prefix) + 1)::bigint
              ) + 1
              from public.invoices invoice
              where invoice.invoice_type = 'staff'
                and left(invoice.num, char_length(series.prefix)) = series.prefix
                and substring(invoice.num from char_length(series.prefix) + 1)
                  ~ '^[0-9]+$'
            ),
            series.next_number
          )
        )::text
      from public.staff_invoice_number_series series
      where series.user_id = p_actor_id
    ),
    (
      select default_series.prefix
        || lpad(
          candidate.next_number::text,
          greatest(
            default_series.number_width,
            length(candidate.next_number::text)
          ),
          '0'
        )
      from public.staff_invoice_default_series default_series
      cross join lateral (
        select greatest(
          default_series.next_number,
          coalesce(
            (
              select max(
                substring(
                  invoice.num
                  from char_length(default_series.prefix) + 1
                )::bigint
              ) + 1
              from public.invoices invoice
              where invoice.invoice_type = 'staff'
                and left(invoice.num, char_length(default_series.prefix))
                  = default_series.prefix
                and substring(
                  invoice.num
                  from char_length(default_series.prefix) + 1
                ) ~ '^[0-9]+$'
            ),
            default_series.next_number
          )
        ) as next_number
      ) candidate
      where default_series.singleton = true
    )
  )
$$;

revoke all on function public.next_staff_invoice_num(uuid)
  from public, anon, authenticated;
revoke all on function public.peek_staff_invoice_num(uuid)
  from public, anon, authenticated;
grant execute on function public.next_staff_invoice_num(uuid),
  public.peek_staff_invoice_num(uuid)
  to service_role;

commit;
