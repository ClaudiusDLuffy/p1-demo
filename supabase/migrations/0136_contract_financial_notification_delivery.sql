-- Batch 3B contraction. Apply only after the queue-aware candidate is deployed
-- with review/hold mutations paused and the dedicated financial drainer off.
-- Old direct notification routes must no longer send. Keep both ledgers and
-- all uncertain outcomes when rolling forward or disabling the operator UI.
begin;

lock table public.invoices,public.activities,public.contractor_invoice_payment_holds,
  public.contractor_invoice_payment_hold_events in share row exclusive mode;
update public.financial_notification_control set contracted=true,contracted_at=clock_timestamp() where singleton;

-- Stale RPC callers still use the same business rule implementation, now
-- enclosed by command-owned intent. They cannot supply recipient/provider data.
create or replace function public.review_contractor_invoice(p_invoice_id uuid,p_action text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_revision int;
begin
  perform public.require_financial_notification_actor('invoice_rejected',true);
  select review_revision into v_revision from public.invoices where id=p_invoice_id;
  return public.review_contractor_invoice_with_notification_v1(p_invoice_id,p_action,p_reason,gen_random_uuid(),v_revision);
end;
$$;
create or replace function public.retract_contractor_invoice_rejection(p_invoice_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_revision int;
begin
  perform public.require_financial_notification_actor('invoice_rejection_retracted',true);
  select review_revision into v_revision from public.invoices where id=p_invoice_id;
  return public.retract_contractor_invoice_rejection_with_notification_v1(p_invoice_id,gen_random_uuid(),v_revision);
end;
$$;
create or replace function public.review_contractor_invoices(p_invoice_ids uuid[],p_action text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_revisions jsonb;
begin
  perform public.require_financial_notification_actor('invoice_rejected',true);
  select coalesce(jsonb_object_agg(i.id::text,i.review_revision),'{}'::jsonb) into v_revisions
    from public.invoices i where i.id=any(p_invoice_ids);
  return public.review_contractor_invoices_with_notification_v1(p_invoice_ids,p_action,p_reason,gen_random_uuid(),v_revisions);
end;
$$;
create or replace function public.place_contractor_invoice_payment_hold(p_invoice_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_latest uuid;
begin
  perform public.require_financial_notification_actor('payment_hold_placed',true,p_actor_id);
  v_latest:=public.financial_notification_latest_hold_source(p_invoice_id);
  return public.execute_financial_notification_mutation(p_invoice_id,'hold','place',p_reason,gen_random_uuid(),null,v_latest,p_actor_id);
end;
$$;
create or replace function public.release_contractor_invoice_payment_hold(p_invoice_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_latest uuid;
begin
  perform public.require_financial_notification_actor('payment_hold_released',true,p_actor_id);
  v_latest:=public.financial_notification_latest_hold_source(p_invoice_id);
  return public.execute_financial_notification_mutation(p_invoice_id,'hold','release',p_reason,gen_random_uuid(),null,v_latest,p_actor_id);
end;
$$;
revoke insert,update,delete,truncate on public.contractor_invoice_payment_holds,public.contractor_invoice_payment_hold_events from public,anon,authenticated,service_role;
revoke all on function public.review_contractor_invoice(uuid,text,text),public.review_contractor_invoices(uuid[],text,text),public.retract_contractor_invoice_rejection(uuid),
  public.place_contractor_invoice_payment_hold(uuid,uuid,text),public.release_contractor_invoice_payment_hold(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.review_contractor_invoice(uuid,text,text),public.review_contractor_invoices(uuid[],text,text),public.retract_contractor_invoice_rejection(uuid) to authenticated,service_role;
grant execute on function public.place_contractor_invoice_payment_hold(uuid,uuid,text),public.release_contractor_invoice_payment_hold(uuid,uuid,text) to service_role;

commit;
