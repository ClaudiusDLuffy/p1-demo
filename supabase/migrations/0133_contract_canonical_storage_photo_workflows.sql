-- Batch 2C contraction is a separate release-owner-controlled stage.
-- Apply 0131, deploy command-compatible application code, verify/upload and
-- review legacy mappings, then run this migration. Do not bulk-push both stages
-- before application cutover. Ambiguous/missing objects require a separately
-- approved investigation; this migration never repairs or deletes them.
begin;
lock table public.photos,public.invoices,public.contractor_estimate_attachments in share row exclusive mode;
do $preflight$
begin
  if exists(select 1 from public.photos p join public.work_orders w on w.id=p.work_order_id
      where w.deleted_at is null and not exists(select 1 from public.private_object_bindings b
        where b.photo_id=p.id and b.purpose='photo' and b.work_order_id=p.work_order_id and b.object_path=p.storage_path
          and (b.state='deletion_pending' or (b.state='finalized' and exists(select 1 from storage.objects o
            where o.id=b.storage_object_id and o.bucket_id=b.bucket and o.name=b.object_path)))))
    or exists(select 1 from public.invoices i where i.deleted_at is null and i.pdf_storage_path is not null
      and not exists(select 1 from public.private_object_bindings b where b.parent_id=i.id
        and b.work_order_id=i.work_order_id and b.object_path=i.pdf_storage_path
        and b.purpose in ('invoice_original','invoice_generated') and b.state='finalized'
        and exists(select 1 from storage.objects o where o.id=b.storage_object_id and o.bucket_id=b.bucket and o.name=b.object_path)))
    or exists(select 1 from public.contractor_estimate_attachments a where a.deleted_at is null
      and not exists(select 1 from public.private_object_bindings b where b.attachment_id=a.id
        and b.parent_id=a.estimate_id and b.object_path=a.storage_path and b.purpose='estimate_attachment'
        and (b.state='deletion_pending' or (b.state='finalized' and exists(select 1 from storage.objects o
          where o.id=b.storage_object_id and o.bucket_id=b.bucket and o.name=b.object_path))))) then
    raise exception 'Unverified legacy object bindings remain; stop and obtain explicit owner review' using errcode='23514';
  end if;
end;
$preflight$;
update public.private_object_control set enforced=true where singleton;
-- Only new uploads are restricted. Existing object metadata/bytes and verified
-- legacy HEIC/HEIF/BMP reads are not changed or decoded. Browser transport MIME
-- is selected from actual signature; filename/declared MIME are not authority.
update storage.buckets set allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','image/tiff']
  where id='photos';

drop policy if exists photos_read on storage.objects;
drop policy if exists photos_insert on storage.objects;
drop policy if exists photos_delete on storage.objects;
drop policy if exists invoice_pdfs_read on storage.objects;
drop policy if exists invoice_pdfs_insert on storage.objects;
drop policy if exists contractor_estimate_attachments_storage_read on storage.objects;
drop policy if exists contractor_estimate_attachments_storage_insert on storage.objects;
drop policy if exists contractor_estimate_attachments_storage_delete on storage.objects;
drop policy if exists canonical_pending_private_object_insert on storage.objects;
create policy canonical_private_objects_read on storage.objects for select to authenticated
  using(bucket_id in ('photos','invoice-pdfs','contractor-estimate-attachments')
    and public.private_object_storage_read(bucket_id,name,id));
create policy canonical_private_objects_insert on storage.objects for insert to authenticated
  with check(bucket_id in ('photos','invoice-pdfs','contractor-estimate-attachments')
    and public.private_object_storage_insert(bucket_id,name,
      coalesce(nullif(to_jsonb(objects)->>'owner_id',''),owner::text)));
-- No browser UPDATE or DELETE policy for these buckets. Provider service-role
-- storage.objects access remains privileged; the server worker accepts only
-- claimed exact known paths. Do not install triggers on provider-owned Storage.

drop policy if exists photo_read on public.photos;
drop policy if exists photo_insert on public.photos;
drop policy if exists photo_delete on public.photos;
create policy canonical_photo_read on public.photos for select to authenticated
  using(public.private_object_metadata_read('photo',id));
drop policy if exists contractor_estimate_attachments_read on public.contractor_estimate_attachments;
create policy canonical_estimate_attachment_read on public.contractor_estimate_attachments for select to authenticated
  using(public.private_object_metadata_read('estimate_attachment',id));
revoke all on public.photos,public.contractor_estimate_attachments
  from public,anon,authenticated,service_role;
grant select on public.photos,public.contractor_estimate_attachments to authenticated,service_role;
revoke truncate,trigger,references on public.activities from public,anon,authenticated,service_role;

-- Old attachment signatures remain, but their metadata trigger now requires
-- the validated binding; old estimate attach/remove cannot bypass finalization
-- or tombstones. Stale browser tabs fail closed, never restore raw writes.
commit;
