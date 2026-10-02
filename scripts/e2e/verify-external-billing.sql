-- Synthetic-only regression suite. Run on supabase_db_p1-demo-e2e after seeding.
-- All fixture mutations roll back. No production IDs or accounting data.
begin;
create function pg_temp.assert_true(value boolean, label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'FAIL: %', label; end if; end; $$;
create function pg_temp.expect_error(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlerrm = expected or sqlstate = expected then return; end if;
    raise exception 'Expected %, got %: %', expected, sqlstate, sqlerrm;
  end;
  raise exception 'Expected error % but action succeeded', expected;
end; $$;
select pg_temp.assert_true(exists(select 1 from public.profiles where email='e2e.manager@p1.invalid'), 'synthetic seed required');
insert into public.work_orders(id, status, functional_status, billing_only, summary)
select 'E2E-EXT-SQL-'||n, 'pending_invoice', 'Completed', false, 'Synthetic external billing test' from generate_series(1,12) n;
create function pg_temp.bill(n integer, op integer default 1, note text default 'Synthetic shared external invoice')
returns jsonb language sql as $$
  select public.record_work_order_external_billing_v1('E2E-EXT-SQL-'||n,0,0,0,
    ('00000000-0000-4000-8000-'||lpad((n*100+op)::text,12,'0'))::uuid,
    'QuickBooks','SYNTHETIC-SHARED-10000','2026-01-01',note);
$$;
select set_config('request.jwt.claims', jsonb_build_object('role','authenticated','sub',id)::text,true)
  is not null as synthetic_actor_set from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.assert_true((pg_temp.bill(1)->>'applied')::boolean, 'first close');
select pg_temp.assert_true(not (pg_temp.bill(1)->>'applied')::boolean, 'identical replay');
select pg_temp.assert_true((pg_temp.bill(2)->>'applied')::boolean, 'shared reference is allowed');
select pg_temp.expect_error($q$select pg_temp.bill(1,1,'Different input')$q$, 'EXTERNAL_BILLING_OPERATION_REUSED');
select pg_temp.expect_error($q$select pg_temp.bill(1,2)$q$, 'EXTERNAL_BILLING_STALE');
select pg_temp.expect_error($q$select pg_temp.bill(3,1,' ')$q$, 'EXTERNAL_BILLING_INVALID_INPUT');
select pg_temp.expect_error($q$select pg_temp.bill(3,1,E'\t\n\t\n\t\n')$q$, 'EXTERNAL_BILLING_INVALID_INPUT');
select pg_temp.expect_error($q$select * from public.work_order_external_billings$q$, '42501');
select pg_temp.expect_error($q$select public.record_work_order_external_billing_v1('E2E-EXT-SQL-3',0,0,0,gen_random_uuid(),'QuickBooks','x','2999-01-01','Valid note')$q$, 'EXTERNAL_BILLING_INVALID_INPUT');
select pg_temp.expect_error($q$select public.record_work_order_external_billing_v1('E2E-EXT-SQL-3',1,0,0,gen_random_uuid(),'QuickBooks','x','2026-01-01','Valid note')$q$, 'EXTERNAL_BILLING_STALE');
select pg_temp.assert_true(public.get_work_order_external_billing_v1('E2E-EXT-SQL-1')->>'invoiceReference'='SYNTHETIC-SHARED-10000', 'authorized receipt read');
select pg_temp.expect_error($q$select public.get_work_order_external_billing_v1(repeat('x',129))$q$, 'EXTERNAL_BILLING_INVALID_INPUT');
reset role;
select pg_temp.assert_true((select count(*)=2 from public.work_order_external_billings where work_order_id like 'E2E-EXT-SQL-%'), 'one record per closure');
select pg_temp.assert_true((select count(*)=2 from public.activities where work_order_id in ('E2E-EXT-SQL-1','E2E-EXT-SQL-2') and event_key='work_order_billed_externally' and is_staff_only and not requires_7eleven_sync), 'internal distinct audit events');
select pg_temp.assert_true(not exists(select 1 from public.invoices where work_order_id like 'E2E-EXT-SQL-%'), 'no invoices created');
select pg_temp.assert_true(not exists(select 1 from public.work_order_close_transition_guards where work_order_id like 'E2E-EXT-SQL-%'), 'capabilities consumed');
select pg_temp.assert_true((select status='closed' and functional_status='Completed' and lifecycle_version=1 from public.work_orders where id='E2E-EXT-SQL-1'), 'terminal state and unchanged functional status');
select pg_temp.expect_error($q$update public.work_order_external_billings set note='Forged history' where work_order_id='E2E-EXT-SQL-1'$q$,'42501');
select pg_temp.expect_error($q$delete from public.activities where work_order_id='E2E-EXT-SQL-1' and event_key='work_order_billed_externally'$q$,'42501');
select pg_temp.expect_error($q$insert into public.activities(work_order_id,author_id,author_name,text,type,is_staff_only,event_key) values ('E2E-EXT-SQL-3',auth.uid(),'Synthetic actor','Forged evidence','system',true,'work_order_billed_externally')$q$,'42501');
-- Owner fixture setup without an impersonated actor; no real data exists here.
select set_config('request.jwt.claims','{}',true) is not null as actor_cleared;
update public.work_orders set functional_status='Work in Progress' where id='E2E-EXT-SQL-3';
update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid')
  where id='E2E-EXT-SQL-4';
insert into public.work_order_visits(work_order_id,contractor_id,checked_in_by,check_in_at)
select 'E2E-EXT-SQL-4',id,id,now()-interval '1 hour' from public.profiles where email='e2e.direct@p1.invalid';
insert into public.activities(work_order_id,author_id,author_name,text,type,event_key,activity_channel)
select 'E2E-EXT-SQL-5',id,name,'Synthetic unsent field note','note','note','field_note' from public.profiles where email='e2e.manager@p1.invalid';
update public.work_orders set contractor_id=(select id from public.profiles where email='e2e.direct@p1.invalid'),
  contractor_assignment_started_at=now()-interval '1 day' where id in ('E2E-EXT-SQL-7','E2E-EXT-SQL-8');
insert into public.invoices(id,work_order_id,invoice_type,document_kind,num,state,total,invoice_date)
values (gen_random_uuid(),'E2E-EXT-SQL-6','staff','invoice','SYNTHETIC-EXT-DRAFT','draft',50,current_date);
insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,total,invoice_date,contractor_id,created_at)
select 'E2E-EXT-SQL-7','contractor','invoice','SYNTHETIC-EXT-REVIEW','submitted',50,current_date,id,clock_timestamp()
  from public.profiles where email='e2e.direct@p1.invalid';
insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,total,invoice_date,contractor_id,created_at)
select 'E2E-EXT-SQL-8','contractor','invoice','SYNTHETIC-EXT-APPROVED','approved',50,current_date,id,clock_timestamp()
  from public.profiles where email='e2e.direct@p1.invalid';
-- Invoice fixtures may change parent queue; capture fresh versions in helper.
create function pg_temp.bill_current(n integer) returns jsonb language plpgsql as $$
declare w public.work_orders%rowtype;
begin
  select * into w from public.work_orders where id='E2E-EXT-SQL-'||n;
  return public.record_work_order_external_billing_v1(w.id,w.contractor_assignment_version,w.workflow_cycle,
    w.lifecycle_version,gen_random_uuid(),'QuickBooks','SYNTHETIC-10000','2026-01-01','Synthetic test note');
end; $$;
update public.work_orders set status='pending_invoice',functional_status='Completed'
  where id in ('E2E-EXT-SQL-4','E2E-EXT-SQL-6','E2E-EXT-SQL-7','E2E-EXT-SQL-8');
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null as actor_set
  from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.bill_current(3)$q$, 'EXTERNAL_BILLING_FIELD_INCOMPLETE');
select pg_temp.expect_error($q$select pg_temp.bill_current(4)$q$, 'EXTERNAL_BILLING_OPEN_VISIT');
select pg_temp.expect_error($q$select pg_temp.bill_current(5)$q$, 'EXTERNAL_BILLING_PENDING_UPDATES');
select pg_temp.expect_error($q$select pg_temp.bill_current(6)$q$, 'EXTERNAL_BILLING_PORTAL_INVOICE_EXISTS');
select pg_temp.expect_error($q$select pg_temp.bill_current(7)$q$, 'EXTERNAL_BILLING_UNRESOLVED_INVOICES');
select pg_temp.assert_true((pg_temp.bill_current(8)->>'applied')::boolean, 'approved contractor bill is not a duplicate customer invoice');
select public.reopen_work_order('E2E-EXT-SQL-2','billing_follow_up','Synthetic reopen test')->>'applied' as reopened;
select pg_temp.expect_error($q$select pg_temp.bill(2)$q$, 'EXTERNAL_BILLING_STALE');
select pg_temp.assert_true(public.get_work_order_external_billing_v1('E2E-EXT-SQL-2')->>'invoiceReference'='SYNTHETIC-SHARED-10000', 'reopen retains external billing history');
reset role;
select set_config('request.jwt.claims','{}',true) is not null as actor_cleared;
select pg_temp.expect_error($q$insert into public.invoices(work_order_id,invoice_type,document_kind,num,state,total,invoice_date) values ('E2E-EXT-SQL-1','staff','invoice','SYNTHETIC-DUPLICATE','draft',50,current_date)$q$, 'EXTERNAL_BILLING_ALREADY_RECORDED');
-- Deny actual authenticated contractor and restricted-controller RPC access.
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null as actor_set
  from public.profiles where email='e2e.direct@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.bill(9)$q$, 'EXTERNAL_BILLING_FORBIDDEN');
select pg_temp.expect_error($q$select public.get_work_order_external_billing_v1('E2E-EXT-SQL-1')$q$, 'EXTERNAL_BILLING_FORBIDDEN');
reset role;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null as actor_set
  from public.profiles where email='e2e.controller@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.bill(9)$q$, 'EXTERNAL_BILLING_FORBIDDEN');
reset role;
select pg_temp.assert_true(not has_function_privilege('anon','public.record_work_order_external_billing_v1(text,integer,integer,bigint,uuid,text,text,date,text)','execute'), 'anonymous denied');
select pg_temp.assert_true(not has_function_privilege('service_role','public.record_work_order_external_billing_v1(text,integer,integer,bigint,uuid,text,text,date,text)','execute'), 'service role denied');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.require_external_billing_actor()','execute'), 'private helper denied');
select pg_temp.assert_true((select bool_and(prosecdef and proconfig @> array['search_path=public, pg_temp'])
  from pg_proc where oid in ('public.record_work_order_external_billing_v1(text,integer,integer,bigint,uuid,text,text,date,text)'::regprocedure,
    'public.get_work_order_external_billing_v1(text)'::regprocedure)), 'security definer and fixed search paths');
select pg_temp.assert_true((select relrowsecurity from pg_class where oid='public.work_order_external_billings'::regclass), 'ledger RLS enabled');
select set_config('request.jwt.claims','{}',true) is not null as actor_cleared;
update public.profiles set active=false where email='e2e.manager@p1.invalid';
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',id)::text,true) is not null as actor_set
  from public.profiles where email='e2e.manager@p1.invalid';
set local role authenticated;
select pg_temp.expect_error($q$select pg_temp.bill(9)$q$, 'EXTERNAL_BILLING_FORBIDDEN');
reset role;
select 'PASS_EXTERNAL_BILLING_SQL' as result;
rollback;
