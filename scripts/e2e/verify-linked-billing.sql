-- Run only on the task-owned disposable synthetic database. Always rollback.
begin;
create function pg_temp.assert_true(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAIL: %',label; end if; end; $$;
create function pg_temp.expect_error(statement text,expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlerrm=expected or sqlstate=expected then return; end if;
    raise exception 'Expected %, got %: %',expected,sqlstate,sqlerrm;
  end;
  raise exception 'Expected % but succeeded',expected;
end; $$;
select pg_temp.assert_true(exists(select 1 from public.profiles where email='e2e.manager@p1.invalid'),'synthetic fixtures required');
insert into public.work_orders(id,status,functional_status,billing_only,summary)
select 'E2E-LINK-SQL-'||n,'pending_invoice','Completed',false,'Synthetic billing coverage' from generate_series(1,20) n;
insert into public.work_orders(id,status,functional_status,billing_only,summary)
values('E2E-LINK-TARGET','pending_invoice','Completed',true,'Synthetic billing destination');
insert into public.invoices(id,work_order_id,invoice_type,document_kind,num,state,invoice_date,total)
values('00000000-0000-4000-8000-000016800001','E2E-LINK-TARGET','staff','invoice','SYNTHETIC-LINK','submitted',current_date,100);
create function pg_temp.link(n integer,op integer default 1,note text default 'Synthetic invoice covers this work',version bigint default 0)
returns jsonb language plpgsql as $$
declare w public.work_orders%rowtype; t public.work_orders%rowtype; i public.invoices%rowtype;
begin
  select * into w from public.work_orders where id='E2E-LINK-SQL-'||n;
  select * into t from public.work_orders where id='E2E-LINK-TARGET';
  select * into i from public.invoices where id='00000000-0000-4000-8000-000016800001';
  return public.record_work_order_linked_billing_v1(w.id,case when version=-1 then w.contractor_assignment_version else 0 end,
    case when version=-1 then w.workflow_cycle else 0 end,case when version=-1 then w.lifecycle_version else version end,
    ('00000000-0000-4000-8000-'||lpad((168000100+n*100+op)::text,12,'0'))::uuid,
    t.id,t.contractor_assignment_version,t.workflow_cycle,i.id,i.invoice_version,note);
end; $$;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.assert_true((pg_temp.link(1)->>'applied')::boolean,'first link');
select pg_temp.assert_true(not (pg_temp.link(1)->>'applied')::boolean,'same-operation retry');
select pg_temp.assert_true((pg_temp.link(2)->>'applied')::boolean,'one invoice covers multiple work orders');
select pg_temp.expect_error($q$select pg_temp.link(1,1,'Different reason')$q$,'LINKED_BILLING_OPERATION_REUSED');
select pg_temp.expect_error($q$select pg_temp.link(1,2)$q$,'LINKED_BILLING_STALE');
select pg_temp.expect_error($q$select pg_temp.link(3,1,' ')$q$,'LINKED_BILLING_INVALID_INPUT');
select pg_temp.expect_error($q$select pg_temp.link(3,1,E'\t\n\t\n\t\n')$q$,'LINKED_BILLING_INVALID_INPUT');
select pg_temp.expect_error($q$select * from public.work_order_billing_links$q$,'42501');
select pg_temp.assert_true(jsonb_array_length(public.get_work_order_billing_links_v1('E2E-LINK-TARGET')->'items')=2,'destination history');
select pg_temp.assert_true(public.get_work_order_billing_links_v1('E2E-LINK-SQL-1')->'items'->0->'receipt'->>'billingWorkOrderId'='E2E-LINK-TARGET','source history');
select pg_temp.assert_true(jsonb_array_length(public.list_linked_billing_candidates_v1('E2E-LINK-TARGET')->'items')=1,'eligible submitted invoice');
select pg_temp.expect_error($q$select public.list_linked_billing_candidates_v1(repeat('x',129))$q$,'LINKED_BILLING_INVALID_INPUT');
select pg_temp.expect_error($q$select public.get_work_order_billing_links_v1('E2E-LINK-TARGET',now(),null)$q$,'LINKED_BILLING_INVALID_INPUT');
reset role;
select pg_temp.assert_true((select count(*)=2 from public.work_order_billing_links where billing_work_order_id='E2E-LINK-TARGET'),'one ledger row per source');
select pg_temp.assert_true((select count(*)=4 from public.activities where event_key in ('work_order_billed_under_another','work_order_billing_coverage_added')
  and event_data->>'billingWorkOrderId'='E2E-LINK-TARGET' and is_staff_only and not requires_7eleven_sync),'two immutable internal activities per link');
select pg_temp.assert_true(not exists(select 1 from public.invoices where work_order_id like 'E2E-LINK-SQL-%'),'no duplicate invoice or revenue');
select pg_temp.assert_true((select status='closed' and functional_status='Completed' and lifecycle_version=1 from public.work_orders where id='E2E-LINK-SQL-1'),'source closed, field status retained');
select pg_temp.assert_true((select status<>'closed' from public.work_orders where id='E2E-LINK-TARGET'),'destination lifecycle unchanged');
select pg_temp.assert_true(not exists(select 1 from public.work_order_close_transition_guards where transition_kind='linked_billing'),'capabilities consumed');
select pg_temp.expect_error($q$update public.work_order_billing_links set note='Forged note' where work_order_id='E2E-LINK-SQL-1'$q$,'42501');
select pg_temp.expect_error($q$delete from public.activities where work_order_id='E2E-LINK-SQL-1' and event_key='work_order_billed_under_another'$q$,'42501');
select pg_temp.expect_error($q$insert into public.activities(work_order_id,author_id,author_name,text,type,is_staff_only,event_key,event_data)
  values('E2E-LINK-SQL-3',auth.uid(),'Synthetic staff','Forged','system',true,'work_order_billed_under_another','{"coveredWorkOrderId":"E2E-LINK-SQL-3"}')$q$,'42501');
select set_config('request.jwt.claims','{}',true) is not null;
select pg_temp.expect_error($q$insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,invoice_date,total)
  values('E2E-LINK-SQL-1','staff','invoice','SYNTHETIC-DUPLICATE','draft',current_date,100)$q$,'LINKED_BILLING_ALREADY_RECORDED');
select pg_temp.expect_error($q$update public.invoices set state='draft' where id='00000000-0000-4000-8000-000016800001'$q$,'LINKED_BILLING_INVOICE_IN_USE');
select pg_temp.expect_error($q$update public.invoices set state='rejected' where id='00000000-0000-4000-8000-000016800001'$q$,'LINKED_BILLING_INVOICE_IN_USE');
select pg_temp.expect_error($q$update public.invoices set deleted_at=now() where id='00000000-0000-4000-8000-000016800001'$q$,'LINKED_BILLING_INVOICE_IN_USE');
select pg_temp.expect_error($q$update public.invoices set work_order_id='E2E-LINK-SQL-3' where id='00000000-0000-4000-8000-000016800001'$q$,'LINKED_BILLING_INVOICE_IN_USE');
-- Approval and normal financial edits remain allowed on the real invoice.
update public.invoices set state='approved' where id='00000000-0000-4000-8000-000016800001';
update public.work_orders set status='parts',functional_status='Awaiting Parts' where id='E2E-LINK-SQL-3';
update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid') where id='E2E-LINK-SQL-4';
insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at)
select 'E2E-LINK-SQL-4',id,id,now()-interval '1 hour' from public.profiles where email='e2e.direct@p1.invalid';
insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
select 'E2E-LINK-SQL-5',id,name,'Synthetic unsent note','note','note','field_note' from public.profiles where email='e2e.manager@p1.invalid';
insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,invoice_date,total)
values('E2E-LINK-SQL-6','staff','invoice','SYNTHETIC-EXISTING','draft',current_date,100);
update public.work_orders set status='pending_invoice',functional_status='Completed' where id in ('E2E-LINK-SQL-4','E2E-LINK-SQL-6');
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.link(3,1,'Synthetic note',-1)$q$,'LINKED_BILLING_FIELD_INCOMPLETE');
select pg_temp.expect_error($q$select pg_temp.link(4,1,'Synthetic note',-1)$q$,'LINKED_BILLING_OPEN_VISIT');
select pg_temp.expect_error($q$select pg_temp.link(5,1,'Synthetic note',-1)$q$,'LINKED_BILLING_PENDING_UPDATES');
select pg_temp.expect_error($q$select pg_temp.link(6,1,'Synthetic note',-1)$q$,'LINKED_BILLING_PORTAL_INVOICE_EXISTS');
select pg_temp.expect_error($q$select public.record_work_order_linked_billing_v1('E2E-LINK-SQL-7',0,0,0,gen_random_uuid(),
  'E2E-LINK-SQL-7',0,0,'00000000-0000-4000-8000-000016800001',0,'Synthetic note')$q$,'LINKED_BILLING_INVALID_INPUT');
select pg_temp.expect_error($q$select public.record_work_order_linked_billing_v1('E2E-LINK-SQL-7',0,0,0,gen_random_uuid(),
  'E2E-LINK-TARGET',0,0,'00000000-0000-4000-8000-000016800001',999,'Synthetic note')$q$,'LINKED_BILLING_STALE');
select public.reopen_work_order('E2E-LINK-SQL-1','billing_follow_up','Synthetic coverage correction')->>'applied';
select public.reopen_work_order('E2E-LINK-SQL-2','billing_follow_up','Synthetic coverage correction')->>'applied';
select pg_temp.assert_true(not (public.get_work_order_billing_links_v1('E2E-LINK-SQL-1')->'items'->0->>'active')::boolean,'reopened history is historical');
reset role;
select set_config('request.jwt.claims','{}',true) is not null;
update public.invoices set state='draft' where id='00000000-0000-4000-8000-000016800001';
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.link(7)$q$,'LINKED_BILLING_INVOICE_UNAVAILABLE');
select pg_temp.assert_true(jsonb_array_length(public.list_linked_billing_candidates_v1('E2E-LINK-TARGET')->'items')=0,'draft excluded');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.direct@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.link(8)$q$,'LINKED_BILLING_FORBIDDEN');
select pg_temp.expect_error($q$select public.get_work_order_billing_links_v1('E2E-LINK-TARGET')$q$,'LINKED_BILLING_FORBIDDEN');
select pg_temp.expect_error($q$select public.list_linked_billing_candidates_v1('E2E-LINK-TARGET')$q$,'LINKED_BILLING_FORBIDDEN');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.controller@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select public.get_work_order_billing_links_v1('E2E-LINK-TARGET')$q$,'LINKED_BILLING_FORBIDDEN');
reset role;
select set_config('request.jwt.claims','{}',true) is not null;
-- Unresolved contractor bills, source external billing, and invalid target
-- invoice kinds must not be mistaken for eligible portal billing coverage.
update public.invoices set state='submitted' where id='00000000-0000-4000-8000-000016800001';
update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid'),
  contractor_assignment_started_at=now()-interval '1 day' where id='E2E-LINK-SQL-9';
insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,total,invoice_date,contractor_id,created_at)
select 'E2E-LINK-SQL-9','contractor','invoice','SYNTHETIC-LINK-REVIEW','submitted',50,current_date,id,clock_timestamp()
from public.profiles where email='e2e.direct@p1.invalid';
update public.work_orders set status='pending_invoice',functional_status='Completed' where id='E2E-LINK-SQL-9';
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.link(9,1,'Synthetic note',-1)$q$,'LINKED_BILLING_UNRESOLVED_INVOICES');
select public.record_work_order_external_billing_v1('E2E-LINK-SQL-10',0,0,0,gen_random_uuid(),
  'Synthetic Accounting','SYNTHETIC-EXTERNAL','2026-01-01','Synthetic external reference')->>'applied';
select pg_temp.expect_error($q$select pg_temp.link(10,1,'Synthetic note',-1)$q$,'LINKED_BILLING_ALREADY_RECORDED');
reset role;
select set_config('request.jwt.claims','{}',true) is not null;
-- Separate pre-approved fixture: changing a submitted contractor bill directly
-- would correctly violate the existing authoritative review boundary.
update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid'),
  contractor_assignment_started_at=now()-interval '1 day' where id='E2E-LINK-SQL-11';
insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,total,invoice_date,contractor_id,created_at)
select 'E2E-LINK-SQL-11','contractor','invoice','SYNTHETIC-LINK-APPROVED','approved',50,current_date,id,clock_timestamp()
from public.profiles where email='e2e.direct@p1.invalid';
update public.work_orders set status='pending_invoice',functional_status='Completed' where id='E2E-LINK-SQL-11';
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.assert_true((pg_temp.link(11,1,'Synthetic note',-1)->>'applied')::boolean,'approved contractor costs remain valid');
reset role;
select set_config('request.jwt.claims','{}',true) is not null;
-- Bounded candidate pages with explicit exact-number narrowing.
insert into public.work_orders(id,status,functional_status,billing_only,summary)
values('E2E-LINK-PAGED','pending_invoice','Completed',true,'Synthetic candidate pagination');
insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,total,invoice_date)
select 'E2E-LINK-PAGED','staff','invoice','SYNTHETIC-LINK-PAGED-'||n,'submitted',10,current_date from generate_series(1,30) n;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.assert_true(jsonb_array_length(public.list_linked_billing_candidates_v1('E2E-LINK-PAGED')->'items')=25,'candidate results bounded');
select pg_temp.assert_true((public.list_linked_billing_candidates_v1('E2E-LINK-PAGED')->>'hasMore')::boolean,'candidate overflow disclosed');
select pg_temp.assert_true(jsonb_array_length(public.list_linked_billing_candidates_v1('E2E-LINK-PAGED','SYNTHETIC-LINK-PAGED-30')->'items')=1,'exact invoice search');
reset role;
select set_config('request.jwt.claims','{}',true) is not null;
-- Prove closure, source activity and ledger all roll back if the second audit
-- record fails; this task-scoped injected failure exists only in this transaction.
create function pg_temp.fail_linked_audit() returns trigger language plpgsql as $$
begin
  if new.event_key='work_order_billing_coverage_added' and new.event_data->>'coveredWorkOrderId'='E2E-LINK-SQL-12' then
    raise exception 'SYNTHETIC_LATE_FAILURE';
  end if;
  return new;
end; $$;
create trigger e2e_fail_linked_audit before insert on public.activities for each row execute function pg_temp.fail_linked_audit();
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.link(12)$q$,'SYNTHETIC_LATE_FAILURE');
reset role;
select pg_temp.assert_true((select status='pending_invoice' from public.work_orders where id='E2E-LINK-SQL-12'),'late failure rolled back source closure');
select pg_temp.assert_true(not exists(select 1 from public.work_order_billing_links where work_order_id='E2E-LINK-SQL-12'),'late failure leaves no ledger');
select pg_temp.assert_true(not exists(select 1 from public.activities where event_data->>'coveredWorkOrderId'='E2E-LINK-SQL-12'),'late failure leaves no partial activity');
select set_config('request.jwt.claims','{}',true) is not null;
update public.profiles set active=false where email='e2e.manager@p1.invalid';
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null
from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.link(13)$q$,'LINKED_BILLING_FORBIDDEN');
reset role;
select pg_temp.assert_true(not has_function_privilege('anon','public.list_linked_billing_candidates_v1(text,text)','execute'),'anonymous denied');
select pg_temp.assert_true(not has_function_privilege('service_role','public.list_linked_billing_candidates_v1(text,text)','execute'),'service role denied');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.require_linked_billing_actor()','execute'),'private helper denied');
select 'PASS_LINKED_BILLING_SQL' as result;
rollback;
