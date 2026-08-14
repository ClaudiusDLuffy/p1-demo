-- Replace person-specific controller checks with a capability grant and add
-- an atomic, auditable controller export batch. The archive is assembled and
-- uploaded by the server first; this transaction marks only the exact invoices
-- in that completed archive as sent to QuickBooks.

begin;

create table if not exists public.staff_permission_grants (
  profile_id uuid not null
    references public.profiles(id) on delete cascade,
  permission text not null,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (profile_id, permission),
  constraint staff_permission_grants_permission_present
    check (length(trim(permission)) > 0)
);

comment on table public.staff_permission_grants is
  'Data-driven staff capabilities. Runtime authorization must never depend on a person-specific email address.';

-- Preserve the controller selected by the legacy function without repeating
-- its email address in this migration. Once copied, the runtime function below
-- uses only this grant table.
do $migration$
declare
  legacy_definition text;
  legacy_match text[];
  legacy_email text;
begin
  if to_regprocedure('public.is_invoice_controller()') is not null then
    select pg_get_functiondef('public.is_invoice_controller()'::regprocedure)
    into legacy_definition;

    legacy_match := regexp_match(
      legacy_definition,
      $$=\s*'([^']+)'$$,
      'i'
    );
    legacy_email := case
      when legacy_match is null then null
      else nullif(lower(trim(legacy_match[1])), '')
    end;

    if legacy_email is not null then
      insert into public.staff_permission_grants (
        profile_id,
        permission,
        granted_by
      )
      select profile.id, 'invoice_controller', null
      from public.profiles profile
      where lower(profile.email) = legacy_email
        and profile.active = true
        and profile.role in ('manager', 'dispatcher', 'back_office')
      on conflict (profile_id, permission) do nothing;
    end if;
  end if;
end
$migration$;

alter table public.staff_permission_grants enable row level security;

drop policy if exists staff_permission_grants_read
  on public.staff_permission_grants;
create policy staff_permission_grants_read
  on public.staff_permission_grants
  for select using (
    (
      public.is_staff()
      and not public.is_invoice_controller()
    )
    or profile_id = auth.uid()
  );

revoke all on public.staff_permission_grants from public, anon, authenticated;
grant select on public.staff_permission_grants to authenticated;
grant all on public.staff_permission_grants to service_role;

create or replace function public.profile_has_staff_permission(
  p_profile_id uuid,
  p_permission text
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.staff_permission_grants permission_grant
      on permission_grant.profile_id = profile.id
    where profile.id = p_profile_id
      and profile.active = true
      and profile.role in ('manager', 'dispatcher', 'back_office')
      and permission_grant.permission = p_permission
  )
$$;

create or replace function public.has_staff_permission(
  p_permission text
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.profile_has_staff_permission(auth.uid(), p_permission)
$$;

create or replace function public.is_invoice_controller()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.has_staff_permission('invoice_controller')
$$;

revoke all on function public.profile_has_staff_permission(uuid, text)
  from public, anon, authenticated;
revoke all on function public.has_staff_permission(text)
  from public, anon;
revoke all on function public.is_invoice_controller()
  from public, anon;

grant execute on function public.has_staff_permission(text),
  public.is_invoice_controller()
  to authenticated, service_role;
grant execute on function public.profile_has_staff_permission(uuid, text)
  to service_role;

-- Invoice-number ownership is configuration, not application logic. Earlier
-- versions bootstrapped a missing row from person-specific email mappings;
-- from this migration forward staff_invoice_number_series is canonical. Staff
-- without a dedicated range use one shared, atomic default series.
create table if not exists public.staff_invoice_default_series (
  singleton boolean primary key default true,
  prefix text not null,
  number_width integer not null default 5,
  next_number bigint not null,
  updated_at timestamptz not null default now(),
  constraint staff_invoice_default_series_singleton check (singleton),
  constraint staff_invoice_default_series_prefix_present
    check (length(trim(prefix)) > 0),
  constraint staff_invoice_default_series_width_valid
    check (number_width between 1 and 18),
  constraint staff_invoice_default_series_next_positive
    check (next_number > 0)
);

insert into public.staff_invoice_default_series (
  singleton,
  prefix,
  number_width,
  next_number
)
select
  true,
  'P1-',
  5,
  greatest(
    1,
    coalesce(
      max(substring(invoice.num from '^P1-([0-9]+)$')::bigint) + 1,
      1
    )
  )
from public.invoices invoice
where invoice.invoice_type = 'staff'
  and invoice.num ~ '^P1-[0-9]+$'
on conflict (singleton) do update
set next_number = greatest(
      public.staff_invoice_default_series.next_number,
      excluded.next_number
    ),
    updated_at = now();

revoke all on public.staff_invoice_default_series
  from public, anon, authenticated;
grant all on public.staff_invoice_default_series to service_role;

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

  update public.staff_invoice_number_series
  set next_number = next_number + 1,
      updated_at = now()
  where user_id = p_actor_id
  returning prefix, next_number - 1
  into allocated_prefix, allocated_number;

  if found then
    return allocated_prefix || allocated_number::text;
  end if;

  update public.staff_invoice_default_series
  set next_number = next_number + 1,
      updated_at = now()
  where singleton = true
  returning prefix, next_number - 1, number_width
  into allocated_prefix, allocated_number, allocated_width;

  if not found then
    raise exception 'Default staff invoice number series is not configured'
      using errcode = 'P0002';
  end if;

  return allocated_prefix
    || lpad(allocated_number::text, allocated_width, '0');
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
      select series.prefix || series.next_number::text
      from public.staff_invoice_number_series series
      where series.user_id = p_actor_id
    ),
    (
      select default_series.prefix
        || lpad(
          default_series.next_number::text,
          default_series.number_width,
          '0'
        )
      from public.staff_invoice_default_series default_series
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

create table if not exists public.controller_invoice_export_batches (
  id uuid primary key,
  created_by uuid not null references public.profiles(id),
  object_path text not null unique,
  invoice_count integer not null,
  total numeric(14,2) not null,
  created_at timestamptz not null default now(),
  constraint controller_export_invoice_count_positive
    check (invoice_count > 0),
  constraint controller_export_total_nonnegative
    check (total >= 0)
);

create table if not exists public.controller_invoice_export_items (
  batch_id uuid not null
    references public.controller_invoice_export_batches(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id),
  invoice_num text not null,
  work_order_id text references public.work_orders(id),
  contractor_id uuid references public.profiles(id),
  total numeric(12,2) not null,
  exported_at timestamptz not null default now(),
  primary key (batch_id, invoice_id),
  unique (invoice_id)
);

create index if not exists controller_invoice_exports_created_at
  on public.controller_invoice_export_batches(created_at desc);

alter table public.controller_invoice_export_batches enable row level security;
alter table public.controller_invoice_export_items enable row level security;

drop policy if exists controller_export_batches_read
  on public.controller_invoice_export_batches;
create policy controller_export_batches_read
  on public.controller_invoice_export_batches
  for select using (public.is_invoice_controller());

drop policy if exists controller_export_items_read
  on public.controller_invoice_export_items;
create policy controller_export_items_read
  on public.controller_invoice_export_items
  for select using (public.is_invoice_controller());

revoke all on public.controller_invoice_export_batches
  from public, anon, authenticated;
revoke all on public.controller_invoice_export_items
  from public, anon, authenticated;
grant select on public.controller_invoice_export_batches,
  public.controller_invoice_export_items
  to authenticated;
grant all on public.controller_invoice_export_batches,
  public.controller_invoice_export_items
  to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'controller-exports',
  'controller-exports',
  false,
  104857600,
  array['application/zip']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- The private archive is intentionally accessed only through the authenticated
-- server route. No browser storage policy is granted for this bucket.

create or replace function public.complete_controller_invoice_export(
  p_batch_id uuid,
  p_actor_id uuid,
  p_object_path text,
  p_invoice_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_count integer;
  eligible_count integer;
  exported_total numeric(14,2);
  actor_name text;
begin
  requested_count := coalesce(cardinality(p_invoice_ids), 0);

  if p_batch_id is null
     or p_actor_id is null
     or nullif(trim(coalesce(p_object_path, '')), '') is null
     or requested_count < 1
     or requested_count > 500 then
    raise exception 'A batch id, object path, and 1-500 invoice ids are required'
      using errcode = '22023';
  end if;

  if not public.profile_has_staff_permission(
    p_actor_id,
    'invoice_controller'
  ) then
    raise exception 'Invoice controller permission required'
      using errcode = '42501';
  end if;

  select profile.name
  into actor_name
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.active = true;

  if actor_name is null then
    raise exception 'Active controller profile not found'
      using errcode = 'P0002';
  end if;

  -- Serialize against review, individual handoff, and another export.
  perform 1
  from public.invoices invoice
  where invoice.id = any(p_invoice_ids)
  order by invoice.id
  for update;

  select count(*), round(coalesce(sum(invoice.total), 0), 2)
  into eligible_count, exported_total
  from public.invoices invoice
  where invoice.id = any(p_invoice_ids)
    and invoice.invoice_type = 'contractor'
    and invoice.state = 'approved'
    and invoice.deleted_at is null
    and (
      invoice.pdf_storage_path is not null
      or exists (
        select 1
        from public.invoice_lines line
        where line.invoice_id = invoice.id
      )
    );

  if eligible_count <> requested_count then
    raise exception 'One or more invoices changed, lack source data, or are not approved'
      using errcode = '40001';
  end if;

  insert into public.controller_invoice_export_batches (
    id,
    created_by,
    object_path,
    invoice_count,
    total
  ) values (
    p_batch_id,
    p_actor_id,
    trim(p_object_path),
    requested_count,
    exported_total
  );

  insert into public.controller_invoice_export_items (
    batch_id,
    invoice_id,
    invoice_num,
    work_order_id,
    contractor_id,
    total
  )
  select
    p_batch_id,
    invoice.id,
    invoice.num,
    invoice.work_order_id,
    invoice.contractor_id,
    coalesce(invoice.total, 0)
  from public.invoices invoice
  where invoice.id = any(p_invoice_ids);

  update public.invoices invoice
  set state = 'paid',
      paid_at = now(),
      updated_at = now()
  where invoice.id = any(p_invoice_ids)
    and invoice.state = 'approved'
    and invoice.deleted_at is null;

  insert into public.activities (
    work_order_id,
    author_id,
    author_name,
    text,
    type,
    event_key,
    event_data
  )
  select
    item.work_order_id,
    p_actor_id,
    actor_name,
    format(
      'Invoice #%s sent to QuickBooks by %s in controller batch %s.',
      item.invoice_num,
      actor_name,
      p_batch_id
    ),
    'system',
    'invoice_sent_to_quickbooks',
    jsonb_build_object(
      'invoiceId', item.invoice_id,
      'invoiceNum', item.invoice_num,
      'batchId', p_batch_id,
      'outcome', 'sent_to_quickbooks'
    )
  from public.controller_invoice_export_items item
  where item.batch_id = p_batch_id
    and item.work_order_id is not null;

  update public.work_orders work_order
  set status = coalesce(
        public.contractor_invoice_work_order_status(work_order.id),
        'pending_invoice'::public.wo_status
      ),
      updated_at = now()
  where work_order.id in (
    select distinct item.work_order_id
    from public.controller_invoice_export_items item
    where item.batch_id = p_batch_id
      and item.work_order_id is not null
  )
    and work_order.status <> 'closed'
    and work_order.deleted_at is null;

  return jsonb_build_object(
    'batchId', p_batch_id,
    'invoiceCount', requested_count,
    'total', exported_total,
    'objectPath', trim(p_object_path)
  );
end;
$$;

revoke all on function public.complete_controller_invoice_export(
  uuid,
  uuid,
  text,
  uuid[]
) from public, anon, authenticated;
grant execute on function public.complete_controller_invoice_export(
  uuid,
  uuid,
  text,
  uuid[]
) to service_role;

commit;
