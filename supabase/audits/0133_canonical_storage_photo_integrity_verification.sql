-- Read-only, counts/catalog identifiers only. Run after 0131 and again after
-- 0132, as an authorized audit identity able to inspect these private tables.
-- No customer text, file paths, filenames, binary data, repair, movement,
-- deletion, or automatic legacy trust assignment. No routine below mutates.
-- Storage catalog rows are not proof of physical provider-object existence;
-- real Storage/JWT access and exact-byte decoding remain separate checks.
-- A nonzero review count is not automatic permission to alter historical data.
select 'unreviewed_active_photos' as check_name,count(*) as record_count
from public.photos p join public.work_orders w on w.id=p.work_order_id
where w.deleted_at is null and not exists(select 1 from public.private_object_bindings b
  where b.photo_id=p.id and b.purpose='photo' and b.object_path=p.storage_path and b.work_order_id=p.work_order_id and b.state in ('finalized','deletion_pending'))
union all
select 'unreviewed_active_invoice_pdfs',count(*) from public.invoices i where i.deleted_at is null and i.pdf_storage_path is not null
  and not exists(select 1 from public.private_object_bindings b where b.parent_id=i.id and b.object_path=i.pdf_storage_path
    and b.work_order_id=i.work_order_id and b.purpose in ('invoice_original','invoice_generated') and b.state='finalized')
union all
select 'unreviewed_active_estimate_attachments',count(*) from public.contractor_estimate_attachments a where a.deleted_at is null
  and not exists(select 1 from public.private_object_bindings b where b.attachment_id=a.id and b.parent_id=a.estimate_id
    and b.object_path=a.storage_path and b.purpose='estimate_attachment' and b.state in ('finalized','deletion_pending'))
union all
select 'duplicate_photo_object_references',count(*) from (select storage_path from public.photos group by storage_path having count(*)>1) d
union all
select 'duplicate_invoice_object_references',count(*) from (select pdf_storage_path from public.invoices where pdf_storage_path is not null
  group by pdf_storage_path having count(*)>1) d
union all
select 'duplicate_estimate_object_references',count(*) from (select storage_path from public.contractor_estimate_attachments
  group by storage_path having count(*)>1) d
union all
select 'cross_parent_photo_paths',count(*) from public.photos where split_part(storage_path,'/',1)<>'wo'
  or split_part(storage_path,'/',2)<>work_order_id
union all
select 'cross_parent_invoice_paths',count(*) from public.invoices where pdf_storage_path is not null
  and split_part(pdf_storage_path,'/',1)<>id::text
union all
select 'cross_parent_estimate_paths',count(*) from public.contractor_estimate_attachments
  where split_part(storage_path,'/',1)<>estimate_id::text
union all
select 'missing_or_replaced_bound_object_rows',count(*) from public.private_object_bindings b where b.state='finalized'
  and not exists(select 1 from storage.objects o where o.id=b.storage_object_id and o.bucket_id=b.bucket and o.name=b.object_path)
union all
select 'pending_uploads_expired',count(*) from public.private_object_uploads where status in ('pending','validating') and expires_at<clock_timestamp()
union all
select 'cleanup_required_uploads',count(*) from public.private_object_uploads where status='cleanup_required'
union all
select 'unresolved_object_deletions',count(*) from public.private_object_deletions where status<>'completed'
union all
select 'finalized_upload_missing_binding',count(*) from public.private_object_uploads u where u.status='finalized'
  and not exists(select 1 from public.private_object_bindings b where b.id=u.binding_id and b.source_intent_id=u.id)
union all
select 'deleted_binding_missing_completed_deletion',count(*) from public.private_object_bindings b where b.state='deleted' and b.attached_at is not null
  and not exists(select 1 from public.private_object_deletions d where d.binding_id=b.id and d.status='completed')
union all
select 'legacy_reviews_missing_reference',count(*) from public.private_object_bindings where validation='legacy_reviewed'
  and nullif(btrim(review_reference),'') is null
union all
select 'unattached_invoice_reservations_requiring_review',count(*) from public.private_object_bindings b
  where b.purpose in ('invoice_original','invoice_generated') and b.attached_at is null and b.state='finalized'
union all
select 'exhausted_upload_attempts_manual_review',count(*) from public.private_object_uploads where attempts>=10 and status not in ('finalized','cleaned')
union all
select 'exhausted_deletion_attempts_manual_review',count(*) from public.private_object_deletions where attempts>=10 and status<>'completed';

-- These are HEURISTICS over legacy metadata/path suffixes, NOT byte inspection
-- or invalid-format findings. Existing HEIC/HEIF/BMP files are not rejected by
-- this audit. MIME and suffix counts can overlap or disagree; neither is trusted.
-- Exclude known new upload intents from the historical-format inventory.
with legacy_photos as (
  select lower(coalesce(o.metadata->>'mimetype',o.metadata->>'contentType',o.metadata->>'content_type','')) as declared_mime,
    lower(o.name) as object_path
  from storage.objects o where o.bucket_id='photos'
    and not exists(select 1 from public.private_object_uploads u where u.bucket=o.bucket_id and u.object_path=o.name)
)
select 'legacy_photo_heic_metadata_or_suffix_only' as check_name,count(*) as record_count from legacy_photos
  where declared_mime in ('image/heic','image/heic-sequence') or object_path ~ '\.heic$'
union all
select 'legacy_photo_heif_metadata_or_suffix_only',count(*) from legacy_photos
  where declared_mime in ('image/heif','image/heif-sequence') or object_path ~ '\.heif$'
union all
select 'legacy_photo_bmp_metadata_or_suffix_only',count(*) from legacy_photos
  where declared_mime in ('image/bmp','image/x-bmp','image/x-ms-bmp') or object_path ~ '\.bmp$'
union all
select 'legacy_photo_octet_stream_metadata_only',count(*) from legacy_photos where declared_mime='application/octet-stream'
union all
select 'legacy_photo_missing_mime_metadata',count(*) from legacy_photos where declared_mime='';

-- Text-reference anomalies are review signals, not proof that equal names in
-- different buckets describe the same bytes. Include soft-deleted financial
-- references here: their retained document history is not an orphan by default.
with metadata_references as (
  select 'photo'::text purpose,'photos'::text bucket,p.storage_path object_path from public.photos p
  union all
  select 'invoice_document','invoice-pdfs',i.pdf_storage_path from public.invoices i where i.pdf_storage_path is not null
  union all
  select 'estimate_attachment','contractor-estimate-attachments',a.storage_path from public.contractor_estimate_attachments a
), private_objects as (
  select o.id,o.bucket_id,o.name from storage.objects o
    where o.bucket_id in ('photos','invoice-pdfs','contractor-estimate-attachments')
)
select 'metadata_references_missing_storage_catalog_object' as check_name,count(*) as record_count
  from metadata_references r where not exists(select 1 from private_objects o where o.bucket_id=r.bucket and o.name=r.object_path)
union all
select 'orphan_objects_without_metadata_intent_or_binding',count(*) from private_objects o
  where not exists(select 1 from metadata_references r where r.bucket=o.bucket_id and r.object_path=o.name)
    and not exists(select 1 from public.private_object_uploads u where u.bucket=o.bucket_id and u.object_path=o.name)
    and not exists(select 1 from public.private_object_bindings b where b.bucket=o.bucket_id and b.object_path=o.name)
union all
select 'objects_without_metadata_or_upload_intent',count(*) from private_objects o
  where not exists(select 1 from metadata_references r where r.bucket=o.bucket_id and r.object_path=o.name)
    and not exists(select 1 from public.private_object_uploads u where u.bucket=o.bucket_id and u.object_path=o.name)
union all
select 'cross_purpose_identical_text_references_review_only',count(*) from (
  select object_path from metadata_references group by object_path having count(distinct purpose)>1
) duplicated
union all
select 'cross_bucket_missing_reference_found_in_other_bucket_review_only',count(*) from metadata_references r
  where not exists(select 1 from private_objects o where o.bucket_id=r.bucket and o.name=r.object_path)
    and exists(select 1 from private_objects o where o.bucket_id<>r.bucket and o.name=r.object_path)
union all
select 'binding_purpose_bucket_mismatch',count(*) from public.private_object_bindings b
  where b.bucket<>case b.purpose when 'photo' then 'photos' when 'estimate_attachment' then 'contractor-estimate-attachments' else 'invoice-pdfs' end
union all
select 'upload_purpose_bucket_mismatch',count(*) from public.private_object_uploads u
  where u.bucket<>case u.purpose when 'photo' then 'photos' when 'estimate_attachment' then 'contractor-estimate-attachments' else 'invoice-pdfs' end
union all
select 'deletion_pending_binding_object_still_present',count(*) from public.private_object_bindings b
  where b.state='deletion_pending' and exists(select 1 from private_objects o where o.bucket_id=b.bucket and o.name=b.object_path)
union all
select 'deleted_binding_object_still_present',count(*) from public.private_object_bindings b
  where b.state='deleted' and exists(select 1 from private_objects o where o.bucket_id=b.bucket and o.name=b.object_path)
union all
select 'completed_deletion_object_still_present',count(*) from public.private_object_deletions d
  join public.private_object_bindings b on b.id=d.binding_id where d.status='completed'
    and exists(select 1 from private_objects o where o.bucket_id=b.bucket and o.name=b.object_path)
union all
select 'cleaned_upload_object_still_present',count(*) from public.private_object_uploads u
  where u.status='cleaned' and exists(select 1 from private_objects o where o.bucket_id=u.bucket and o.name=u.object_path)
union all
select 'deletion_pending_binding_without_deletion_or_reservation_cleanup',count(*) from public.private_object_bindings b
  where b.state='deletion_pending' and not exists(select 1 from public.private_object_deletions d where d.binding_id=b.id)
    and not exists(select 1 from public.private_object_uploads u where u.binding_id=b.id and u.id=b.source_intent_id
      and u.status in ('cleanup_required','cancelled','expired') and b.attached_at is null)
union all
select 'active_photo_binding_missing_matching_metadata',count(*) from public.private_object_bindings b
  where b.purpose='photo' and b.state='finalized' and not exists(select 1 from public.photos p
    where p.id=b.photo_id and p.storage_path=b.object_path and p.work_order_id=b.work_order_id)
union all
select 'active_estimate_binding_missing_matching_metadata',count(*) from public.private_object_bindings b
  where b.purpose='estimate_attachment' and b.state='finalized' and not exists(select 1 from public.contractor_estimate_attachments a
    join public.contractor_estimates e on e.id=a.estimate_id where a.id=b.attachment_id and a.estimate_id=b.parent_id
      and a.storage_path=b.object_path and e.work_order_id=b.work_order_id and a.deleted_at is null);

-- New attestations require a complete exact-byte receipt. Legacy reviews are
-- deliberately excluded: a human review reference is not a decoder attestation.
-- Numeric casts occur only for JSON numeric values, including malformed legacy
-- candidates, so this audit reports them rather than throwing while casting.
with facts as (
  select b.*,
    case when jsonb_typeof(b.inspection->'sizeBytes')='number' then (b.inspection->>'sizeBytes')::numeric end as inspected_size,
    case when jsonb_typeof(b.inspection->'width')='number' then (b.inspection->>'width')::numeric end as inspected_width,
    case when jsonb_typeof(b.inspection->'height')='number' then (b.inspection->>'height')::numeric end as inspected_height,
    case when jsonb_typeof(b.inspection->'frames')='number' then (b.inspection->>'frames')::numeric end as inspected_frames
  from public.private_object_bindings b where b.validation='new_validated'
)
select 'new_bindings_missing_or_invalid_validation_facts' as check_name,count(*) as record_count from facts b
  where jsonb_typeof(b.inspection) is distinct from 'object'
    or not coalesce(b.inspection ?& array['format','mimeType','extension','sizeBytes','sha256','width','height','frames'],false)
    or ((case when jsonb_typeof(b.inspection)='object' then b.inspection else '{}'::jsonb end)
      -array['format','mimeType','extension','sizeBytes','sha256','width','height','frames'])<>'{}'::jsonb
    or jsonb_typeof(b.inspection->'format') is distinct from 'string'
    or jsonb_typeof(b.inspection->'mimeType') is distinct from 'string'
    or jsonb_typeof(b.inspection->'extension') is distinct from 'string'
    or jsonb_typeof(b.inspection->'sha256') is distinct from 'string'
    or not coalesce((b.inspection->>'sha256') ~ '^[a-f0-9]{64}$',false)
    or b.inspected_size is null or b.inspected_size<>trunc(b.inspected_size) or b.inspected_size<1
    or (b.purpose='photo' and (b.inspected_size>10485760
      or b.inspected_width is null or b.inspected_height is null or b.inspected_frames is null
      or b.inspected_width<>trunc(b.inspected_width) or b.inspected_height<>trunc(b.inspected_height)
      or b.inspected_frames<>trunc(b.inspected_frames) or b.inspected_width not between 1 and 12000
      or b.inspected_height not between 1 and 12000 or b.inspected_frames not between 1 and 100
      or case when b.inspected_width between 1 and 12000 and b.inspected_height between 1 and 12000
        and b.inspected_frames between 1 and 100 then b.inspected_width*b.inspected_height*b.inspected_frames>40000000 else false end
      or not coalesce((b.inspection->>'format',b.inspection->>'mimeType',b.inspection->>'extension') in (
        ('jpeg','image/jpeg','jpg'),('jpeg','image/jpeg','jpeg'),('png','image/png','png'),('webp','image/webp','webp'),
        ('gif','image/gif','gif'),('tiff','image/tiff','tif'),('tiff','image/tiff','tiff')),false)))
    or (b.purpose<>'photo' and (b.inspection->'width' is distinct from 'null'::jsonb
      or b.inspection->'height' is distinct from 'null'::jsonb or b.inspection->'frames' is distinct from 'null'::jsonb))
    or (b.purpose in ('invoice_original','invoice_generated') and (b.inspected_size>5242880
      or (b.inspection->>'format',b.inspection->>'mimeType',b.inspection->>'extension') is distinct from ('pdf','application/pdf','pdf')))
    or (b.purpose='estimate_attachment' and (b.inspected_size>15728640
      or (b.inspection->>'format',b.inspection->>'mimeType',b.inspection->>'extension') is distinct from
        ('xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','xlsx')))
union all
select 'new_bindings_missing_or_inconsistent_upload_receipt',count(*) from facts b
  where not exists(select 1 from public.private_object_uploads u where u.id=b.source_intent_id and u.binding_id=b.id
    and u.bucket=b.bucket and u.object_path=b.object_path and u.work_order_id=b.work_order_id
    and u.parent_id is not distinct from b.parent_id and u.purpose=b.purpose and u.actor_id=b.actor_id
    and u.storage_object_id=b.storage_object_id and u.inspection=b.inspection
    and u.file->>'sha256'=b.inspection->>'sha256' and u.file->'sizeBytes'=b.inspection->'sizeBytes');

select 'photo_upload_missing_or_inconsistent_batch' as check_name,count(*) as record_count
from public.private_object_uploads u where u.purpose='photo' and not exists(
  select 1 from public.private_object_photo_batches b where b.id=u.batch_id and b.actor_id=u.actor_id
    and b.work_order_id=u.work_order_id and b.assignment_version=u.assignment_version and b.workflow_cycle=u.workflow_cycle)
union all
select 'photo_batches_over_eight_reserved_files',count(*) from (
  select batch_id from public.private_object_uploads where purpose='photo' group by batch_id having count(*)>8
) excessive
union all
select 'photo_batch_finalized_count_mismatch',count(*) from public.private_object_photo_batches b
  where b.finalized_count<>(select count(*) from public.private_object_uploads u where u.batch_id=b.id and u.purpose='photo' and u.status='finalized')
union all
select 'photo_batch_missing_or_inconsistent_authoritative_event',count(*) from public.private_object_photo_batches b
  where b.finalized_count>0 and not exists(select 1 from public.activities a where a.id=b.activity_id
    and a.work_order_id=b.work_order_id and a.author_id=b.actor_id and a.event_key='photo_added'
    and a.event_data->>'batchId'=b.id::text and a.event_data->'count'=to_jsonb(b.finalized_count));

select enforced as canonical_storage_contraction_enabled from public.private_object_control where singleton;

-- Catalog output contains only schema/routine/role identifiers and definition
-- fingerprints. Fingerprints expose drift without printing policies or secrets.
select schemaname,tablename,policyname,roles,cmd,permissive,
  md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) as definition_fingerprint from pg_policies
where (schemaname='storage' and tablename='objects') or
  (schemaname='public' and tablename in ('photos','contractor_estimate_attachments','private_object_uploads',
    'private_object_bindings','private_object_deletions','private_object_transition_guards','private_object_control','private_object_photo_batches'))
order by schemaname,tablename,policyname;

with routines as (
  select p.*,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname like 'private_object_%' or p.proname in (
    'guard_private_object_records','require_private_object_service','begin_private_object_upload',
    'begin_work_order_photo_upload_v1','begin_contractor_attachment_upload_v1','get_private_object_upload_v1',
    'claim_private_object_upload_v1','cancel_private_object_upload_v1','finalize_private_object_upload_v1',
    'fail_private_object_upload_v1','resolve_private_object_binding_v1','get_verified_invoice_object_v1',
    'request_private_object_delete_v1','claim_private_object_deletion_v1','complete_private_object_deletion_v1',
    'claim_private_object_upload_cleanup_v1','complete_private_object_upload_cleanup_v1',
    'list_private_object_reconciliation_v1','guard_private_object_metadata','guard_private_object_activity',
    'register_verified_legacy_object_v1'))
)
select p.oid::regprocedure::text as routine,pg_get_userbyid(p.proowner) as owner_role,p.prosecdef as security_definer,
  array(select split_part(setting,'=',1) from unnest(p.proconfig) setting order by setting) as configuration_keys,
  coalesce('search_path=pg_catalog, public'=any(p.proconfig),false) as expected_search_path,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute,
  md5(pg_get_functiondef(p.oid)) as definition_fingerprint
from routines p order by p.proname,p.oid;

-- Private capabilities/control/receipts have no browser or service table grant.
-- Service Storage-object privileges remain provider-owned and must not be
-- confused with authority to mutate these application-owned private tables.
select n.nspname as schema_name,c.relname as relation_name,pg_get_userbyid(c.relowner) as owner_role,
  c.relrowsecurity as rls_enabled,r.role_name,
  has_table_privilege(r.role_name,c.oid,'SELECT') as can_select,
  has_table_privilege(r.role_name,c.oid,'INSERT') as can_insert,
  has_table_privilege(r.role_name,c.oid,'UPDATE') as can_update,
  has_table_privilege(r.role_name,c.oid,'DELETE') as can_delete,
  has_table_privilege(r.role_name,c.oid,'TRUNCATE') as can_truncate,
  exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0) as public_privilege
from pg_class c join pg_namespace n on n.oid=c.relnamespace
cross join (values('anon'),('authenticated'),('service_role')) r(role_name)
where n.nspname='public' and c.relname in ('private_object_control','private_object_uploads','private_object_bindings',
  'private_object_deletions','private_object_transition_guards','private_object_photo_batches','photos','contractor_estimate_attachments')
order by c.relname,r.role_name;

select 'private_capability_rows_remaining_after_commands' as check_name,count(*) as record_count
  from public.private_object_transition_guards;
