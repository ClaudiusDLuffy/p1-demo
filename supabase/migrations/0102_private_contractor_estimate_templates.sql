-- Approved equipment workbooks are shared as private contractor resources.
-- The files are deliberately kept out of the application repository and the
-- public web root. A service-role publisher uploads the two approved .xlsx
-- objects and records their metadata after this migration is applied.

begin;

create table if not exists public.contractor_estimate_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,
  display_name text not null,
  description text not null default '',
  version_label text not null,
  original_name text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  is_active boolean not null default true,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contractor_estimate_templates_key_check check (
    template_key in ('heatcraft', 'carrier')
  ),
  constraint contractor_estimate_templates_text_check check (
    char_length(display_name) between 1 and 120
    and char_length(description) <= 500
    and char_length(version_label) between 1 and 80
    and char_length(original_name) between 1 and 255
    and lower(original_name) like '%.xlsx'
  ),
  constraint contractor_estimate_templates_storage_path_check check (
    storage_path ~ '^(heatcraft|carrier)/[0-9a-f]{64}[.]xlsx$'
  ),
  constraint contractor_estimate_templates_mime_check check (
    mime_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ),
  constraint contractor_estimate_templates_size_check check (
    size_bytes between 1 and 15728640
  ),
  constraint contractor_estimate_templates_sha256_check check (
    sha256 ~ '^[0-9a-f]{64}$'
  )
);

drop trigger if exists touch_contractor_estimate_templates
  on public.contractor_estimate_templates;
create trigger touch_contractor_estimate_templates
  before update on public.contractor_estimate_templates
  for each row execute function public.touch_updated_at();

alter table public.contractor_estimate_templates enable row level security;

drop policy if exists contractor_estimate_templates_read
  on public.contractor_estimate_templates;
create policy contractor_estimate_templates_read
  on public.contractor_estimate_templates
  for select using (
    is_active
    and (
      (
        public.is_staff()
        and not public.is_invoice_controller()
      )
      or (
        public.current_contractor_account_id() is not null
        and public.can_invoice_for_contractor(
          public.current_contractor_account_id()
        )
      )
    )
  );

revoke all on table public.contractor_estimate_templates
  from public, anon, authenticated;
grant select on table public.contractor_estimate_templates
  to authenticated, service_role;
grant insert, update, delete on table public.contractor_estimate_templates
  to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'contractor-estimate-templates',
  'contractor-estimate-templates',
  false,
  15728640,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists contractor_estimate_templates_storage_read
  on storage.objects;
create policy contractor_estimate_templates_storage_read
  on storage.objects
  for select using (
    bucket_id = 'contractor-estimate-templates'
    and exists (
      select 1
      from public.contractor_estimate_templates template
      where template.storage_path = name
        and template.is_active
    )
  );

-- Publishing is service-role only. These drops make a rerun remove any stale
-- authenticated write policy that may have been created during development.
drop policy if exists contractor_estimate_templates_storage_insert
  on storage.objects;
drop policy if exists contractor_estimate_templates_storage_update
  on storage.objects;
drop policy if exists contractor_estimate_templates_storage_delete
  on storage.objects;

comment on table public.contractor_estimate_templates is
  'Private, approved Heatcraft and Carrier workbooks available to active invoice-capable contractors and operational P1 staff.';

commit;
