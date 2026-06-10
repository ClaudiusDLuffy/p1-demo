-- Drop existing broad policies
drop policy if exists "Allow authenticated read" on storage.objects;
drop policy if exists "Allow authenticated upload" on storage.objects;
drop policy if exists "Allow authenticated delete" on storage.objects;
drop policy if exists "photos_read" on storage.objects;
drop policy if exists "photos_write" on storage.objects;
drop policy if exists "photos_delete" on storage.objects;
drop policy if exists "invoice_pdfs_rw" on storage.objects;
drop policy if exists photos_read on storage.objects;
drop policy if exists photos_insert on storage.objects;
drop policy if exists photos_delete on storage.objects;
drop policy if exists invoice_pdfs_read on storage.objects;
drop policy if exists invoice_pdfs_insert on storage.objects;

-- Photos: path is wo/{work_order_id}/{filename}
-- Only the contractor assigned to the WO and staff can read
-- Only the uploader and staff can delete

create policy photos_read on storage.objects
  for select using (
    bucket_id = 'photos'
    and (
      -- Staff can read all photos
      exists (
        select 1 from public.profiles
        where id = auth.uid()
        and role in ('manager', 'dispatcher', 'back_office')
      )
      or
      -- Contractor can read photos on their own WOs
      exists (
        select 1 from public.work_orders wo
        where wo.contractor_id = auth.uid()
        and ('wo/' || wo.id) = split_part(name, '/', 1) || '/' || split_part(name, '/', 2)
        and wo.deleted_at is null
      )
    )
  );

create policy photos_insert on storage.objects
  for insert with check (
    bucket_id = 'photos'
    and auth.uid() is not null
  );

create policy photos_delete on storage.objects
  for delete using (
    bucket_id = 'photos'
    and (
      exists (
        select 1 from public.profiles
        where id = auth.uid()
        and role in ('manager', 'dispatcher', 'back_office')
      )
      or exists (
        select 1 from public.photos
        where storage_path = name
        and uploader_id = auth.uid()
      )
    )
  );

-- Invoice PDFs: only staff and the contractor who submitted
create policy invoice_pdfs_read on storage.objects
  for select using (
    bucket_id = 'invoice-pdfs'
    and (
      exists (
        select 1 from public.profiles
        where id = auth.uid()
        and role in ('manager', 'dispatcher', 'back_office')
      )
      or exists (
        select 1 from public.invoices i
        where i.contractor_id = auth.uid()
        and i.pdf_storage_path = name
      )
    )
  );

create policy invoice_pdfs_insert on storage.objects
  for insert with check (
    bucket_id = 'invoice-pdfs'
    and auth.uid() is not null
  );
