-- Batch 2C expansion. Existing metadata/Storage paths remain usable until the
-- separately scheduled 0132 preflight and contraction. New intents are private
-- and command-owned immediately. No binary content is inspected by PostgreSQL:
-- only the restricted server attestation may finalize a known uploaded object.
begin;

create table public.private_object_control (
  singleton boolean primary key default true check(singleton),
  enforced boolean not null default false
);
insert into public.private_object_control default values;

create table public.private_object_photo_batches (
  id uuid primary key,
  actor_id uuid not null references public.profiles(id),
  work_order_id text not null references public.work_orders(id),
  assignment_version integer not null,
  workflow_cycle integer not null,
  finalized_count integer not null default 0 check(finalized_count between 0 and 8),
  activity_id uuid unique,
  created_at timestamptz not null default clock_timestamp()
);

create table public.private_object_uploads (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  batch_id uuid,
  purpose text not null check(purpose in ('photo','invoice_original','invoice_generated','estimate_attachment')),
  actor_id uuid not null references public.profiles(id),
  work_order_id text not null references public.work_orders(id),
  parent_id uuid,
  contractor_id uuid references public.profiles(id),
  assignment_version integer not null,
  workflow_cycle integer not null,
  parent_version bigint,
  parent_state jsonb,
  file jsonb not null,
  bucket text not null,
  object_path text not null,
  status text not null default 'pending' check(status in ('pending','validating','finalized','cleanup_required','cancelled','expired','cleaned')),
  expires_at timestamptz not null default clock_timestamp()+interval '30 minutes',
  claim_id uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check(attempts>=0),
  error_code text,
  inspection jsonb,
  storage_object_id uuid,
  storage_object_snapshot jsonb,
  binding_id uuid,
  photo_id uuid,
  attachment_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  finalized_at timestamptz,
  unique(bucket,object_path),
  check((purpose='photo')=(parent_id is null))
);
create index private_object_upload_reconcile on public.private_object_uploads(status,expires_at,id);
create unique index private_photo_batch_file_identity on public.private_object_uploads(batch_id,(file->>'sha256')) where purpose='photo';

create table public.private_object_bindings (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  object_path text not null,
  storage_object_id uuid not null,
  purpose text not null check(purpose in ('photo','invoice_original','invoice_generated','estimate_attachment')),
  work_order_id text not null references public.work_orders(id),
  parent_id uuid,
  photo_id uuid,
  attachment_id uuid,
  actor_id uuid not null references public.profiles(id),
  assignment_version integer not null,
  workflow_cycle integer not null,
  source_intent_id uuid unique references public.private_object_uploads(id),
  validation text not null check(validation in ('new_validated','legacy_reviewed')),
  inspection jsonb,
  review_reference text,
  attached_at timestamptz,
  state text not null default 'finalized' check(state in ('finalized','deletion_pending','deleted')),
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique(bucket,object_path),
  unique(photo_id),
  unique(attachment_id),
  check((validation='legacy_reviewed')=(review_reference is not null)),
  check((purpose='photo')=(photo_id is not null)),
  check((purpose='estimate_attachment')=(attachment_id is not null))
);
create index private_object_binding_parent on public.private_object_bindings(purpose,parent_id,state);
create index private_object_binding_work_order on public.private_object_bindings(work_order_id,state);

create table public.private_object_deletions (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  binding_id uuid not null unique references public.private_object_bindings(id),
  actor_id uuid not null references public.profiles(id),
  status text not null default 'pending' check(status in ('pending','deleting','unknown','failed','completed')),
  claim_id uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  outcome text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

-- Not a GUC: only ungranted definer routines can populate this table. Every
-- capability names one physical table row, current transaction and operation.
create table public.private_object_transition_guards (
  transaction_id bigint not null,
  relation_name text not null,
  target_id uuid not null,
  operation_id uuid,
  primary key(transaction_id,relation_name,target_id)
);

alter table public.private_object_control enable row level security;
alter table public.private_object_photo_batches enable row level security;
alter table public.private_object_uploads enable row level security;
alter table public.private_object_bindings enable row level security;
alter table public.private_object_deletions enable row level security;
alter table public.private_object_transition_guards enable row level security;
revoke all on public.private_object_control,public.private_object_photo_batches,public.private_object_uploads,
  public.private_object_bindings,public.private_object_deletions,
  public.private_object_transition_guards from public,anon,authenticated,service_role;

create function public.private_object_cap(p_relation text,p_target uuid,p_operation uuid)
returns void language sql security definer set search_path=pg_catalog,public as $$
  insert into public.private_object_transition_guards(transaction_id,relation_name,target_id,operation_id)
  values(txid_current(),p_relation,p_target,p_operation)
  on conflict(transaction_id,relation_name,target_id) do nothing;
$$;
create function public.private_object_cap_valid(p_relation text,p_target uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.private_object_transition_guards g
    where g.transaction_id=txid_current() and g.relation_name=p_relation and g.target_id=p_target);
$$;
create function public.private_object_clear_caps()
returns void language sql security definer set search_path=pg_catalog,public as $$
  delete from public.private_object_transition_guards where transaction_id=txid_current();
$$;
create function public.guard_private_object_records()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
  if public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  v_id:=case when tg_op='DELETE' then old.id else new.id end;
  if not public.private_object_cap_valid(tg_table_name,v_id) then
    raise exception 'Private object command required' using errcode='42501';
  end if;
  if tg_op='DELETE' then raise exception 'Object history cannot be deleted' using errcode='42501'; end if;
  if tg_table_name='private_object_bindings' and tg_op='UPDATE' then
    if ((to_jsonb(new)-array['state','deleted_at','attached_at']) is distinct from (to_jsonb(old)-array['state','deleted_at','attached_at'])
      or (old.attached_at is not null and new.attached_at is distinct from old.attached_at)) then
      raise exception 'Object binding identity is immutable' using errcode='42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger private_object_uploads_guard before insert or update or delete on public.private_object_uploads
  for each row execute function public.guard_private_object_records();
create trigger private_object_photo_batches_guard before insert or update or delete on public.private_object_photo_batches
  for each row execute function public.guard_private_object_records();
create trigger private_object_bindings_guard before insert or update or delete on public.private_object_bindings
  for each row execute function public.guard_private_object_records();
create trigger private_object_deletions_guard before insert or update or delete on public.private_object_deletions
  for each row execute function public.guard_private_object_records();

create function public.require_private_object_service()
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if current_setting('role')<>'service_role' or coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Trusted object service required' using errcode='42501';
  end if;
end;
$$;

-- Explicit actor validation is required because finalization runs with a
-- service identity after external IO. No caller role/company is accepted.
create function public.private_object_actor_access(p_actor uuid,p_work_order text,p_invoice_capable boolean default false)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.profiles p join public.work_orders w on w.id=p_work_order
    left join public.organizations o on o.id=p.contractor_organization_id and o.active
    where p.id=p_actor and p.active and w.deleted_at is null and (
      (p.role in ('manager','dispatcher','back_office') and
        (not p_invoice_capable or not public.profile_has_staff_permission(p.id,'invoice_controller')))
      or (p.role='contractor' and w.contractor_id=case when p.contractor_organization_id is null then p.id else o.canonical_contractor_id end
        and (p.contractor_organization_id is null
          or (p.id=o.canonical_contractor_id and p.contractor_access_level='company_admin')
          or (p.id is distinct from o.canonical_contractor_id and w.assigned_technician_profile_id=p.id
            and exists(select 1 from public.contractor_technicians t
              where t.profile_id=p.id and t.contractor_id=w.contractor_id and t.is_active)))
        and (not p_invoice_capable or
          (p.contractor_organization_id is null and coalesce(p.contractor_tier,'direct')='direct')
          or (p.id=o.canonical_contractor_id and p.contractor_access_level='company_admin')
          or (p.id is distinct from o.canonical_contractor_id and p.contractor_access_level='invoice'
            and exists(select 1 from public.contractor_technicians t
              where t.profile_id=p.id and t.contractor_id=w.contractor_id and t.is_active)))
      )
    ));
$$;

create function public.private_object_assert_target(p_upload public.private_object_uploads,p_write boolean default true)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_wo public.work_orders%rowtype; v_invoice public.invoices%rowtype; v_estimate public.contractor_estimates%rowtype;
  v_role public.user_role;
begin
  select * into v_wo from public.work_orders where id=p_upload.work_order_id for update;
  if not found or not public.private_object_actor_access(p_upload.actor_id,p_upload.work_order_id,p_upload.purpose<>'photo') then
    raise exception 'Object access is not permitted' using errcode='42501';
  end if;
  if v_wo.contractor_assignment_version<>p_upload.assignment_version or v_wo.workflow_cycle<>p_upload.workflow_cycle
    or v_wo.contractor_id is distinct from p_upload.contractor_id then
    raise exception 'Object assignment changed' using errcode='PT409';
  end if;
  if p_write and p_upload.purpose='photo' and p_upload.parent_state is distinct from
    jsonb_build_object('status',v_wo.status,'functionalStatus',v_wo.functional_status,'lifecycleVersion',v_wo.lifecycle_version) then
    raise exception 'Photo parent state changed during upload' using errcode='PT409'; end if;
  select role into v_role from public.profiles where id=p_upload.actor_id;
  if p_upload.purpose in ('invoice_original','invoice_generated') then
    select * into v_invoice from public.invoices where id=p_upload.parent_id for update;
    if not found or v_invoice.deleted_at is not null or v_invoice.work_order_id<>v_wo.id
      or (v_role='contractor' and (v_invoice.invoice_type<>'contractor' or v_invoice.contractor_id is distinct from v_wo.contractor_id
        or v_invoice.created_at<coalesce(v_wo.contractor_assignment_started_at,'infinity'::timestamptz))) then
      raise exception 'Invoice attachment access is not permitted' using errcode='42501';
    end if;
    if p_write and (v_invoice.invoice_version is distinct from p_upload.parent_version
      or (v_role='contractor' and v_invoice.state not in ('draft','submitted','rejected')))
    then raise exception 'Invoice attachment state changed' using errcode='PT409'; end if;
  elsif p_upload.purpose='estimate_attachment' then
    select * into v_estimate from public.contractor_estimates where id=p_upload.parent_id for update;
    if not found or v_role<>'contractor' or v_estimate.work_order_id<>v_wo.id
      or v_estimate.contractor_id is distinct from v_wo.contractor_id
      or v_estimate.contractor_assignment_version<>v_wo.contractor_assignment_version
      or (p_write and (v_estimate.state<>'draft' or v_wo.status='closed')) then
      raise exception 'Current draft estimate access required' using errcode='42501';
    end if;
  end if;
end;
$$;

create function public.private_object_file(p_file jsonb,p_purpose text)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare v_size numeric; v_limit bigint;
begin
  if p_file is null or jsonb_typeof(p_file)<>'object' or (p_file-array['name','mimeType','sizeBytes','sha256'])<>'{}'::jsonb
    or not(p_file ?& array['name','mimeType','sizeBytes','sha256'])
    or jsonb_typeof(p_file->'name')<>'string' or length(btrim(p_file->>'name')) not between 1 and 255
    or jsonb_typeof(p_file->'mimeType')<>'string' or length(p_file->>'mimeType')>128
    or jsonb_typeof(p_file->'sha256')<>'string' or (p_file->>'sha256')!~'^[0-9a-f]{64}$'
    or jsonb_typeof(p_file->'sizeBytes')<>'number' then
    raise exception 'Invalid upload declaration' using errcode='PT422';
  end if;
  v_size:=(p_file->>'sizeBytes')::numeric;
  v_limit:=case when p_purpose='photo' then 10485760 when p_purpose='estimate_attachment' then 15728640 else 5242880 end;
  if v_size<>trunc(v_size) or v_size<1 or v_size>v_limit then
    raise exception 'Upload size is outside the supported limit' using errcode='PT422'; end if;
  return jsonb_build_object('name',btrim(p_file->>'name'),'mimeType',p_file->>'mimeType',
    'sizeBytes',v_size,'sha256',p_file->>'sha256');
end;
$$;

create function public.private_object_upload_result(p_row public.private_object_uploads)
returns jsonb language sql immutable set search_path=pg_catalog,public as $$
  select jsonb_build_object('intentId',p_row.id,'operationId',p_row.operation_id,'batchId',p_row.batch_id,
    'purpose',p_row.purpose,'workOrderId',p_row.work_order_id,'parentId',p_row.parent_id,
    'bucket',p_row.bucket,'objectPath',p_row.object_path,'status',p_row.status,'expiresAt',p_row.expires_at,
    'claimId',p_row.claim_id,'bindingId',p_row.binding_id,'photoId',p_row.photo_id,'attachmentId',p_row.attachment_id,
    'file',p_row.file,'errorCode',p_row.error_code,'storageObjectId',p_row.storage_object_id);
$$;

create function public.private_object_upload_consistent(p_row public.private_object_uploads)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.private_object_bindings b join storage.objects o
      on o.id=b.storage_object_id and o.bucket_id=b.bucket and o.name=b.object_path
    where b.id=p_row.binding_id and b.source_intent_id=p_row.id and b.state='finalized'
      and b.object_path=p_row.object_path and b.work_order_id=p_row.work_order_id
      and b.storage_object_id=p_row.storage_object_id and b.actor_id=p_row.actor_id and b.purpose=p_row.purpose
      and b.parent_id is not distinct from p_row.parent_id and b.inspection is not distinct from p_row.inspection
      and (b.purpose in ('invoice_original','invoice_generated')
        or (b.purpose='photo' and exists(select 1 from public.photos p where p.id=b.photo_id and p.storage_path=b.object_path
          and p.work_order_id=b.work_order_id and p.uploader_id=b.actor_id)
          and exists(select 1 from public.private_object_photo_batches batch join public.activities a on a.id=batch.activity_id
            where batch.id=p_row.batch_id and batch.actor_id=p_row.actor_id and batch.work_order_id=p_row.work_order_id
              and batch.finalized_count>0 and a.author_id=batch.actor_id and a.work_order_id=batch.work_order_id
              and a.event_key='photo_added' and a.event_data->>'batchId'=batch.id::text
              and a.event_data->'count'=to_jsonb(batch.finalized_count)))
        or (b.purpose='estimate_attachment' and exists(select 1 from public.contractor_estimate_attachments a
          where a.id=b.attachment_id and a.estimate_id=b.parent_id and a.storage_path=b.object_path and a.deleted_at is null)
          and exists(select 1 from public.activities a where a.event_key='contractor_estimate_attachment_added'
            and a.work_order_id=b.work_order_id and a.author_id=b.actor_id and a.event_data->>'bindingId'=b.id::text))));
$$;

create function public.begin_private_object_upload(p_purpose text,p_work_order text,p_parent uuid,p_operation uuid,
  p_batch uuid,p_assignment integer,p_cycle integer,p_file jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_new public.private_object_uploads%rowtype; v_old public.private_object_uploads%rowtype; v_wo public.work_orders%rowtype;
  v_batch public.private_object_photo_batches%rowtype;
begin
  if auth.uid() is null or p_operation is null or p_assignment is null or p_cycle is null then
    raise exception 'Upload identity and expected versions required' using errcode='PT422'; end if;
  if p_purpose not in ('photo','invoice_original','invoice_generated','estimate_attachment') then
    raise exception 'Unsupported upload purpose' using errcode='PT422'; end if;
  perform pg_advisory_xact_lock(hashtextextended('private-object-operation:'||p_operation::text,0));
  select * into v_wo from public.work_orders where id=p_work_order for update;
  if not found then raise exception 'Work order not found' using errcode='P0002'; end if;
  v_new.id:=gen_random_uuid(); v_new.operation_id:=p_operation; v_new.batch_id:=p_batch;
  v_new.actor_id:=auth.uid(); v_new.purpose:=p_purpose; v_new.work_order_id:=p_work_order; v_new.parent_id:=p_parent;
  v_new.contractor_id:=v_wo.contractor_id; v_new.assignment_version:=p_assignment; v_new.workflow_cycle:=p_cycle;
  v_new.parent_state:=jsonb_build_object('status',v_wo.status,'functionalStatus',v_wo.functional_status,'lifecycleVersion',v_wo.lifecycle_version);
  if p_purpose in ('invoice_original','invoice_generated') then
    select invoice_version into v_new.parent_version from public.invoices where id=p_parent;
  end if;
  v_new.file:=public.private_object_file(p_file,p_purpose);
  perform public.private_object_assert_target(v_new,true);
  select * into v_old from public.private_object_uploads where operation_id=p_operation for update;
  if found then
    if v_old.actor_id<>v_new.actor_id or v_old.purpose<>v_new.purpose or v_old.work_order_id<>p_work_order
      or v_old.parent_id is distinct from p_parent or v_old.batch_id is distinct from p_batch
      or v_old.file<>v_new.file or v_old.assignment_version<>p_assignment or v_old.workflow_cycle<>p_cycle then
      raise exception 'Upload operation was reused' using errcode='PT409'; end if;
    if v_old.status='finalized' and not public.private_object_upload_consistent(v_old) then
      raise exception 'Finalized object is no longer available' using errcode='PT409'; end if;
    return public.private_object_upload_result(v_old);
  end if;
  if exists(select 1 from public.private_object_deletions where operation_id=p_operation) then
    raise exception 'Object operation was reused' using errcode='PT409'; end if;
  if p_purpose='photo' then
    perform pg_advisory_xact_lock(hashtextextended('private-object-batch:'||p_batch::text,0));
    select * into v_batch from public.private_object_photo_batches where id=p_batch for update;
    if not found then
      perform public.private_object_cap('private_object_photo_batches',p_batch,p_operation);
      insert into public.private_object_photo_batches(id,actor_id,work_order_id,assignment_version,workflow_cycle)
        values(p_batch,auth.uid(),p_work_order,p_assignment,p_cycle) returning * into v_batch;
    elsif v_batch.actor_id<>auth.uid() or v_batch.work_order_id<>p_work_order
      or v_batch.assignment_version<>p_assignment or v_batch.workflow_cycle<>p_cycle then
      raise exception 'Photo batch identity was reused' using errcode='PT409'; end if;
    if (select count(*) from public.private_object_uploads where batch_id=p_batch)>=8 then
      raise exception 'A photo batch can contain at most 8 files' using errcode='PT422'; end if;
  end if;
  v_new.bucket:=case when p_purpose='photo' then 'photos' when p_purpose='estimate_attachment' then 'contractor-estimate-attachments' else 'invoice-pdfs' end;
  v_new.object_path:=case when p_purpose='photo' then 'wo/'||p_work_order||'/'||v_new.id::text
    else p_parent::text||'/'||v_new.id::text||case when p_purpose='estimate_attachment' then '.xlsx' else '.pdf' end end;
  perform public.private_object_cap('private_object_uploads',v_new.id,p_operation);
  insert into public.private_object_uploads(id,operation_id,batch_id,purpose,actor_id,work_order_id,parent_id,
    contractor_id,assignment_version,workflow_cycle,parent_version,parent_state,file,bucket,object_path)
  values(v_new.id,p_operation,p_batch,p_purpose,v_new.actor_id,p_work_order,p_parent,v_new.contractor_id,
    p_assignment,p_cycle,v_new.parent_version,v_new.parent_state,v_new.file,v_new.bucket,v_new.object_path) returning * into v_new;
  perform public.private_object_clear_caps();
  return public.private_object_upload_result(v_new);
end;
$$;

create function public.begin_work_order_photo_upload_v1(p_work_order_id text,p_operation_id uuid,p_batch_id uuid,
  p_expected_assignment_version integer,p_expected_workflow_cycle integer,p_file jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if p_batch_id is null then raise exception 'Photo batch identity required' using errcode='PT422'; end if;
  return public.begin_private_object_upload('photo',p_work_order_id,null,p_operation_id,p_batch_id,
    p_expected_assignment_version,p_expected_workflow_cycle,p_file);
end;
$$;
create function public.begin_contractor_attachment_upload_v1(p_parent_id uuid,p_purpose text,p_operation_id uuid,p_file jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_wo public.work_orders%rowtype; v_id text;
begin
  if p_purpose in ('invoice_original','invoice_generated') then select work_order_id into v_id from public.invoices where id=p_parent_id;
  elsif p_purpose='estimate_attachment' then select work_order_id into v_id from public.contractor_estimates where id=p_parent_id;
  else raise exception 'Unsupported attachment purpose' using errcode='PT422'; end if;
  select * into v_wo from public.work_orders where id=v_id for update;
  if not found then raise exception 'Attachment parent not found' using errcode='P0002'; end if;
  return public.begin_private_object_upload(p_purpose,v_id,p_parent_id,p_operation_id,null,
    v_wo.contractor_assignment_version,v_wo.workflow_cycle,p_file);
end;
$$;

create function public.get_private_object_upload_v1(p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_uploads%rowtype;
begin
  select * into v_row from public.private_object_uploads where id=p_intent_id;
  if not found or v_row.actor_id is distinct from auth.uid() then raise exception 'Upload not found' using errcode='42501'; end if;
  perform public.private_object_assert_target(v_row,false);
  if v_row.status='finalized' and not public.private_object_upload_consistent(v_row) then
    raise exception 'Finalized object is no longer available' using errcode='PT409'; end if;
  return public.private_object_upload_result(v_row);
end;
$$;

create function public.claim_private_object_upload_v1(p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_uploads%rowtype; v_object storage.objects%rowtype;
begin
  select * into v_row from public.private_object_uploads where id=p_intent_id;
  if not found or v_row.actor_id is distinct from auth.uid() then raise exception 'Upload not found' using errcode='42501'; end if;
  -- Lock the authoritative parent before refreshing the intent. All status
  -- branches below inspect the latest committed row, including after waiting
  -- behind finalization. A stale unlocked read must never demote finalized.
  perform 1 from public.work_orders where id=v_row.work_order_id for update;
  select * into v_row from public.private_object_uploads where id=p_intent_id for update;
  if not exists(select 1 from public.profiles where id=auth.uid() and active) then
    raise exception 'Active portal access required' using errcode='42501'; end if;
  if v_row.status in ('cleanup_required','cancelled','expired','cleaned') then return public.private_object_upload_result(v_row); end if;
  if v_row.status<>'finalized' and v_row.expires_at<=clock_timestamp() then
    select * into v_row from public.private_object_uploads where id=p_intent_id for update;
    perform public.private_object_cap('private_object_uploads',v_row.id,v_row.operation_id);
    update public.private_object_uploads set status='cleanup_required',error_code='EXPIRED',claim_id=null,lease_expires_at=null
      where id=v_row.id returning * into v_row;
    perform public.private_object_clear_caps();
    return public.private_object_upload_result(v_row);
  end if;
  begin
    perform public.private_object_assert_target(v_row,v_row.status<>'finalized');
  exception when sqlstate 'PT409' or sqlstate '42501' then
    if v_row.status='finalized' then raise; end if;
    select * into v_row from public.private_object_uploads where id=p_intent_id for update;
    perform public.private_object_cap('private_object_uploads',v_row.id,v_row.operation_id);
    update public.private_object_uploads set status='cleanup_required',error_code='STALE_PARENT',claim_id=null,lease_expires_at=null
      where id=v_row.id returning * into v_row;
    perform public.private_object_clear_caps();
    return public.private_object_upload_result(v_row);
  end;
  select * into v_row from public.private_object_uploads where id=p_intent_id for update;
  if v_row.status='finalized' then
    if not public.private_object_upload_consistent(v_row) then
      raise exception 'Finalized object is no longer available' using errcode='PT409'; end if;
    return public.private_object_upload_result(v_row);
  end if;
  if v_row.expires_at<=clock_timestamp() or v_row.status not in ('pending','validating') then
    raise exception 'Upload is not available for validation' using errcode='PT409'; end if;
  if v_row.status='validating' and v_row.lease_expires_at>clock_timestamp() then
    raise exception 'Upload validation is already in progress' using errcode='PT409'; end if;
  if v_row.attempts>=10 then raise exception 'Upload requires manual review after repeated attempts' using errcode='PT409'; end if;
  select * into v_object from storage.objects where bucket_id=v_row.bucket and name=v_row.object_path;
  if found and coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),v_object.owner::text) is distinct from v_row.actor_id::text then
    raise exception 'Uploaded object owner does not match' using errcode='42501'; end if;
  perform public.private_object_cap('private_object_uploads',v_row.id,v_row.operation_id);
  update public.private_object_uploads set status='validating',claim_id=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1,
    storage_object_id=v_object.id,storage_object_snapshot=case when v_object.id is null then null else to_jsonb(v_object)-'last_accessed_at' end
    where id=v_row.id returning * into v_row;
  perform public.private_object_clear_caps();
  return public.private_object_upload_result(v_row);
end;
$$;

create function public.cancel_private_object_upload_v1(p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_uploads%rowtype; v_binding public.private_object_bindings%rowtype;
begin
  select * into v_row from public.private_object_uploads where id=p_intent_id;
  if not found or v_row.actor_id is distinct from auth.uid() then raise exception 'Upload not found' using errcode='42501'; end if;
  perform 1 from public.work_orders where id=v_row.work_order_id for update;
  if v_row.purpose in ('invoice_original','invoice_generated') then
    perform 1 from public.invoices where id=v_row.parent_id for update;
  elsif v_row.purpose='estimate_attachment' then
    perform 1 from public.contractor_estimates where id=v_row.parent_id for update;
  end if;
  select * into v_row from public.private_object_uploads where id=p_intent_id for update;
  if not found or v_row.actor_id is distinct from auth.uid() or not exists(
    select 1 from public.profiles where id=auth.uid() and active) then
    raise exception 'Upload not found' using errcode='42501'; end if;
  if v_row.status='finalized' then
    select * into v_binding from public.private_object_bindings where id=v_row.binding_id for update;
    if not found or v_row.purpose not in ('invoice_original','invoice_generated')
      or v_binding.source_intent_id is distinct from v_row.id or v_binding.attached_at is not null
      or v_binding.state<>'finalized' or exists(
      select 1 from public.invoices where pdf_storage_path=v_row.object_path) then
      if not public.private_object_upload_consistent(v_row) then
        raise exception 'Finalized object is no longer available' using errcode='PT409'; end if;
      return public.private_object_upload_result(v_row);
    end if;
    perform public.private_object_cap('private_object_bindings',v_row.binding_id,v_row.operation_id);
    update public.private_object_bindings set state='deletion_pending' where id=v_row.binding_id;
  end if;
  if v_row.status='cleaned' then return public.private_object_upload_result(v_row); end if;
  perform public.private_object_cap('private_object_uploads',v_row.id,v_row.operation_id);
  update public.private_object_uploads set status='cleanup_required',claim_id=null,lease_expires_at=null,error_code='cancelled'
    where id=v_row.id returning * into v_row;
  perform public.private_object_clear_caps();
  return public.private_object_upload_result(v_row);
end;
$$;

create function public.private_object_inspection(p_row public.private_object_uploads,p_inspection jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
declare v_size numeric; v_width numeric; v_height numeric; v_frames numeric;
  v_format text; v_mime text; v_extension text;
begin
  if p_inspection is null or jsonb_typeof(p_inspection)<>'object' or
    (p_inspection-array['format','mimeType','extension','sizeBytes','sha256','width','height','frames'])<>'{}'::jsonb
    or not(p_inspection ?& array['format','mimeType','extension','sizeBytes','sha256','width','height','frames'])
    or jsonb_typeof(p_inspection->'format')<>'string' or jsonb_typeof(p_inspection->'mimeType')<>'string'
    or jsonb_typeof(p_inspection->'extension')<>'string' or jsonb_typeof(p_inspection->'sha256')<>'string'
    or (p_inspection->>'sha256')!~'^[0-9a-f]{64}$' or jsonb_typeof(p_inspection->'sizeBytes')<>'number' then
    raise exception 'Invalid object inspection' using errcode='PT422'; end if;
  v_size:=(p_inspection->>'sizeBytes')::numeric;
  if v_size<>trunc(v_size) or v_size<1 or v_size<>(p_row.file->>'sizeBytes')::numeric
    or p_inspection->>'sha256'<>p_row.file->>'sha256' then
    raise exception 'Uploaded object changed' using errcode='PT422'; end if;
  v_format:=p_inspection->>'format'; v_mime:=p_inspection->>'mimeType'; v_extension:=p_inspection->>'extension';
  if p_row.purpose='photo' then
    if not ((v_format='jpeg' and v_mime='image/jpeg' and v_extension in ('jpg','jpeg'))
      or (v_format='png' and v_mime='image/png' and v_extension='png')
      or (v_format='webp' and v_mime='image/webp' and v_extension='webp')
      or (v_format='gif' and v_mime='image/gif' and v_extension='gif')
      or (v_format='tiff' and v_mime='image/tiff' and v_extension in ('tif','tiff')))
      or v_size>10485760 or jsonb_typeof(p_inspection->'width')<>'number'
      or jsonb_typeof(p_inspection->'height')<>'number' or jsonb_typeof(p_inspection->'frames')<>'number' then
      raise exception 'Unsupported inspected image' using errcode='PT422'; end if;
    v_width:=(p_inspection->>'width')::numeric; v_height:=(p_inspection->>'height')::numeric;
    v_frames:=(p_inspection->>'frames')::numeric;
    if v_width<>trunc(v_width) or v_height<>trunc(v_height) or v_frames<>trunc(v_frames)
      or v_width not between 1 and 12000 or v_height not between 1 and 12000 or v_frames not between 1 and 100
      or v_width*v_height*v_frames>40000000 then
      raise exception 'Image resource limit exceeded' using errcode='PT422'; end if;
  elsif p_row.purpose='estimate_attachment' then
    if v_format<>'xlsx' or v_extension<>'xlsx' or
      v_mime<>'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or v_size>15728640 then
      raise exception 'Invalid equipment form inspection' using errcode='PT422'; end if;
  else
    if v_format<>'pdf' or v_extension<>'pdf' or v_mime<>'application/pdf' or v_size>5242880 then
      raise exception 'Invalid invoice PDF inspection' using errcode='PT422'; end if;
  end if;
  if p_row.purpose<>'photo' and (p_inspection->'width'<>'null'::jsonb or p_inspection->'height'<>'null'::jsonb
    or p_inspection->'frames'<>'null'::jsonb) then
    raise exception 'Unexpected attachment dimensions' using errcode='PT422'; end if;
  return p_inspection;
end;
$$;

create function public.private_object_activity(p_work_order text,p_actor uuid,p_key text,p_text text,p_data jsonb,p_operation uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid:=gen_random_uuid(); v_name text; v_role text; v_photo boolean;
begin
  select name,role::text into v_name,v_role from public.profiles where id=p_actor;
  v_photo:=p_key in ('photo_added','photo_removed');
  perform public.private_object_cap('activities',v_id,p_operation);
  -- Preserve the existing photo note presentation and staff-override audit.
  -- The effective 0109 trigger still classifies these non-lifecycle keys as
  -- system_event, outside the manual 7-Eleven synchronization queue.
  insert into public.activities(id,work_order_id,author_id,author_name,text,type,activity_channel,
    is_staff_override,event_key,event_data)
    values(v_id,p_work_order,p_actor,coalesce(v_name,'Portal user'),p_text,
      case when v_photo then 'note' else 'system' end,'system_event',
      v_photo and v_role in ('manager','dispatcher','back_office'),p_key,p_data);
  return v_id;
end;
$$;

create function public.private_object_photo_activity(p_upload public.private_object_uploads)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_batch public.private_object_photo_batches%rowtype; v_count integer; v_text text; v_activity uuid;
begin
  select * into v_batch from public.private_object_photo_batches where id=p_upload.batch_id for update;
  if not found or v_batch.actor_id<>p_upload.actor_id or v_batch.work_order_id<>p_upload.work_order_id then
    raise exception 'Photo batch evidence is inconsistent' using errcode='PT409'; end if;
  v_count:=v_batch.finalized_count+1;
  v_text:='Added '||v_count::text||case when v_count=1 then ' photo.' else ' photos.' end;
  if v_batch.activity_id is null then
    v_activity:=public.private_object_activity(p_upload.work_order_id,p_upload.actor_id,'photo_added',v_text,
      jsonb_build_object('batchId',p_upload.batch_id,'count',v_count),p_upload.operation_id);
  else
    v_activity:=v_batch.activity_id;
    perform public.private_object_cap('activities',v_activity,p_upload.operation_id);
    update public.activities set text=v_text,event_data=jsonb_build_object('batchId',p_upload.batch_id,'count',v_count)
      where id=v_activity and work_order_id=p_upload.work_order_id and author_id=p_upload.actor_id
        and event_key='photo_added' and event_data->>'batchId'=p_upload.batch_id::text;
    if not found then raise exception 'Photo batch evidence changed' using errcode='PT409'; end if;
  end if;
  perform public.private_object_cap('private_object_photo_batches',p_upload.batch_id,p_upload.operation_id);
  update public.private_object_photo_batches set finalized_count=v_count,activity_id=v_activity where id=p_upload.batch_id;
end;
$$;

create function public.finalize_private_object_upload_v1(p_intent_id uuid,p_claim_id uuid,p_inspection jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_uploads%rowtype; v_object storage.objects%rowtype;
  v_binding uuid:=gen_random_uuid(); v_photo uuid; v_attachment uuid; v_inspection jsonb; v_name text;
begin
  perform public.require_private_object_service();
  select * into v_row from public.private_object_uploads where id=p_intent_id;
  if not found then raise exception 'Upload not found' using errcode='P0002'; end if;
  perform public.private_object_assert_target(v_row,v_row.status<>'finalized');
  select * into v_row from public.private_object_uploads where id=p_intent_id for update;
  if v_row.status='finalized' then
    if v_row.claim_id is distinct from p_claim_id or v_row.inspection is distinct from p_inspection
      or not public.private_object_upload_consistent(v_row) then
      raise exception 'Upload replay is inconsistent' using errcode='PT409'; end if;
    return public.private_object_upload_result(v_row);
  end if;
  if v_row.status<>'validating' or v_row.claim_id is distinct from p_claim_id or p_claim_id is null
    or v_row.lease_expires_at<=clock_timestamp() or v_row.expires_at<=clock_timestamp() then
    raise exception 'Upload validation claim expired' using errcode='PT409'; end if;
  v_inspection:=public.private_object_inspection(v_row,p_inspection);
  select * into v_object from storage.objects where bucket_id=v_row.bucket and name=v_row.object_path for share;
  if not found then raise exception 'Uploaded object not found' using errcode='P0002'; end if;
  if v_row.storage_object_id is not null and (v_row.storage_object_id<>v_object.id
    or v_row.storage_object_snapshot is distinct from (to_jsonb(v_object)-'last_accessed_at')) then
    raise exception 'Uploaded object changed during validation' using errcode='PT409'; end if;
  if coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),v_object.owner::text) is distinct from v_row.actor_id::text then
    raise exception 'Uploaded object owner does not match' using errcode='42501'; end if;
  if v_row.purpose='photo' then v_photo:=gen_random_uuid();
  elsif v_row.purpose='estimate_attachment' then
    if lower(v_row.file->>'name') not like '%.xlsx' then
      raise exception 'Equipment form filename must end in .xlsx' using errcode='PT422'; end if;
    if (select count(*) from public.contractor_estimate_attachments where estimate_id=v_row.parent_id and deleted_at is null)>=10 then
      raise exception 'An estimate can have at most 10 equipment forms' using errcode='23514'; end if;
    v_attachment:=gen_random_uuid();
  end if;
  perform public.private_object_cap('private_object_bindings',v_binding,v_row.operation_id);
  insert into public.private_object_bindings(id,bucket,object_path,storage_object_id,purpose,work_order_id,parent_id,
    photo_id,attachment_id,actor_id,assignment_version,workflow_cycle,source_intent_id,validation,inspection,attached_at)
  values(v_binding,v_row.bucket,v_row.object_path,v_object.id,v_row.purpose,v_row.work_order_id,v_row.parent_id,
    v_photo,v_attachment,v_row.actor_id,v_row.assignment_version,v_row.workflow_cycle,v_row.id,'new_validated',v_inspection,
    case when v_row.purpose in ('photo','estimate_attachment') then clock_timestamp() else null end);
  if v_photo is not null then
    select name into v_name from public.profiles where id=v_row.actor_id;
    perform public.private_object_cap('photos',v_photo,v_row.operation_id);
    insert into public.photos(id,work_order_id,storage_path,uploader_id,uploader_name)
      values(v_photo,v_row.work_order_id,v_row.object_path,v_row.actor_id,coalesce(v_name,'Portal user'));
    perform public.private_object_photo_activity(v_row);
  elsif v_attachment is not null then
    perform public.private_object_cap('contractor_estimate_attachments',v_attachment,v_row.operation_id);
    insert into public.contractor_estimate_attachments(id,estimate_id,contractor_id,contractor_assignment_version,
      uploaded_by,original_name,storage_path,mime_type,size_bytes)
    values(v_attachment,v_row.parent_id,v_row.contractor_id,v_row.assignment_version,v_row.actor_id,
      v_row.file->>'name',v_row.object_path,v_inspection->>'mimeType',(v_inspection->>'sizeBytes')::bigint);
    perform public.private_object_activity(v_row.work_order_id,v_row.actor_id,'contractor_estimate_attachment_added','Equipment form added.',
      jsonb_build_object('estimateId',v_row.parent_id,'attachmentId',v_attachment,'bindingId',v_binding,'operationId',v_row.operation_id),v_row.operation_id);
  end if;
  perform public.private_object_cap('private_object_uploads',v_row.id,v_row.operation_id);
  update public.private_object_uploads set status='finalized',binding_id=v_binding,storage_object_id=v_object.id,
    inspection=v_inspection,photo_id=v_photo,attachment_id=v_attachment,finalized_at=clock_timestamp(),error_code=null,lease_expires_at=null
    where id=v_row.id returning * into v_row;
  perform public.private_object_clear_caps();
  return public.private_object_upload_result(v_row);
end;
$$;

create function public.fail_private_object_upload_v1(p_intent_id uuid,p_claim_id uuid,p_code text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_uploads%rowtype; v_retry boolean;
begin
  perform public.require_private_object_service();
  if p_code is null or p_code not in ('OBJECT_MISSING','UNSUPPORTED_IMAGE_FORMAT','INVALID_IMAGE_CONTENT','IMAGE_RESOURCE_LIMIT',
    'IMAGE_TOO_LARGE','EMPTY_IMAGE','INVALID_ATTACHMENT','OBJECT_CHANGED','IMAGE_INSPECTION_BUSY','IMAGE_INSPECTION_TIMEOUT',
    'IMAGE_INSPECTION_ABORTED','IMAGE_INSPECTION_FAILED','OBJECT_DOWNLOAD_FAILED','FINALIZATION_FAILED','STALE_PARENT') then
    raise exception 'Unsupported safe object error code' using errcode='PT422'; end if;
  select * into v_row from public.private_object_uploads where id=p_intent_id for update;
  if not found or v_row.status<>'validating' or p_claim_id is null or v_row.claim_id is distinct from p_claim_id then
    raise exception 'Upload validation claim changed' using errcode='PT409'; end if;
  v_retry:=p_code in ('OBJECT_MISSING','IMAGE_INSPECTION_BUSY','IMAGE_INSPECTION_TIMEOUT','IMAGE_INSPECTION_ABORTED',
    'IMAGE_INSPECTION_FAILED','OBJECT_DOWNLOAD_FAILED','FINALIZATION_FAILED') and v_row.expires_at>clock_timestamp();
  perform public.private_object_cap('private_object_uploads',v_row.id,v_row.operation_id);
  update public.private_object_uploads set status=case when v_retry then 'pending' else 'cleanup_required' end,
    error_code=p_code,claim_id=null,lease_expires_at=null where id=v_row.id returning * into v_row;
  perform public.private_object_clear_caps();
  return public.private_object_upload_result(v_row);
end;
$$;

create function public.private_object_binding_access(p_binding uuid,p_actor uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_bindings%rowtype; v_actor public.profiles%rowtype;
begin
  select * into v_row from public.private_object_bindings where id=p_binding and state='finalized';
  if not found then return false; end if;
  select * into v_actor from public.profiles where id=p_actor and active;
  if not found then return false; end if;
  if not public.private_object_actor_access(p_actor,v_row.work_order_id,false) then return false; end if;
  if v_row.purpose='photo' then
    return exists(select 1 from public.photos p join public.work_orders w on w.id=p.work_order_id
      where p.id=v_row.photo_id and p.work_order_id=v_row.work_order_id and p.storage_path=v_row.object_path
        and (v_actor.role in ('manager','dispatcher','back_office')
          or p.created_at>=coalesce(w.contractor_assignment_started_at,'infinity'::timestamptz)));
  elsif v_row.purpose in ('invoice_original','invoice_generated') then
    return exists(select 1 from public.invoices i join public.work_orders w on w.id=i.work_order_id
      where i.id=v_row.parent_id and i.work_order_id=v_row.work_order_id and i.pdf_storage_path=v_row.object_path
        and i.deleted_at is null and (
          (v_actor.role in ('manager','dispatcher','back_office') and
            (not public.profile_has_staff_permission(p_actor,'invoice_controller') or i.invoice_type='staff' or i.state in ('approved','paid')))
          or (v_actor.role='contractor' and i.invoice_type='contractor' and i.contractor_id=w.contractor_id
            and public.private_object_actor_access(p_actor,w.id,true)
            and i.created_at>=coalesce(w.contractor_assignment_started_at,'infinity'::timestamptz))));
  end if;
  return exists(select 1 from public.contractor_estimate_attachments a
    join public.contractor_estimates e on e.id=a.estimate_id join public.work_orders w on w.id=e.work_order_id
    where a.id=v_row.attachment_id and a.estimate_id=v_row.parent_id and a.storage_path=v_row.object_path
      and a.deleted_at is null and a.contractor_id=e.contractor_id
      and a.contractor_assignment_version=e.contractor_assignment_version
      and ((v_actor.role in ('manager','dispatcher','back_office') and not public.profile_has_staff_permission(p_actor,'invoice_controller'))
        or (v_actor.role='contractor' and public.private_object_actor_access(p_actor,w.id,true)
          and e.contractor_id=w.contractor_id and e.contractor_assignment_version=w.contractor_assignment_version)));
end;
$$;

create function public.resolve_private_object_binding_v1(p_purpose text,p_metadata_id uuid,p_operation_id uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_bindings%rowtype;
begin
  select * into v_row from public.private_object_bindings b where b.purpose=p_purpose
    and case when p_purpose='photo' then b.photo_id=p_metadata_id when p_purpose='estimate_attachment' then b.attachment_id=p_metadata_id
      else b.parent_id=p_metadata_id and exists(select 1 from public.invoices i where i.id=p_metadata_id and i.pdf_storage_path=b.object_path) end
    and (b.state='finalized' or exists(select 1 from public.private_object_deletions d
      where d.binding_id=b.id and d.operation_id=p_operation_id and d.actor_id=auth.uid()));
  if not found or not exists(select 1 from public.profiles where id=auth.uid() and active)
    or (not public.private_object_binding_access(v_row.id,auth.uid()) and not exists(select 1 from public.private_object_deletions d
      where d.binding_id=v_row.id and d.operation_id=p_operation_id and d.actor_id=auth.uid())) then
    raise exception 'Verified object is not available' using errcode='42501'; end if;
  return jsonb_build_object('bindingId',v_row.id,'purpose',v_row.purpose,'workOrderId',v_row.work_order_id,
    'parentId',v_row.parent_id,'photoId',v_row.photo_id,'attachmentId',v_row.attachment_id,
    'bucket',v_row.bucket,'objectPath',v_row.object_path);
end;
$$;

create function public.get_verified_invoice_object_v1(p_invoice_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_bindings%rowtype;
begin
  perform public.require_private_object_service();
  select b.* into v_row from public.private_object_bindings b join public.invoices i on i.id=b.parent_id
    where i.id=p_invoice_id and i.deleted_at is null and b.work_order_id=i.work_order_id
      and b.object_path=i.pdf_storage_path and b.purpose in ('invoice_original','invoice_generated')
      and b.state='finalized';
  if not found then raise exception 'Verified invoice PDF is unavailable' using errcode='P0002'; end if;
  return jsonb_build_object('bucket',v_row.bucket,'objectPath',v_row.object_path,'bindingId',v_row.id);
end;
$$;

create function public.private_object_deletion_result(p_row public.private_object_deletions)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('deletionId',p_row.id,'operationId',p_row.operation_id,'bindingId',b.id,
    'photoId',b.photo_id,'attachmentId',b.attachment_id,'purpose',b.purpose,
    'bucket',b.bucket,'objectPath',b.object_path,'status',case when p_row.status='completed' then 'deleted' else p_row.status end,'claimId',p_row.claim_id)
  from public.private_object_bindings b where b.id=p_row.binding_id;
$$;

create function public.request_private_object_delete_v1(p_binding_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_binding public.private_object_bindings%rowtype; v_delete public.private_object_deletions%rowtype;
  v_upload public.private_object_uploads%rowtype; v_actor public.profiles%rowtype; v_wo public.work_orders%rowtype;
begin
  if p_operation_id is null or auth.uid() is null then raise exception 'Deletion identity required' using errcode='PT422'; end if;
  select * into v_actor from public.profiles where id=auth.uid() and active;
  if not found then raise exception 'Active portal access required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('private-object-operation:'||p_operation_id::text,0));
  select * into v_binding from public.private_object_bindings where id=p_binding_id;
  if not found then raise exception 'Verified object not found' using errcode='P0002'; end if;
  select * into v_wo from public.work_orders where id=v_binding.work_order_id for update;
  select * into v_binding from public.private_object_bindings where id=p_binding_id for update;
  select * into v_delete from public.private_object_deletions where operation_id=p_operation_id for update;
  if found then
    if v_delete.binding_id<>p_binding_id or v_delete.actor_id<>auth.uid() then
      raise exception 'Deletion operation was reused' using errcode='PT409'; end if;
    return public.private_object_deletion_result(v_delete);
  end if;
  if exists(select 1 from public.private_object_uploads where operation_id=p_operation_id)
    or exists(select 1 from public.private_object_deletions where binding_id=p_binding_id) then
    raise exception 'Object deletion already has an operation' using errcode='PT409'; end if;
  if v_binding.purpose not in ('photo','estimate_attachment') then
    raise exception 'Invoice document history is retained' using errcode='PT422'; end if;
  if not public.private_object_binding_access(p_binding_id,auth.uid()) then
    raise exception 'Object deletion access denied' using errcode='42501'; end if;
  if v_binding.purpose='photo' then
    if v_actor.role='contractor' and not exists(select 1 from public.photos where id=v_binding.photo_id and uploader_id=auth.uid()) then
      raise exception 'Only the uploader or staff may remove this photo' using errcode='42501'; end if;
  else
    v_upload.actor_id:=auth.uid(); v_upload.purpose:='estimate_attachment'; v_upload.parent_id:=v_binding.parent_id;
    v_upload.work_order_id:=v_binding.work_order_id; v_upload.contractor_id:=v_wo.contractor_id;
    v_upload.assignment_version:=v_binding.assignment_version; v_upload.workflow_cycle:=v_wo.workflow_cycle;
    perform public.private_object_assert_target(v_upload,true);
  end if;
  v_delete.id:=gen_random_uuid();
  perform public.private_object_cap('private_object_deletions',v_delete.id,p_operation_id);
  insert into public.private_object_deletions(id,operation_id,binding_id,actor_id)
    values(v_delete.id,p_operation_id,p_binding_id,auth.uid()) returning * into v_delete;
  perform public.private_object_cap('private_object_bindings',p_binding_id,p_operation_id);
  update public.private_object_bindings set state='deletion_pending' where id=p_binding_id;
  perform public.private_object_clear_caps();
  return public.private_object_deletion_result(v_delete);
end;
$$;

create function public.claim_private_object_deletion_v1(p_deletion_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_deletions%rowtype; v_binding public.private_object_bindings%rowtype; v_object_id uuid;
begin
  perform public.require_private_object_service();
  select * into v_row from public.private_object_deletions where id=p_deletion_id for update;
  if not found then raise exception 'Deletion not found' using errcode='P0002'; end if;
  if v_row.status='completed' then return public.private_object_deletion_result(v_row); end if;
  if v_row.status='deleting' and v_row.lease_expires_at>clock_timestamp() then
    raise exception 'Deletion cleanup is already in progress' using errcode='PT409'; end if;
  if v_row.attempts>=10 then raise exception 'Deletion requires manual review after repeated attempts' using errcode='PT409'; end if;
  select * into v_binding from public.private_object_bindings where id=v_row.binding_id;
  select id into v_object_id from storage.objects where bucket_id=v_binding.bucket and name=v_binding.object_path;
  if found and v_object_id<>v_binding.storage_object_id then
    raise exception 'Bound object was replaced; manual review required' using errcode='PT409'; end if;
  perform public.private_object_cap('private_object_deletions',v_row.id,v_row.operation_id);
  update public.private_object_deletions set status='deleting',claim_id=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1 where id=v_row.id returning * into v_row;
  perform public.private_object_clear_caps();
  return public.private_object_deletion_result(v_row);
end;
$$;

create function public.complete_private_object_deletion_v1(p_deletion_id uuid,p_claim_id uuid,p_outcome text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_deletions%rowtype; v_binding public.private_object_bindings%rowtype;
begin
  perform public.require_private_object_service();
  if p_outcome is null or p_outcome not in ('deleted','absent','unknown','failed') then
    raise exception 'Unsupported deletion outcome' using errcode='PT422'; end if;
  select d.* into v_row from public.private_object_deletions d where d.id=p_deletion_id;
  if not found then raise exception 'Deletion not found' using errcode='P0002'; end if;
  select * into v_binding from public.private_object_bindings where id=v_row.binding_id;
  perform 1 from public.work_orders where id=v_binding.work_order_id for update;
  select * into v_binding from public.private_object_bindings where id=v_row.binding_id for update;
  select * into v_row from public.private_object_deletions where id=p_deletion_id for update;
  if p_claim_id is null or v_row.claim_id is distinct from p_claim_id then
    raise exception 'Deletion claim changed' using errcode='PT409'; end if;
  if v_row.status='completed' then
    if p_outcome not in ('deleted','absent') or v_binding.state<>'deleted' then
      raise exception 'Deletion replay is inconsistent' using errcode='PT409'; end if;
    return public.private_object_deletion_result(v_row);
  end if;
  if v_row.status<>'deleting' or v_row.lease_expires_at<=clock_timestamp() then
    raise exception 'Deletion claim expired' using errcode='PT409'; end if;
  perform public.private_object_cap('private_object_deletions',v_row.id,v_row.operation_id);
  if p_outcome in ('deleted','absent') then
    if exists(select 1 from storage.objects where bucket_id=v_binding.bucket and name=v_binding.object_path) then
      raise exception 'Object deletion is not confirmed' using errcode='PT409'; end if;
    if v_binding.purpose='photo' then
      perform public.private_object_cap('photos',v_binding.photo_id,v_row.operation_id);
      delete from public.photos where id=v_binding.photo_id;
      perform public.private_object_activity(v_binding.work_order_id,v_row.actor_id,'photo_removed','Photo removed.',
        jsonb_build_object('photoId',v_binding.photo_id,'bindingId',v_binding.id,'operationId',v_row.operation_id),v_row.operation_id);
    else
      perform public.private_object_cap('contractor_estimate_attachments',v_binding.attachment_id,v_row.operation_id);
      update public.contractor_estimate_attachments set deleted_at=clock_timestamp(),deleted_by=v_row.actor_id where id=v_binding.attachment_id;
      perform public.private_object_activity(v_binding.work_order_id,v_row.actor_id,'contractor_estimate_attachment_removed','Equipment form removed.',
        jsonb_build_object('estimateId',v_binding.parent_id,'attachmentId',v_binding.attachment_id,'bindingId',v_binding.id,'operationId',v_row.operation_id),v_row.operation_id);
    end if;
    perform public.private_object_cap('private_object_bindings',v_binding.id,v_row.operation_id);
    update public.private_object_bindings set state='deleted',deleted_at=clock_timestamp() where id=v_binding.id;
    update public.private_object_deletions set status='completed',outcome=p_outcome,completed_at=clock_timestamp()
      where id=v_row.id returning * into v_row;
  else
    update public.private_object_deletions set status=p_outcome,outcome=p_outcome,lease_expires_at=null
      where id=v_row.id returning * into v_row;
  end if;
  perform public.private_object_clear_caps();
  return public.private_object_deletion_result(v_row);
end;
$$;

create function public.claim_private_object_upload_cleanup_v1(p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_uploads%rowtype; v_object storage.objects%rowtype; v_binding public.private_object_bindings%rowtype;
begin
  perform public.require_private_object_service();
  select * into v_row from public.private_object_uploads where id=p_intent_id;
  if not found then raise exception 'Upload not found' using errcode='P0002'; end if;
  perform 1 from public.work_orders where id=v_row.work_order_id for update;
  if v_row.purpose in ('invoice_original','invoice_generated') then
    perform 1 from public.invoices where id=v_row.parent_id for update;
  end if;
  select * into v_row from public.private_object_uploads where id=p_intent_id for update;
  if v_row.binding_id is not null then
    select * into v_binding from public.private_object_bindings where id=v_row.binding_id for update;
  end if;
  if v_row.status='cleaned' and not exists(select 1 from storage.objects where bucket_id=v_row.bucket and name=v_row.object_path) then
    return public.private_object_upload_result(v_row); end if;
  if v_row.status='finalized' and v_row.expires_at<=clock_timestamp()
    and v_row.purpose in ('invoice_original','invoice_generated') and v_binding.source_intent_id=v_row.id
    and v_binding.state='finalized' and v_binding.attached_at is null
    and not exists(select 1 from public.invoices where pdf_storage_path=v_row.object_path) then
    perform public.private_object_cap('private_object_bindings',v_binding.id,v_row.operation_id);
    update public.private_object_bindings set state='deletion_pending' where id=v_binding.id;
    perform public.private_object_cap('private_object_uploads',v_row.id,v_row.operation_id);
    update public.private_object_uploads set status='cleanup_required',error_code='UNATTACHED_EXPIRED',lease_expires_at=null
      where id=v_row.id returning * into v_row;
  end if;
  if v_row.status='finalized' or (v_row.binding_id is not null and not exists(
    select 1 from public.private_object_bindings b where b.id=v_row.binding_id and b.source_intent_id=v_row.id
      and b.state='deletion_pending' and b.attached_at is null and b.purpose in ('invoice_original','invoice_generated')
      and not exists(select 1 from public.invoices i where i.pdf_storage_path=b.object_path)))
    or (v_row.binding_id is null and exists(select 1 from public.private_object_bindings where bucket=v_row.bucket and object_path=v_row.object_path))
    or (v_row.status in ('pending','validating') and v_row.expires_at>clock_timestamp()) then
    raise exception 'Upload is not eligible for cleanup' using errcode='PT409'; end if;
  if v_row.lease_expires_at>clock_timestamp() then raise exception 'Cleanup is already leased' using errcode='PT409'; end if;
  if v_row.attempts>=10 then raise exception 'Cleanup requires manual review after repeated attempts' using errcode='PT409'; end if;
  select * into v_object from storage.objects where bucket_id=v_row.bucket and name=v_row.object_path;
  if found and ((v_row.storage_object_id is not null and v_row.storage_object_id<>v_object.id)
    or coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),v_object.owner::text) is distinct from v_row.actor_id::text) then
    raise exception 'Cleanup object identity changed; manual review required' using errcode='PT409'; end if;
  perform public.private_object_cap('private_object_uploads',v_row.id,v_row.operation_id);
  update public.private_object_uploads set status='cleanup_required',claim_id=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+interval '2 minutes',attempts=attempts+1,
    storage_object_id=coalesce(storage_object_id,v_object.id) where id=v_row.id returning * into v_row;
  perform public.private_object_clear_caps();
  return public.private_object_upload_result(v_row);
end;
$$;

create function public.complete_private_object_upload_cleanup_v1(p_intent_id uuid,p_claim_id uuid,p_outcome text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_uploads%rowtype;
begin
  perform public.require_private_object_service();
  if p_outcome is null or p_outcome not in ('deleted','absent','unknown','failed') then
    raise exception 'Unsupported cleanup outcome' using errcode='PT422'; end if;
  select * into v_row from public.private_object_uploads where id=p_intent_id for update;
  if not found or p_claim_id is null or v_row.claim_id is distinct from p_claim_id then
    raise exception 'Cleanup claim changed' using errcode='PT409'; end if;
  if v_row.status='cleaned' and p_outcome in ('deleted','absent') then return public.private_object_upload_result(v_row); end if;
  if v_row.status<>'cleanup_required' or v_row.lease_expires_at<=clock_timestamp() then
    raise exception 'Cleanup claim expired' using errcode='PT409'; end if;
  if p_outcome in ('deleted','absent') and exists(select 1 from storage.objects where bucket_id=v_row.bucket and name=v_row.object_path) then
    raise exception 'Object cleanup is not confirmed' using errcode='PT409'; end if;
  perform public.private_object_cap('private_object_uploads',v_row.id,v_row.operation_id);
  if v_row.binding_id is not null and p_outcome in ('deleted','absent') then
    perform public.private_object_cap('private_object_bindings',v_row.binding_id,v_row.operation_id);
    update public.private_object_bindings set state='deleted',deleted_at=clock_timestamp()
      where id=v_row.binding_id and state='deletion_pending' and attached_at is null;
    if not found then raise exception 'Unattached object cleanup changed' using errcode='PT409'; end if;
  end if;
  update public.private_object_uploads set status=case when p_outcome in ('deleted','absent') then 'cleaned' else 'cleanup_required' end,
    lease_expires_at=null,error_code=case when p_outcome in ('deleted','absent') then null else 'CLEANUP_'||upper(p_outcome) end
    where id=v_row.id returning * into v_row;
  perform public.private_object_clear_caps();
  return public.private_object_upload_result(v_row);
end;
$$;

create function public.list_private_object_reconciliation_v1(p_limit integer,p_dry_run boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_result jsonb;
begin
  perform public.require_private_object_service();
  if p_limit is null or p_limit not between 1 and 100 or p_dry_run is null then
    raise exception 'Explicit bounded reconciliation request required' using errcode='PT422'; end if;
  -- Listing is always read-only. A non-dry worker must subsequently claim each
  -- known record and may never enumerate or delete arbitrary bucket objects.
  select coalesce(jsonb_agg(item),'[]'::jsonb) into v_result from (
    select jsonb_build_object('kind',kind,'id',id,'status',status,'bucket',bucket,'objectPath',object_path) item from (
      select 'upload'::text kind,u.id,u.status,u.bucket,u.object_path,u.created_at from public.private_object_uploads u
        where u.attempts<10
          and (u.binding_id is null or exists(select 1 from public.private_object_bindings b where b.id=u.binding_id
            and b.attached_at is null and b.purpose in ('invoice_original','invoice_generated')
            and (b.state='deletion_pending' or (b.state='finalized' and u.status='finalized' and u.expires_at<=clock_timestamp()))
            and not exists(select 1 from public.invoices i where i.pdf_storage_path=b.object_path)))
          and (u.status in ('cleanup_required','cancelled','expired') or (u.status in ('pending','validating') and u.expires_at<=clock_timestamp())
            or (u.status='finalized' and u.expires_at<=clock_timestamp())
            or (u.status='cleaned' and exists(select 1 from storage.objects o where o.bucket_id=u.bucket and o.name=u.object_path)))
          and (u.lease_expires_at is null or u.lease_expires_at<=clock_timestamp())
      union all
      select 'deletion',d.id,d.status,b.bucket,b.object_path,d.created_at from public.private_object_deletions d
        join public.private_object_bindings b on b.id=d.binding_id where d.status<>'completed' and d.attempts<10
          and (d.lease_expires_at is null or d.lease_expires_at<=clock_timestamp())
    ) eligible order by created_at,id limit p_limit
  ) pending;
  return v_result;
end;
$$;

create function public.guard_private_object_metadata()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_enforced boolean; v_id uuid; v_path text; v_protected boolean; v_binding public.private_object_bindings%rowtype;
begin
  if public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  select enforced into v_enforced from public.private_object_control where singleton;
  v_id:=case when tg_op='DELETE' then old.id else new.id end;
  if tg_table_name='invoices' then
    if tg_op='DELETE' then return old; end if;
    v_path:=new.pdf_storage_path;
    if v_path is null then return new; end if;
    if v_enforced or exists(select 1 from public.private_object_bindings where bucket='invoice-pdfs' and object_path=v_path) then
      select * into v_binding from public.private_object_bindings b where b.bucket='invoice-pdfs' and b.object_path=v_path
        and b.parent_id=new.id and b.work_order_id=new.work_order_id and b.purpose in ('invoice_original','invoice_generated')
        and b.state='finalized' for update;
      if not found then
        raise exception 'Invoice PDF requires a verified parent binding' using errcode='42501'; end if;
      if tg_op='UPDATE' and new.pdf_storage_path is distinct from old.pdf_storage_path
        and v_binding.source_intent_id is not null and not exists(select 1 from public.private_object_uploads u
          where u.id=v_binding.source_intent_id and u.parent_version=old.invoice_version) then
        raise exception 'Invoice changed after attachment validation' using errcode='PT409'; end if;
      if v_binding.attached_at is null then
        perform public.private_object_cap('private_object_bindings',v_binding.id,null);
        update public.private_object_bindings set attached_at=clock_timestamp() where id=v_binding.id;
        delete from public.private_object_transition_guards where transaction_id=txid_current()
          and relation_name='private_object_bindings' and target_id=v_binding.id;
      end if;
    end if;
    return new;
  end if;
  v_path:=case when tg_op='DELETE' then old.storage_path else new.storage_path end;
  v_protected:=v_enforced or exists(select 1 from public.private_object_bindings b where b.object_path=v_path
    and (b.photo_id=v_id or b.attachment_id=v_id or b.bucket=case when tg_table_name='photos' then 'photos' else 'contractor-estimate-attachments' end));
  if v_protected and not public.private_object_cap_valid(tg_table_name,v_id) then
    raise exception 'Verified object command required' using errcode='42501'; end if;
  if tg_op='UPDATE' and not public.private_object_cap_valid(tg_table_name,old.id)
    and exists(select 1 from public.private_object_bindings where photo_id=old.id or attachment_id=old.id) then
    raise exception 'Verified object binding cannot be changed' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
create trigger private_photo_metadata_guard before insert or update or delete on public.photos
  for each row execute function public.guard_private_object_metadata();
create trigger private_invoice_object_guard before insert or update of pdf_storage_path,work_order_id on public.invoices
  for each row execute function public.guard_private_object_metadata();
create trigger private_estimate_object_guard before insert or update or delete on public.contractor_estimate_attachments
  for each row execute function public.guard_private_object_metadata();

create function public.guard_private_object_activity()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_enforced boolean; v_old_owned boolean:=false; v_new_owned boolean:=false;
begin
  if public.lifecycle_is_owner_maintenance() then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  select enforced into v_enforced from public.private_object_control where singleton;
  if tg_op<>'INSERT' then
    v_old_owned:=old.event_key in ('photo_added','photo_removed','contractor_estimate_attachment_added','contractor_estimate_attachment_removed')
      and (v_enforced or old.event_data ? 'bindingId' or old.event_data ? 'batchId');
  end if;
  if tg_op<>'DELETE' then
    v_new_owned:=new.event_key in ('photo_added','photo_removed','contractor_estimate_attachment_added','contractor_estimate_attachment_removed')
      and (v_enforced or new.event_data ? 'bindingId' or new.event_data ? 'batchId');
  end if;
  if tg_op='UPDATE' and v_old_owned and old.event_key='photo_added'
    and public.private_object_cap_valid('activities',old.id)
    and (to_jsonb(new)-array['text','event_data'])=(to_jsonb(old)-array['text','event_data'])
    and exists(select 1 from public.private_object_photo_batches b where b.activity_id=old.id
      and b.id::text=old.event_data->>'batchId' and b.id::text=new.event_data->>'batchId'
      and b.actor_id=old.author_id and b.work_order_id=old.work_order_id) then return new; end if;
  if tg_op<>'INSERT' and v_old_owned then raise exception 'Object evidence is immutable' using errcode='42501'; end if;
  if v_new_owned and (tg_op<>'INSERT' or not public.private_object_cap_valid('activities',new.id)) then
    raise exception 'Object evidence requires its owning command' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
create trigger private_object_activity_guard before insert or update or delete on public.activities
  for each row execute function public.guard_private_object_activity();

create function public.register_verified_legacy_object_v1(p_purpose text,p_metadata_id uuid,p_object_id uuid,p_review_reference text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_object storage.objects%rowtype; v_wo public.work_orders%rowtype; v_id uuid:=gen_random_uuid();
  v_parent uuid; v_photo uuid; v_attachment uuid; v_work_order text; v_actor uuid; v_path text; v_bucket text;
  v_existing public.private_object_bindings%rowtype;
begin
  if not public.lifecycle_is_owner_maintenance() then raise exception 'Explicit database-owner review required' using errcode='42501'; end if;
  if p_review_reference is null or length(btrim(p_review_reference)) not between 1 and 500 then
    raise exception 'External verification reference required' using errcode='PT422'; end if;
  if p_purpose='photo' then
    select work_order_id,uploader_id,storage_path into v_work_order,v_actor,v_path from public.photos where id=p_metadata_id;
    v_photo:=p_metadata_id; v_bucket:='photos';
  elsif p_purpose in ('invoice_original','invoice_generated') then
    select work_order_id,created_by,pdf_storage_path into v_work_order,v_actor,v_path from public.invoices where id=p_metadata_id and deleted_at is null;
    v_parent:=p_metadata_id; v_bucket:='invoice-pdfs';
  elsif p_purpose='estimate_attachment' then
    select e.work_order_id,a.uploaded_by,a.storage_path,a.estimate_id into v_work_order,v_actor,v_path,v_parent
      from public.contractor_estimate_attachments a join public.contractor_estimates e on e.id=a.estimate_id
      where a.id=p_metadata_id and a.deleted_at is null;
    v_attachment:=p_metadata_id; v_bucket:='contractor-estimate-attachments';
  else raise exception 'Unsupported legacy purpose' using errcode='PT422'; end if;
  if v_work_order is null or v_actor is null or v_path is null then
    raise exception 'Legacy identity requires manual investigation' using errcode='PT409'; end if;
  select * into v_wo from public.work_orders where id=v_work_order for update;
  if not found or v_wo.deleted_at is not null then raise exception 'Legacy parent requires review' using errcode='PT409'; end if;
  select * into v_object from storage.objects where id=p_object_id and bucket_id=v_bucket and name=v_path for share;
  if not found or (p_purpose='photo' and (split_part(v_path,'/',1)<>'wo' or split_part(v_path,'/',2)<>v_work_order))
    or (p_purpose<>'photo' and split_part(v_path,'/',1)<>v_parent::text) then
    raise exception 'Legacy object does not match its canonical parent' using errcode='PT409'; end if;
  if (p_purpose='photo' and (select count(*) from public.photos where storage_path=v_path)<>1)
    or (p_purpose in ('invoice_original','invoice_generated') and (select count(*) from public.invoices where pdf_storage_path=v_path)<>1)
    or (p_purpose='estimate_attachment' and (select count(*) from public.contractor_estimate_attachments where storage_path=v_path)<>1) then
    raise exception 'Ambiguous legacy object requires manual investigation' using errcode='PT409'; end if;
  select * into v_existing from public.private_object_bindings where bucket=v_bucket and object_path=v_path;
  if found then
    if v_existing.storage_object_id<>p_object_id or v_existing.purpose<>p_purpose
      or v_existing.photo_id is distinct from v_photo or v_existing.parent_id is distinct from v_parent
      or v_existing.attachment_id is distinct from v_attachment or v_existing.review_reference is distinct from btrim(p_review_reference) then
      raise exception 'Legacy review binding is immutable' using errcode='PT409'; end if;
    return jsonb_build_object('bindingId',v_existing.id,'validation',v_existing.validation);
  end if;
  insert into public.private_object_bindings(id,bucket,object_path,storage_object_id,purpose,work_order_id,parent_id,
    photo_id,attachment_id,actor_id,assignment_version,workflow_cycle,validation,review_reference,attached_at)
  values(v_id,v_bucket,v_path,p_object_id,p_purpose,v_work_order,v_parent,v_photo,v_attachment,v_actor,
    v_wo.contractor_assignment_version,v_wo.workflow_cycle,'legacy_reviewed',btrim(p_review_reference),clock_timestamp());
  return jsonb_build_object('bindingId',v_id,'validation','legacy_reviewed');
end;
$$;

create function public.private_object_storage_read(p_bucket text,p_path text,p_object_id uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.private_object_bindings b where b.bucket=p_bucket and b.object_path=p_path
    and b.storage_object_id=p_object_id and public.private_object_binding_access(b.id,auth.uid()));
$$;
create function public.private_object_storage_insert(p_bucket text,p_path text,p_owner text)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v_row public.private_object_uploads%rowtype; v_wo public.work_orders%rowtype;
begin
  if auth.uid() is null or p_owner is distinct from auth.uid()::text then return false; end if;
  select * into v_row from public.private_object_uploads where bucket=p_bucket and object_path=p_path
    and actor_id=auth.uid() and status='pending' and expires_at>clock_timestamp();
  if not found or not public.private_object_actor_access(auth.uid(),v_row.work_order_id,v_row.purpose<>'photo') then return false; end if;
  select * into v_wo from public.work_orders where id=v_row.work_order_id;
  return v_wo.contractor_assignment_version=v_row.assignment_version and v_wo.workflow_cycle=v_row.workflow_cycle
    and v_wo.contractor_id is not distinct from v_row.contractor_id;
end;
$$;

create function public.private_object_metadata_read(p_purpose text,p_metadata uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from public.private_object_bindings b where b.purpose=p_purpose
    and case when p_purpose='photo' then b.photo_id=p_metadata else b.attachment_id=p_metadata end
    and public.private_object_binding_access(b.id,auth.uid()));
$$;

-- No broad default EXECUTE: enumerate this migration's routines and then grant
-- only the public browser command surface or the restricted service surface.
do $grants$
declare v_function record;
begin
  for v_function in select p.oid::regprocedure identity from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'private_object_%' or p.proname in (
      'guard_private_object_records','require_private_object_service','begin_private_object_upload',
      'begin_work_order_photo_upload_v1','begin_contractor_attachment_upload_v1','get_private_object_upload_v1',
      'claim_private_object_upload_v1','cancel_private_object_upload_v1','finalize_private_object_upload_v1',
      'fail_private_object_upload_v1','resolve_private_object_binding_v1','get_verified_invoice_object_v1',
      'request_private_object_delete_v1','claim_private_object_deletion_v1','complete_private_object_deletion_v1',
      'claim_private_object_upload_cleanup_v1','complete_private_object_upload_cleanup_v1',
      'list_private_object_reconciliation_v1','guard_private_object_metadata','guard_private_object_activity',
      'register_verified_legacy_object_v1'))
  loop execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function.identity); end loop;
end;
$grants$;
grant execute on function public.begin_work_order_photo_upload_v1(text,uuid,uuid,integer,integer,jsonb),
  public.begin_contractor_attachment_upload_v1(uuid,text,uuid,jsonb),public.get_private_object_upload_v1(uuid),
  public.claim_private_object_upload_v1(uuid),public.cancel_private_object_upload_v1(uuid),
  public.resolve_private_object_binding_v1(text,uuid,uuid),public.request_private_object_delete_v1(uuid,uuid)
  to authenticated;
grant execute on function public.finalize_private_object_upload_v1(uuid,uuid,jsonb),
  public.fail_private_object_upload_v1(uuid,uuid,text),public.claim_private_object_deletion_v1(uuid),
  public.complete_private_object_deletion_v1(uuid,uuid,text),public.claim_private_object_upload_cleanup_v1(uuid),
  public.complete_private_object_upload_cleanup_v1(uuid,uuid,text),public.list_private_object_reconciliation_v1(integer,boolean),
  public.get_verified_invoice_object_v1(uuid) to service_role;
grant execute on function public.private_object_storage_read(text,text,uuid),
  public.private_object_storage_insert(text,text,text),public.private_object_metadata_read(text,uuid) to authenticated;
-- Additive during expansion so new estimate uploads do not depend on the
-- legacy profile-name-shadowed INSERT policy. 0132 replaces all old policies.
create policy canonical_pending_private_object_insert on storage.objects for insert to authenticated
  with check(bucket_id in ('photos','invoice-pdfs','contractor-estimate-attachments')
    and public.private_object_storage_insert(bucket_id,name,
      coalesce(nullif(to_jsonb(objects)->>'owner_id',''),owner::text)));
-- Application identities never install triggers or foreign-key references on
-- command-owned metadata/evidence, including during expansion. Legacy web DML
-- remains available until 0132; application DDL is not a compatibility path.
revoke trigger,references on public.photos,public.contractor_estimate_attachments,public.activities
  from public,anon,authenticated,service_role;
commit;
