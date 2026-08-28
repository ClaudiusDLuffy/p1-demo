begin;

create table if not exists public.contractor_estimate_attachments (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null
    references public.contractor_estimates(id) on delete cascade,
  contractor_id uuid not null
    references public.profiles(id) on delete restrict,
  contractor_assignment_version integer not null,
  uploaded_by uuid not null
    references public.profiles(id) on delete restrict,
  original_name text not null,
  storage_path text not null unique,
  mime_type text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete restrict,
  constraint contractor_estimate_attachments_name_check check (
    char_length(original_name) between 1 and 255
    and lower(original_name) like '%.xlsx'
  ),
  constraint contractor_estimate_attachments_mime_check check (
    mime_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ),
  constraint contractor_estimate_attachments_size_check check (
    size_bytes between 1 and 15728640
  ),
  constraint contractor_estimate_attachments_delete_check check (
    (deleted_at is null and deleted_by is null)
    or (deleted_at is not null and deleted_by is not null)
  )
);

create index if not exists contractor_estimate_attachments_estimate_recent
  on public.contractor_estimate_attachments(estimate_id, created_at desc, id desc)
  where deleted_at is null;

alter table public.contractor_estimate_attachments enable row level security;

drop policy if exists contractor_estimate_attachments_read
  on public.contractor_estimate_attachments;
create policy contractor_estimate_attachments_read
  on public.contractor_estimate_attachments
  for select using (
    (
      deleted_at is null
      and exists (
        select 1
        from public.contractor_estimates estimate
        join public.work_orders work_order
          on work_order.id = estimate.work_order_id
        where estimate.id = contractor_estimate_attachments.estimate_id
          and estimate.contractor_id = contractor_estimate_attachments.contractor_id
          and estimate.contractor_assignment_version
            = contractor_estimate_attachments.contractor_assignment_version
          and work_order.deleted_at is null
          and (
            (public.is_staff() and not public.is_invoice_controller())
            or (
              estimate.contractor_id = public.current_contractor_account_id()
              and public.can_invoice_for_contractor(estimate.contractor_id)
              and public.can_access_contractor_work_order(estimate.work_order_id)
              and work_order.contractor_id = estimate.contractor_id
              and work_order.contractor_assignment_version
                = estimate.contractor_assignment_version
            )
          )
      )
    )
    or (
      deleted_by = auth.uid()
      and deleted_at >= now() - interval '10 minutes'
    )
  );

revoke all on table public.contractor_estimate_attachments
  from public, anon, authenticated;
grant select on table public.contractor_estimate_attachments
  to authenticated, service_role;
grant insert, update, delete on table public.contractor_estimate_attachments
  to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'contractor-estimate-attachments',
  'contractor-estimate-attachments',
  false,
  15728640,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists contractor_estimate_attachments_storage_read
  on storage.objects;
create policy contractor_estimate_attachments_storage_read
  on storage.objects
  for select using (
    bucket_id = 'contractor-estimate-attachments'
    and exists (
      select 1
      from public.contractor_estimate_attachments attachment
      where attachment.storage_path = name
        and attachment.deleted_at is null
    )
  );

drop policy if exists contractor_estimate_attachments_storage_insert
  on storage.objects;
create policy contractor_estimate_attachments_storage_insert
  on storage.objects
  for insert with check (
    bucket_id = 'contractor-estimate-attachments'
    and name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}[.]xlsx$'
    and exists (
      select 1
      from public.contractor_estimates estimate
      join public.work_orders work_order
        on work_order.id = estimate.work_order_id
      join public.profiles profile
        on profile.id = auth.uid()
      where estimate.id::text = split_part(name, '/', 1)
        and estimate.state = 'draft'
        and profile.role = 'contractor'
        and profile.active = true
        and estimate.contractor_id = public.current_contractor_account_id()
        and public.can_invoice_for_contractor(estimate.contractor_id)
        and public.can_access_contractor_work_order(estimate.work_order_id)
        and work_order.deleted_at is null
        and work_order.status <> 'closed'
        and work_order.contractor_id = estimate.contractor_id
        and work_order.contractor_assignment_version
          = estimate.contractor_assignment_version
    )
  );

drop policy if exists contractor_estimate_attachments_storage_delete
  on storage.objects;
create policy contractor_estimate_attachments_storage_delete
  on storage.objects
  for delete using (
    bucket_id = 'contractor-estimate-attachments'
    and (
      exists (
        select 1
        from public.contractor_estimate_attachments attachment
        where attachment.storage_path = name
          and attachment.deleted_by = auth.uid()
          and attachment.deleted_at >= now() - interval '10 minutes'
      )
      or exists (
        select 1
        from public.contractor_estimates estimate
        join public.work_orders work_order
          on work_order.id = estimate.work_order_id
        where estimate.id::text = split_part(name, '/', 1)
          and estimate.state = 'draft'
          and estimate.contractor_id = public.current_contractor_account_id()
          and public.can_invoice_for_contractor(estimate.contractor_id)
          and public.can_access_contractor_work_order(estimate.work_order_id)
          and work_order.deleted_at is null
          and work_order.status <> 'closed'
          and work_order.contractor_id = estimate.contractor_id
          and work_order.contractor_assignment_version
            = estimate.contractor_assignment_version
      )
    )
  );

create or replace function public.attach_contractor_estimate_file(
  p_estimate_id uuid,
  p_storage_path text,
  p_original_name text,
  p_mime_type text,
  p_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_contractor_id uuid;
  v_estimate public.contractor_estimates%rowtype;
  v_attachment public.contractor_estimate_attachments%rowtype;
begin
  select profile.name
  into v_actor_name
  from public.profiles profile
  where profile.id = v_actor_id
    and profile.role = 'contractor'
    and profile.active = true;
  if not found then
    raise exception 'Active contractor authentication is required'
      using errcode = '42501';
  end if;

  v_contractor_id := public.current_contractor_account_id();
  if v_contractor_id is null
     or not public.can_invoice_for_contractor(v_contractor_id) then
    raise exception 'Invoice-capable contractor access is required'
      using errcode = '42501';
  end if;

  select estimate.* into v_estimate
  from public.contractor_estimates estimate
  join public.work_orders work_order
    on work_order.id = estimate.work_order_id
  where estimate.id = p_estimate_id
    and estimate.state = 'draft'
    and estimate.contractor_id = v_contractor_id
    and work_order.deleted_at is null
    and work_order.status <> 'closed'
    and work_order.contractor_id = estimate.contractor_id
    and work_order.contractor_assignment_version
      = estimate.contractor_assignment_version
    and public.can_access_contractor_work_order(estimate.work_order_id)
  for update of estimate;
  if not found then
    raise exception 'Only a current draft estimate can receive attachments'
      using errcode = '42501';
  end if;

  if char_length(trim(coalesce(p_original_name, ''))) not between 1 and 255
     or lower(trim(p_original_name)) not like '%.xlsx' then
    raise exception 'Only named .xlsx equipment forms are allowed'
      using errcode = '22023';
  end if;
  if p_mime_type <> 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
     or p_size_bytes not between 1 and 15728640 then
    raise exception 'The equipment form type or size is invalid'
      using errcode = '22023';
  end if;
  if p_storage_path !~ (
    '^' || p_estimate_id::text
    || '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}[.]xlsx$'
  ) then
    raise exception 'The equipment form storage path is invalid'
      using errcode = '22023';
  end if;
  if (
    select count(*)
    from public.contractor_estimate_attachments attachment
    where attachment.estimate_id = v_estimate.id
      and attachment.deleted_at is null
  ) >= 10 then
    raise exception 'An estimate can have at most 10 equipment forms'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'contractor-estimate-attachments'
      and object.name = p_storage_path
  ) then
    raise exception 'Uploaded equipment form was not found'
      using errcode = 'P0002';
  end if;

  insert into public.contractor_estimate_attachments (
    estimate_id,
    contractor_id,
    contractor_assignment_version,
    uploaded_by,
    original_name,
    storage_path,
    mime_type,
    size_bytes
  ) values (
    v_estimate.id,
    v_estimate.contractor_id,
    v_estimate.contractor_assignment_version,
    v_actor_id,
    trim(p_original_name),
    p_storage_path,
    p_mime_type,
    p_size_bytes
  ) returning * into v_attachment;

  insert into public.activities (
    work_order_id, author_id, author_name, text, type,
    activity_channel, event_key, event_data
  ) values (
    v_estimate.work_order_id,
    v_actor_id,
    coalesce(v_actor_name, 'Contractor'),
    format('Equipment form uploaded to estimate #%s: %s.', v_estimate.quote_num, v_attachment.original_name),
    'system',
    'system_event',
    'contractor_estimate_attachment_added',
    jsonb_build_object(
      'estimateId', v_estimate.id,
      'attachmentId', v_attachment.id,
      'fileName', v_attachment.original_name
    )
  );

  return jsonb_build_object(
    'id', v_attachment.id,
    'estimateId', v_attachment.estimate_id,
    'originalName', v_attachment.original_name,
    'storagePath', v_attachment.storage_path,
    'mimeType', v_attachment.mime_type,
    'sizeBytes', v_attachment.size_bytes,
    'uploadedBy', v_attachment.uploaded_by,
    'createdAt', v_attachment.created_at
  );
end;
$$;

create or replace function public.remove_contractor_estimate_file(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_contractor_id uuid;
  v_estimate public.contractor_estimates%rowtype;
  v_attachment public.contractor_estimate_attachments%rowtype;
begin
  select profile.name
  into v_actor_name
  from public.profiles profile
  where profile.id = v_actor_id
    and profile.role = 'contractor'
    and profile.active = true;
  if not found then
    raise exception 'Active contractor authentication is required'
      using errcode = '42501';
  end if;

  v_contractor_id := public.current_contractor_account_id();
  select attachment.* into v_attachment
  from public.contractor_estimate_attachments attachment
  where attachment.id = p_attachment_id
    and attachment.deleted_at is null
  for update;
  if not found then
    raise exception 'Equipment form not found'
      using errcode = 'P0002';
  end if;

  select estimate.* into v_estimate
  from public.contractor_estimates estimate
  join public.work_orders work_order
    on work_order.id = estimate.work_order_id
  where estimate.id = v_attachment.estimate_id
    and estimate.state = 'draft'
    and estimate.contractor_id = v_contractor_id
    and estimate.contractor_id = v_attachment.contractor_id
    and estimate.contractor_assignment_version
      = v_attachment.contractor_assignment_version
    and work_order.deleted_at is null
    and work_order.status <> 'closed'
    and work_order.contractor_id = estimate.contractor_id
    and work_order.contractor_assignment_version
      = estimate.contractor_assignment_version
    and public.can_invoice_for_contractor(estimate.contractor_id)
    and public.can_access_contractor_work_order(estimate.work_order_id)
  for update of estimate;
  if not found then
    raise exception 'Only equipment forms on a current draft estimate can be removed'
      using errcode = '42501';
  end if;

  update public.contractor_estimate_attachments attachment
  set deleted_at = now(),
      deleted_by = v_actor_id
  where attachment.id = v_attachment.id
    and attachment.deleted_at is null;

  insert into public.activities (
    work_order_id, author_id, author_name, text, type,
    activity_channel, event_key, event_data
  ) values (
    v_estimate.work_order_id,
    v_actor_id,
    coalesce(v_actor_name, 'Contractor'),
    format('Equipment form removed from estimate #%s: %s.', v_estimate.quote_num, v_attachment.original_name),
    'system',
    'system_event',
    'contractor_estimate_attachment_removed',
    jsonb_build_object(
      'estimateId', v_estimate.id,
      'attachmentId', v_attachment.id,
      'fileName', v_attachment.original_name
    )
  );

  return jsonb_build_object(
    'attachmentId', v_attachment.id,
    'storagePath', v_attachment.storage_path
  );
end;
$$;

revoke all on function public.attach_contractor_estimate_file(
  uuid, text, text, text, bigint
) from public, anon;
revoke all on function public.remove_contractor_estimate_file(uuid)
  from public, anon;
grant execute on function public.attach_contractor_estimate_file(
  uuid, text, text, text, bigint
) to authenticated, service_role;
grant execute on function public.remove_contractor_estimate_file(uuid)
  to authenticated, service_role;

comment on table public.contractor_estimate_attachments is
  'Private contractor-uploaded .xlsx equipment forms tied to the exact estimate and contractor assignment.';

commit;
