-- Keep P1's purchase cost private while allowing an ordered P1 part to become
-- a traceable 7-Eleven invoice line. Contractors can continue to read the
-- public wo_parts row, but they can never read the cost or markup snapshot.

begin;

create table if not exists public.p1_part_costs (
  part_id uuid primary key
    references public.wo_parts(id) on delete restrict,
  unit_cost numeric(12, 2) not null,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint p1_part_costs_unit_cost_nonnegative
    check (unit_cost >= 0)
);

create table if not exists public.p1_part_cost_audit (
  id bigint generated always as identity primary key,
  part_id uuid references public.wo_parts(id) on delete set null,
  actor_id uuid references public.profiles(id) on delete set null,
  previous_unit_cost numeric(12, 2),
  new_unit_cost numeric(12, 2),
  created_at timestamptz not null default now()
);

alter table public.p1_part_costs enable row level security;
alter table public.p1_part_cost_audit enable row level security;

revoke all on public.p1_part_costs, public.p1_part_cost_audit
  from public, anon, authenticated;
grant all on public.p1_part_costs, public.p1_part_cost_audit
  to service_role;

alter table public.invoice_lines
  add column if not exists source_work_order_part_id uuid
    references public.wo_parts(id) on delete restrict;

do $constraints$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoice_lines_one_source_kind'
      and conrelid = 'public.invoice_lines'::regclass
  ) then
    alter table public.invoice_lines
      add constraint invoice_lines_one_source_kind
      check (
        source_invoice_line_id is null
        or source_work_order_part_id is null
      );
  end if;
end
$constraints$;

create unique index if not exists invoice_lines_invoice_p1_part_unique
  on public.invoice_lines(invoice_id, source_work_order_part_id)
  where source_work_order_part_id is not null;

create index if not exists invoice_lines_p1_part_source
  on public.invoice_lines(source_work_order_part_id)
  where source_work_order_part_id is not null;

create or replace function public.list_p1_part_costs_for_work_order(
  p_work_order_id text
)
returns table (
  part_id uuid,
  unit_cost numeric,
  updated_at timestamptz,
  updated_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Active staff access required' using errcode = '42501';
  end if;

  return query
  select cost.part_id, cost.unit_cost, cost.updated_at, cost.updated_by
  from public.p1_part_costs cost
  join public.wo_parts part on part.id = cost.part_id
  where part.work_order_id = p_work_order_id
  order by part.created_at, part.id;
end;
$$;

create or replace function public.list_billable_p1_parts(
  p_work_order_id text,
  p_exclude_invoice_id uuid default null
)
returns table (
  part_id uuid,
  work_order_id text,
  description text,
  part_number text,
  qty numeric,
  p1_order_status text,
  unit_cost numeric,
  marked_up_unit_rate numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role'
     and (auth.uid() is null or not public.is_staff()) then
    raise exception 'Active staff access required' using errcode = '42501';
  end if;

  return query
  select
    part.id,
    part.work_order_id,
    part.description,
    part.part_number,
    coalesce(part.qty, 1),
    part.p1_order_status,
    cost.unit_cost,
    round(cost.unit_cost * 1.25, 2)
  from public.wo_parts part
  join public.p1_part_costs cost on cost.part_id = part.id
  where part.work_order_id = p_work_order_id
    and part.ordering_responsibility = 'p1'
    and part.p1_order_status in ('ordered', 'received')
    and cost.unit_cost > 0
    and not exists (
      select 1
      from public.invoice_lines line
      join public.invoices invoice on invoice.id = line.invoice_id
      where line.source_work_order_part_id = part.id
        and invoice.invoice_type = 'staff'
        and invoice.deleted_at is null
        and invoice.id is distinct from p_exclude_invoice_id
    )
  order by part.created_at, part.id;
end;
$$;

create or replace function public.set_p1_part_order_status_with_cost(
  p_part_id uuid,
  p_status text,
  p_unit_cost numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_part public.wo_parts%rowtype;
  v_previous_cost numeric(12, 2);
  v_cost numeric(12, 2);
begin
  if v_actor_id is null
     or not public.is_staff()
     or public.is_invoice_controller() then
    raise exception 'Operational P1 staff access required'
      using errcode = '42501';
  end if;

  if p_status not in ('requested', 'ordered', 'received', 'cancelled') then
    raise exception 'Invalid P1 purchasing status' using errcode = '22023';
  end if;

  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'P1 unit cost must be zero or greater'
      using errcode = '22023';
  end if;

  select * into v_part
  from public.wo_parts
  where id = p_part_id
  for update;

  if not found then
    raise exception 'Part not found' using errcode = 'P0002';
  end if;
  if v_part.ordering_responsibility <> 'p1' then
    raise exception 'This part is not assigned to P1 purchasing'
      using errcode = '23514';
  end if;

  select cost.unit_cost into v_previous_cost
  from public.p1_part_costs cost
  where cost.part_id = p_part_id;

  v_cost := case
    when p_unit_cost is null then v_previous_cost
    else round(p_unit_cost, 2)
  end;

  if p_status in ('ordered', 'received')
     and (v_cost is null or v_cost <= 0) then
    raise exception 'Enter a P1 unit cost greater than zero before marking this part %', p_status
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.invoice_lines invoice_line
    join public.invoices invoice on invoice.id = invoice_line.invoice_id
    where invoice_line.source_work_order_part_id = p_part_id
      and invoice.invoice_type = 'staff'
      and invoice.deleted_at is null
  ) and (
    p_status not in ('ordered', 'received')
    or v_cost is distinct from v_previous_cost
  ) then
    raise exception 'Delete the linked draft or correct the staff invoice before changing this billed P1 part'
      using errcode = '55000';
  end if;

  v_part := public.set_p1_part_order_status(p_part_id, p_status);

  if p_unit_cost is not null then
    insert into public.p1_part_costs (
      part_id,
      unit_cost,
      created_by,
      updated_by,
      updated_at
    ) values (
      p_part_id,
      round(p_unit_cost, 2),
      v_actor_id,
      v_actor_id,
      now()
    )
    on conflict (part_id) do update
    set unit_cost = excluded.unit_cost,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

    if v_previous_cost is distinct from round(p_unit_cost, 2) then
      insert into public.p1_part_cost_audit (
        part_id,
        actor_id,
        previous_unit_cost,
        new_unit_cost
      ) values (
        p_part_id,
        v_actor_id,
        v_previous_cost,
        round(p_unit_cost, 2)
      );
    end if;
  end if;

  return jsonb_build_object(
    'part', to_jsonb(v_part),
    'unitCost', v_cost
  );
end;
$$;

-- Extend the existing metadata guard so a P1-purchased part cannot be linked
-- to a different work order, billed twice, or submitted with a forged cost.
create or replace function public.protect_invoice_line_billing_metadata()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_role text := coalesce(auth.role(), '');
  actor_is_staff boolean := public.is_staff();
  target_invoice_type text;
  target_work_order_id text;
  source_invoice_type text;
  source_work_order_id text;
  source_part public.wo_parts%rowtype;
  source_part_cost numeric(12, 2);
begin
  select invoice.invoice_type, invoice.work_order_id
  into target_invoice_type, target_work_order_id
  from public.invoices invoice
  where invoice.id = new.invoice_id
    and invoice.deleted_at is null;

  if not found then
    raise exception 'Invoice line must reference an active invoice';
  end if;

  if target_invoice_type = 'contractor' then
    if new.is_taxable
       or new.source_invoice_line_id is not null
       or new.source_work_order_part_id is not null
       or new.source_unit_cost is not null
       or new.markup_percent is not null then
      raise exception 'Contractor invoice lines cannot contain staff billing metadata'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if target_invoice_type <> 'staff' then
    raise exception 'Unsupported invoice type';
  end if;

  if actor_role not in ('service_role', '') and not actor_is_staff then
    raise exception 'Staff access required for billing metadata'
      using errcode = '42501';
  end if;

  if new.source_invoice_line_id is not null then
    select invoice.invoice_type, invoice.work_order_id
    into source_invoice_type, source_work_order_id
    from public.invoice_lines source_line
    join public.invoices invoice on invoice.id = source_line.invoice_id
    where source_line.id = new.source_invoice_line_id
      and invoice.deleted_at is null;

    if not found or source_invoice_type <> 'contractor' then
      raise exception 'Source line must belong to an active contractor invoice';
    end if;
    if target_work_order_id is null
       or source_work_order_id is null
       or target_work_order_id <> source_work_order_id then
      raise exception 'Source and staff invoice lines must share a work order';
    end if;
  end if;

  if new.source_work_order_part_id is not null then
    if new.source_invoice_line_id is not null then
      raise exception 'An invoice line can have only one source'
        using errcode = '23514';
    end if;

    select part.* into source_part
    from public.wo_parts part
    where part.id = new.source_work_order_part_id
    for update;

    if not found
       or source_part.work_order_id <> target_work_order_id
       or source_part.ordering_responsibility <> 'p1'
       or source_part.p1_order_status not in ('ordered', 'received') then
      raise exception 'P1 part must be ordered for the staff invoice work order'
        using errcode = '23514';
    end if;

    select cost.unit_cost into source_part_cost
    from public.p1_part_costs cost
    where cost.part_id = source_part.id;

    if source_part_cost is null
       or source_part_cost <= 0
       or round(coalesce(new.source_unit_cost, -1), 2) <> source_part_cost
       or round(coalesce(new.markup_percent, -1), 4) <> 25.0000
       or round(new.qty, 2) <> round(coalesce(source_part.qty, 1), 2)
       or round(new.rate, 2) <> round(source_part_cost * 1.25, 2)
       or lower(trim(new.type)) not in ('parts', 'parts/hardware', 'hardware') then
      raise exception 'P1 part pricing must use its recorded cost and 25 percent markup'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.invoice_lines existing_line
      join public.invoices existing_invoice
        on existing_invoice.id = existing_line.invoice_id
      where existing_line.source_work_order_part_id = source_part.id
        and existing_line.invoice_id <> new.invoice_id
        and existing_invoice.invoice_type = 'staff'
        and existing_invoice.deleted_at is null
    ) then
      raise exception 'This P1 part is already billed on another active invoice'
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_invoice_line_billing_metadata_trigger
  on public.invoice_lines;
create trigger protect_invoice_line_billing_metadata_trigger
  before insert or update on public.invoice_lines
  for each row execute function public.protect_invoice_line_billing_metadata();

-- V2 wraps the existing atomic save in the same transaction, validates every
-- P1 source line under a row lock, then attaches the source ids by position.
-- Any validation/update failure rolls the entire invoice save back.
create or replace function public.save_staff_billing_invoice_v2(
  p_actor_id uuid,
  p_invoice_id uuid,
  p_num text,
  p_work_order_id text,
  p_store_number text,
  p_store_address text,
  p_cme text,
  p_invoice_date date,
  p_service_date date,
  p_due_date date,
  p_terms text,
  p_state text,
  p_sales_tax numeric,
  p_tax_state text,
  p_tax_rate numeric,
  p_territory text,
  p_lines jsonb,
  p_source_invoice_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id uuid;
  v_p1_part_ids uuid[] := '{}'::uuid[];
  v_p1_part_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  select
    coalesce(array_agg(source_part_id order by source_part_id), '{}'::uuid[]),
    count(*)::integer
  into v_p1_part_ids, v_p1_part_count
  from (
    select nullif(item ->> 'source_work_order_part_id', '')::uuid as source_part_id
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) item
    where nullif(item ->> 'source_work_order_part_id', '') is not null
  ) requested;

  if v_p1_part_count <> cardinality(array(
    select distinct unnest(v_p1_part_ids)
  )) then
    raise exception 'A P1 part may appear only once on an invoice'
      using errcode = '22023';
  end if;

  if v_p1_part_count > 0 then
    if nullif(trim(coalesce(p_work_order_id, '')), '') is null then
      raise exception 'P1 parts require a linked work order'
        using errcode = '22023';
    end if;

    perform 1
    from public.wo_parts part
    where part.id = any(v_p1_part_ids)
    order by part.id
    for update;

    if (
      select count(*)
      from public.wo_parts part
      join public.p1_part_costs cost on cost.part_id = part.id
      where part.id = any(v_p1_part_ids)
        and part.work_order_id = p_work_order_id
        and part.ordering_responsibility = 'p1'
        and part.p1_order_status in ('ordered', 'received')
        and cost.unit_cost > 0
    ) <> v_p1_part_count then
      raise exception 'Every P1 part must be ordered, priced, and belong to this work order'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_lines) line(item)
      join public.wo_parts part
        on part.id = nullif(line.item ->> 'source_work_order_part_id', '')::uuid
      join public.p1_part_costs cost on cost.part_id = part.id
      where nullif(line.item ->> 'source_work_order_part_id', '') is not null
        and (
          nullif(line.item ->> 'source_invoice_line_id', '') is not null
          or round((line.item ->> 'source_unit_cost')::numeric, 2) <> cost.unit_cost
          or round((line.item ->> 'markup_percent')::numeric, 4) <> 25.0000
          or round((line.item ->> 'qty')::numeric, 2) <> round(coalesce(part.qty, 1), 2)
          or round((line.item ->> 'rate')::numeric, 2) <> round(cost.unit_cost * 1.25, 2)
          or lower(trim(line.item ->> 'type')) not in ('parts', 'parts/hardware', 'hardware')
        )
    ) then
      raise exception 'P1 part line pricing does not match the recorded cost'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.invoice_lines existing_line
      join public.invoices existing_invoice
        on existing_invoice.id = existing_line.invoice_id
      where existing_line.source_work_order_part_id = any(v_p1_part_ids)
        and existing_line.invoice_id is distinct from p_invoice_id
        and existing_invoice.invoice_type = 'staff'
        and existing_invoice.deleted_at is null
    ) then
      raise exception 'A P1 part is already billed on another active invoice'
        using errcode = '55000';
    end if;
  end if;

  v_invoice_id := public.save_staff_billing_invoice(
    p_actor_id,
    p_invoice_id,
    p_num,
    p_work_order_id,
    p_store_number,
    p_store_address,
    p_cme,
    p_invoice_date,
    p_service_date,
    p_due_date,
    p_terms,
    p_state,
    p_sales_tax,
    p_tax_state,
    p_tax_rate,
    p_territory,
    p_lines,
    p_source_invoice_ids
  );

  with requested as (
    select
      ordinality::integer as position,
      nullif(item ->> 'source_work_order_part_id', '')::uuid as part_id
    from jsonb_array_elements(p_lines) with ordinality as line(item, ordinality)
  )
  update public.invoice_lines invoice_line
  set source_work_order_part_id = requested.part_id
  from requested
  where invoice_line.invoice_id = v_invoice_id
    and invoice_line.position = requested.position
    and requested.part_id is not null;

  return v_invoice_id;
end;
$$;

revoke all on function public.list_p1_part_costs_for_work_order(text)
  from public, anon;
revoke all on function public.list_billable_p1_parts(text, uuid)
  from public, anon;
revoke all on function public.set_p1_part_order_status_with_cost(uuid, text, numeric)
  from public, anon;
revoke all on function public.save_staff_billing_invoice_v2(
  uuid, uuid, text, text, text, text, text, date, date, date, text,
  text, numeric, text, numeric, text, jsonb, uuid[]
) from public, anon, authenticated;

grant execute on function public.list_p1_part_costs_for_work_order(text),
  public.list_billable_p1_parts(text, uuid),
  public.set_p1_part_order_status_with_cost(uuid, text, numeric)
  to authenticated, service_role;
grant execute on function public.save_staff_billing_invoice_v2(
  uuid, uuid, text, text, text, text, text, date, date, date, text,
  text, numeric, text, numeric, text, jsonb, uuid[]
) to service_role;

comment on table public.p1_part_costs is
  'Private P1 purchase costs. Never grant this table to authenticated portal users.';
comment on column public.invoice_lines.source_work_order_part_id is
  'Auditable source link for a P1-purchased work-order part billed with the enforced 25 percent markup.';

commit;
