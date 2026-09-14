-- Batch 1C contraction. Apply only after 0124, deployment of the compatible
-- web build, staging smoke tests, and review of the read-only 0125 audit.
-- Old tabs must refresh; raw financial writes intentionally fail closed.

begin;

do $prerequisites$
begin
  if to_regprocedure(
       'public.save_contractor_invoice_draft_v1(text,integer,integer,uuid,bigint,uuid,jsonb)'
     ) is null
     or to_regprocedure(
       'public.submit_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb)'
     ) is null
     or to_regprocedure(
       'public.revise_contractor_invoice_v1(text,integer,integer,uuid,bigint,uuid,jsonb)'
     ) is null
     or to_regprocedure(
       'public.save_staff_billing_invoice_v4(uuid,text,integer,integer,uuid,bigint,uuid,jsonb)'
     ) is null
     or to_regprocedure(
       'public.delete_invoice_admin_v1(uuid,uuid,text,bigint,uuid,integer,integer,text)'
     ) is null
     or to_regprocedure(
       'public.mark_work_order_ready_for_billing_v1(text,integer,integer,bigint,uuid)'
     ) is null then
    raise exception 'Invoice financial expansion must be installed before contraction';
  end if;
end;
$prerequisites$;

lock table public.work_orders,
  public.invoices,
  public.invoice_lines,
  public.staff_invoice_sources,
  public.activities
in share row exclusive mode;

update public.invoice_financial_control
set contracted = true
where singleton;

-- Browser and service clients retain SELECT through the existing RLS/read
-- policies. All header/line/source mutations now enter through a finite RPC.
drop policy if exists inv_insert on public.invoices;
drop policy if exists inv_update on public.invoices;
drop policy if exists inv_delete on public.invoices;
drop policy if exists line_write on public.invoice_lines;
drop policy if exists staff_invoice_sources_insert on public.staff_invoice_sources;
drop policy if exists staff_invoice_sources_update on public.staff_invoice_sources;
drop policy if exists staff_invoice_sources_delete on public.staff_invoice_sources;

revoke insert, update, delete on public.invoices,
  public.invoice_lines,
  public.staff_invoice_sources
from public, anon, authenticated, service_role;

-- These signatures cannot carry assignment, workflow, invoice-version, and
-- idempotency tokens. Their implementations remain only as private cores used
-- by the bounded compatibility wrappers installed in 0124.
revoke all on function
  public.submit_contractor_invoice_once(
    uuid,text,text,boolean,text,text,date,date,date,text,numeric,numeric,jsonb
  ),
  public.resubmit_rejected_contractor_invoice(
    uuid,text,text,date,date,text,numeric,numeric,jsonb,text
  ),
  public.delete_own_contractor_invoice(uuid),
  public.save_staff_billing_invoice(
    uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,jsonb,uuid[]
  ),
  public.save_staff_billing_invoice_v2(
    uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,jsonb,uuid[]
  ),
  public.save_staff_billing_invoice_v3(
    uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[]
  )
from public, anon, authenticated, service_role;

comment on table public.invoice_financial_control is
  'Private rollout state. 0125 requires the compatible web release; do not reopen raw invoice writes as rollback.';
comment on function public.submit_contractor_invoice_once(
  uuid,text,text,boolean,text,text,date,date,date,text,numeric,numeric,jsonb
) is
  'Obsolete unversioned entry point. Use submit_contractor_invoice_v1.';
comment on function public.delete_own_contractor_invoice(uuid) is
  'Obsolete unversioned entry point. Use delete_own_contractor_invoice_v1.';
comment on function public.save_staff_billing_invoice_v3(
  uuid,uuid,text,text,text,text,text,date,date,date,text,text,numeric,text,numeric,text,text,jsonb,uuid[]
) is
  'Private legacy implementation. Server routes use save_staff_billing_invoice_v4.';

commit;
