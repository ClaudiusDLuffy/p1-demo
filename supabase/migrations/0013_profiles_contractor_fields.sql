alter table public.profiles
  add column if not exists contractor_tier text
    check (contractor_tier in ('direct', 'mr_freeze', 'contracted'))
    default null,
  add column if not exists dispatcher_id uuid
    references public.profiles(id)
    default null,
  add column if not exists default_labor_rate numeric(10,2)
    default 110,
  add column if not exists default_truck_rate numeric(10,2)
    default 110,
  add column if not exists default_parts_markup numeric(5,2)
    default 0;

comment on column public.profiles.contractor_tier is
  'direct = can invoice, mr_freeze = Jorge team no invoice,
   contracted = report only no invoice. Null for non-contractors.';

comment on column public.profiles.dispatcher_id is
  'For mr_freeze technicians, points to their dispatcher profile id.';

comment on column public.profiles.default_labor_rate is
  'Default labor rate per hour for invoice auto-population.';

comment on column public.profiles.default_truck_rate is
  'Default truck charge for invoice auto-population.';
