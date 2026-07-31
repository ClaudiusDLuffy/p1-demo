-- Allocate non-overlapping P1 invoice numbers per invoicing user and keep the
-- controller account limited to approved contractor invoices.

create table if not exists public.staff_invoice_number_series (
  user_id uuid primary key
    references public.profiles(id) on delete cascade,
  prefix text not null unique,
  next_number bigint not null,
  updated_at timestamptz not null default now(),
  constraint staff_invoice_number_series_prefix_present
    check (length(trim(prefix)) > 0),
  constraint staff_invoice_number_series_next_positive
    check (next_number > 0)
);

with configured(email, prefix, start_number) as (
  values
    ('lynzy@p1pros.com'::text, 'P1-L-'::text, 1000::bigint),
    ('mandy@p1pros.com'::text, 'P1-M-'::text, 2000::bigint),
    ('lynette@p1pros.com'::text, 'P1-N-'::text, 3000::bigint)
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
        ('lynette@p1pros.com'::text, 'P1-N-'::text, 3000::bigint)
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

revoke all on table public.staff_invoice_number_series
  from public, anon, authenticated;
grant all on table public.staff_invoice_number_series
  to service_role;
revoke all on function public.next_staff_invoice_num(uuid)
  from public, anon, authenticated;
grant execute on function public.next_staff_invoice_num(uuid)
  to service_role;

create or replace function public.is_invoice_controller()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
    = 'emilyb@phospitality.com'
$$;

grant execute on function public.is_invoice_controller()
  to authenticated, service_role;

drop policy if exists inv_read on public.invoices;
create policy inv_read on public.invoices
  for select using (
    deleted_at is null
    and (
      (
        public.is_staff()
        and (
          not public.is_invoice_controller()
          or invoice_type = 'staff'
          or state in ('approved', 'paid')
        )
      )
      or (
        contractor_id = auth.uid()
        and invoice_type = 'contractor'
      )
    )
  );

drop policy if exists inv_insert on public.invoices;
create policy inv_insert on public.invoices
  for insert with check (
    (
      not public.is_invoice_controller()
      and exists (
        select 1
        from public.profiles
        where id = auth.uid()
          and role in ('manager', 'dispatcher', 'back_office')
      )
    )
    or (
      invoice_type = 'contractor'
      and contractor_id = auth.uid()
      and exists (
        select 1
        from public.profiles
        where id = auth.uid()
          and role = 'contractor'
          and contractor_tier = 'direct'
      )
      and exists (
        select 1
        from public.work_orders
        where id = invoices.work_order_id
          and contractor_id = auth.uid()
          and deleted_at is null
      )
    )
  );

drop policy if exists inv_update on public.invoices;
create policy inv_update on public.invoices
  for update using (
    (
      exists (
        select 1
        from public.profiles
        where id = auth.uid()
          and role in ('manager', 'dispatcher', 'back_office')
      )
      and (
        not public.is_invoice_controller()
        or (
          invoice_type = 'contractor'
          and state = 'approved'
        )
      )
    )
    or (
      contractor_id = auth.uid()
      and invoice_type = 'contractor'
    )
  )
  with check (
    (
      exists (
        select 1
        from public.profiles
        where id = auth.uid()
          and role in ('manager', 'dispatcher', 'back_office')
      )
      and (
        not public.is_invoice_controller()
        or (
          invoice_type = 'contractor'
          and state = 'paid'
        )
      )
    )
    or (
      contractor_id = auth.uid()
      and invoice_type = 'contractor'
    )
  );

drop policy if exists inv_delete on public.invoices;
create policy inv_delete on public.invoices
  for delete using (
    not public.is_invoice_controller()
    and exists (
      select 1
      from public.profiles
      where id = auth.uid()
        and role in ('manager', 'dispatcher', 'back_office')
    )
  );

drop policy if exists line_read on public.invoice_lines;
create policy line_read on public.invoice_lines
  for select using (
    exists (
      select 1
      from public.invoices invoice
      where invoice.id = invoice_id
        and invoice.deleted_at is null
        and (
          (
            public.is_staff()
            and (
              not public.is_invoice_controller()
              or invoice.invoice_type = 'staff'
              or invoice.state in ('approved', 'paid')
            )
          )
          or (
            invoice.contractor_id = auth.uid()
            and invoice.invoice_type = 'contractor'
          )
        )
    )
  );

drop policy if exists line_write on public.invoice_lines;
create policy line_write on public.invoice_lines
  for all using (
    exists (
      select 1
      from public.invoices invoice
      where invoice.id = invoice_id
        and (
          (
            public.is_staff()
            and not public.is_invoice_controller()
          )
          or (
            invoice.contractor_id = auth.uid()
            and invoice.invoice_type = 'contractor'
          )
        )
    )
  )
  with check (
    exists (
      select 1
      from public.invoices invoice
      where invoice.id = invoice_id
        and (
          (
            public.is_staff()
            and not public.is_invoice_controller()
          )
          or (
            invoice.contractor_id = auth.uid()
            and invoice.invoice_type = 'contractor'
          )
        )
    )
  );

create or replace function public.enforce_controller_invoice_handoff()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not public.is_invoice_controller() then
    return new;
  end if;

  if old.invoice_type <> 'contractor'
     or old.state <> 'approved'
     or new.state <> 'paid'
     or (
       to_jsonb(new) - array['state', 'paid_at', 'updated_at']
       <> to_jsonb(old) - array['state', 'paid_at', 'updated_at']
     ) then
    raise exception 'The controller may only send an approved invoice to QuickBooks'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_controller_invoice_handoff_trigger
  on public.invoices;
create trigger enforce_controller_invoice_handoff_trigger
  before update on public.invoices
  for each row execute function public.enforce_controller_invoice_handoff();

drop policy if exists invoice_pdfs_read on storage.objects;
create policy invoice_pdfs_read on storage.objects
  for select using (
    bucket_id = 'invoice-pdfs'
    and (
      (
        public.is_staff()
        and (
          not public.is_invoice_controller()
          or exists (
            select 1
            from public.invoices invoice
            where invoice.pdf_storage_path = name
              and invoice.deleted_at is null
              and (
                invoice.invoice_type = 'staff'
                or invoice.state in ('approved', 'paid')
              )
          )
        )
      )
      or exists (
        select 1
        from public.invoices invoice
        where invoice.contractor_id = auth.uid()
          and invoice.invoice_type = 'contractor'
          and invoice.pdf_storage_path = name
      )
    )
  );
