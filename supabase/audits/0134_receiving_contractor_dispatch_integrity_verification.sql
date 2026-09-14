-- Read-only Phase 5A receiving-dispatch integrity audit.
select jsonb_build_object(
  'missing_current_intent', (select count(*) from public.work_orders w where w.deleted_at is null and w.contractor_id is not null and not exists (
    select 1 from public.contractor_receiving_dispatch_deliveries d where d.work_order_id=w.id and d.assignment_version=w.contractor_assignment_version and d.recipient_profile_id=w.contractor_id and d.event_type in ('assignment','reassignment','duplicate_assignment'))),
  'duplicate_event_keys', (select count(*) from (select work_order_id,assignment_version,recipient_profile_id,event_type from public.contractor_receiving_dispatch_deliveries group by 1,2,3,4 having count(*)>1) x),
  'expired_claims', (select count(*) from public.contractor_receiving_dispatch_deliveries where status in ('claimed','sending') and claim_expires_at<clock_timestamp()),
  'unknown_deliveries', (select count(*) from public.contractor_receiving_dispatch_deliveries where status='unknown'),
  'not_deliverable_current', (select count(*) from public.contractor_receiving_dispatch_deliveries d join public.work_orders w on w.id=d.work_order_id and w.contractor_id=d.recipient_profile_id and w.contractor_assignment_version=d.assignment_version where d.status='not_deliverable')
) as receiving_dispatch_integrity;
