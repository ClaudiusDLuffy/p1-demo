create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  plan text not null default 'free',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table organizations is 'Tenant organizations. Scaffold only - RLS and foreign keys added in a later migration.';
