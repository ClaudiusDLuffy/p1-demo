begin;

alter table public.invoices
  add column if not exists equipment_tag text;

-- Do not rewrite historical invoice rows: their equipment category was never
-- captured, and touching them would also change their audited updated_at time.
-- The application shows Miscellaneous as the explicit fallback until an old
-- draft is edited and saved with a verified tag.

alter table public.invoices
  drop constraint if exists invoices_equipment_tag_check;

alter table public.invoices
  add constraint invoices_equipment_tag_check
  check (
    equipment_tag is null
    or equipment_tag = any (array[
      '7-ELEVEN: HVAC',
      '7-ELEVEN: Fountain',
      '7-ELEVEN: Vault Project',
      '7-ELEVEN: A/C',
      '7-ELEVEN: Lift Station',
      '7-ELEVEN: Vault',
      '7-ELEVEN: Ice',
      '7-ELEVEN: Ovens',
      '7-ELEVEN: EMS System',
      '7-ELEVEN: Floors',
      '7-ELEVEN: Roof',
      '7-ELEVEN: Frozen',
      '7-ELEVEN: CO2',
      '7-ELEVEN: Slurpee',
      '7-ELEVEN: Miscellaneous',
      '7-ELEVEN: Coffee',
      '7-ELEVEN: Engineering Drawings',
      '7-ELEVEN: Dish Machine',
      '7-ELEVEN: Hot Food',
      '7-ELEVEN: Refrigeration',
      '7-ELEVEN: Emergency',
      '7-ELEVEN: Ceilings',
      '7-ELEVEN: Plumbing',
      '7-ELEVEN: General Maintenance'
    ]::text[])
  );

-- Keep invoice metadata and every line/source relationship in one transaction.
-- V3 delegates the existing guarded save, then stores the exact QuickBooks tag.
create or replace function public.save_staff_billing_invoice_v3(
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
  p_equipment_tag text,
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
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;

  if p_equipment_tag is null
    or p_equipment_tag <> all (array[
      '7-ELEVEN: HVAC',
      '7-ELEVEN: Fountain',
      '7-ELEVEN: Vault Project',
      '7-ELEVEN: A/C',
      '7-ELEVEN: Lift Station',
      '7-ELEVEN: Vault',
      '7-ELEVEN: Ice',
      '7-ELEVEN: Ovens',
      '7-ELEVEN: EMS System',
      '7-ELEVEN: Floors',
      '7-ELEVEN: Roof',
      '7-ELEVEN: Frozen',
      '7-ELEVEN: CO2',
      '7-ELEVEN: Slurpee',
      '7-ELEVEN: Miscellaneous',
      '7-ELEVEN: Coffee',
      '7-ELEVEN: Engineering Drawings',
      '7-ELEVEN: Dish Machine',
      '7-ELEVEN: Hot Food',
      '7-ELEVEN: Refrigeration',
      '7-ELEVEN: Emergency',
      '7-ELEVEN: Ceilings',
      '7-ELEVEN: Plumbing',
      '7-ELEVEN: General Maintenance'
    ]::text[])
  then
    raise exception 'A valid QuickBooks equipment tag is required'
      using errcode = '23514';
  end if;

  v_invoice_id := public.save_staff_billing_invoice_v2(
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

  update public.invoices
  set equipment_tag = p_equipment_tag
  where id = v_invoice_id
    and invoice_type = 'staff'
    and deleted_at is null;

  if not found then
    raise exception 'Saved P1 invoice could not be tagged'
      using errcode = 'P0002';
  end if;

  return v_invoice_id;
end;
$$;

revoke all on function public.save_staff_billing_invoice_v3(
  uuid, uuid, text, text, text, text, text, date, date, date, text,
  text, numeric, text, numeric, text, text, jsonb, uuid[]
) from public, anon, authenticated;

grant execute on function public.save_staff_billing_invoice_v3(
  uuid, uuid, text, text, text, text, text, date, date, date, text,
  text, numeric, text, numeric, text, text, jsonb, uuid[]
) to service_role;

comment on column public.invoices.equipment_tag is
  'Exact QuickBooks equipment tag exported for P1-to-7-Eleven receivable invoices.';

commit;
