-- Billing taxability is operational configuration, not component logic.
-- Rules are ordered, effective immediately, and audited. They classify which
-- invoice lines are taxable; location rate resolution is handled separately.

begin;

create table if not exists public.billing_tax_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null unique,
  name text not null,
  priority integer not null default 100,
  equipment_keywords text[] not null default '{}',
  line_types text[] not null default '{}',
  description_keywords text[] not null default '{}',
  taxable boolean not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_tax_rules_key_format
    check (rule_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  constraint billing_tax_rules_name_present
    check (char_length(trim(name)) between 1 and 120),
  constraint billing_tax_rules_priority_range
    check (priority between 0 and 100000),
  constraint billing_tax_rules_has_match_criteria
    check (
      cardinality(equipment_keywords) > 0
      or cardinality(line_types) > 0
      or cardinality(description_keywords) > 0
    )
);

create index if not exists billing_tax_rules_active_priority
  on public.billing_tax_rules(priority, rule_key)
  where is_active;

create table if not exists public.billing_tax_rule_audit (
  id bigint generated always as identity primary key,
  rule_id uuid not null,
  operation text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now(),
  constraint billing_tax_rule_audit_operation
    check (operation in ('insert', 'update'))
);

create index if not exists billing_tax_rule_audit_rule_time
  on public.billing_tax_rule_audit(rule_id, created_at desc);

create or replace function public.normalize_billing_tax_rule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  new.name := trim(new.name);
  new.priority := coalesce(new.priority, 100);

  if tg_op = 'INSERT' then
    new.rule_key := lower(trim(new.rule_key));
    new.created_by := coalesce(v_actor, new.created_by);
    new.created_at := coalesce(new.created_at, now());
  else
    new.rule_key := old.rule_key;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;

  select coalesce(array_agg(value order by value), '{}')
  into new.equipment_keywords
  from (
    select distinct lower(trim(item)) as value
    from unnest(coalesce(new.equipment_keywords, '{}')) item
    where trim(item) <> ''
  ) normalized;

  select coalesce(array_agg(value order by value), '{}')
  into new.line_types
  from (
    select distinct lower(trim(item)) as value
    from unnest(coalesce(new.line_types, '{}')) item
    where trim(item) <> ''
  ) normalized;

  select coalesce(array_agg(value order by value), '{}')
  into new.description_keywords
  from (
    select distinct lower(trim(item)) as value
    from unnest(coalesce(new.description_keywords, '{}')) item
    where trim(item) <> ''
  ) normalized;

  new.updated_by := coalesce(v_actor, new.updated_by);
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists normalize_billing_tax_rule_trigger
  on public.billing_tax_rules;
create trigger normalize_billing_tax_rule_trigger
  before insert or update on public.billing_tax_rules
  for each row execute function public.normalize_billing_tax_rule();

create or replace function public.audit_billing_tax_rule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.billing_tax_rule_audit (
    rule_id,
    operation,
    actor_id,
    previous_value,
    new_value
  ) values (
    new.id,
    lower(tg_op),
    auth.uid(),
    case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    to_jsonb(new)
  );
  return new;
end;
$$;

drop trigger if exists audit_billing_tax_rule_trigger
  on public.billing_tax_rules;
create trigger audit_billing_tax_rule_trigger
  after insert or update on public.billing_tax_rules
  for each row execute function public.audit_billing_tax_rule();

alter table public.billing_tax_rules enable row level security;
alter table public.billing_tax_rule_audit enable row level security;

drop policy if exists billing_tax_rules_read on public.billing_tax_rules;
create policy billing_tax_rules_read
  on public.billing_tax_rules
  for select using (public.is_staff());

drop policy if exists billing_tax_rules_insert on public.billing_tax_rules;
create policy billing_tax_rules_insert
  on public.billing_tax_rules
  for insert with check (public.is_staff() and not public.is_invoice_controller());

drop policy if exists billing_tax_rules_update on public.billing_tax_rules;
create policy billing_tax_rules_update
  on public.billing_tax_rules
  for update using (public.is_staff() and not public.is_invoice_controller())
  with check (public.is_staff() and not public.is_invoice_controller());

drop policy if exists billing_tax_rule_audit_read
  on public.billing_tax_rule_audit;
create policy billing_tax_rule_audit_read
  on public.billing_tax_rule_audit
  for select using (public.is_staff() and not public.is_invoice_controller());

revoke all on public.billing_tax_rules
  from public, anon, authenticated;
grant select, insert, update on public.billing_tax_rules
  to authenticated;
grant all on public.billing_tax_rules to service_role;

revoke all on public.billing_tax_rule_audit
  from public, anon, authenticated;
grant select on public.billing_tax_rule_audit to authenticated;
grant all on public.billing_tax_rule_audit to service_role;

-- Starter rules capture only the rules supplied by operations. Priority is
-- explicit: the vault exception wins globally; labor/travel stays exempt;
-- parts are taxable; remaining Slurpee equipment lines are taxable. Staff can
-- edit or deactivate every rule as the approved matrix grows.
insert into public.billing_tax_rules (
  rule_key,
  name,
  priority,
  equipment_keywords,
  line_types,
  description_keywords,
  taxable,
  is_active
) values
  (
    'vault_exempt',
    'Vaults are never taxed',
    10,
    array['vault'],
    '{}',
    '{}',
    false,
    true
  ),
  (
    'labor_travel_exempt',
    'Labor and travel are not taxed',
    20,
    '{}',
    array['labor', 'ot labor', 'travel', 'truck charge'],
    '{}',
    false,
    true
  ),
  (
    'parts_taxable',
    'Parts are taxed',
    30,
    '{}',
    array['parts/hardware'],
    '{}',
    true,
    true
  ),
  (
    'slurpee_taxable',
    'Slurpee equipment is taxed',
    40,
    array['slurpee'],
    '{}',
    '{}',
    true,
    true
  )
on conflict (rule_key) do nothing;

comment on table public.billing_tax_rules is
  'Ordered, audited staff configuration for classifying P1 billing invoice lines as taxable or exempt. First matching active rule wins.';

commit;
