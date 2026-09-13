import assert from 'node:assert/strict';
import { createDatabase, applyThrough } from '../receiving-dispatch-test-support/fixtures.mjs';
import { actorTransactions } from '../lifecycle-test-support/engine-fixtures.mjs';

export { createDatabase, applyThrough };
export const syntheticId = (family, number) => `${family}000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
export const workOrderId = number => `SYNTHETIC-PERF-${String(number).padStart(6,'0')}`;
export const actorDefinitions = [
  ['manager','manager',true,null,null], ['dispatcher','dispatcher',true,null,null],
  ['backOffice','back_office',true,null,null], ['controller','back_office',true,null,null],
  ['quickbooksOnly','back_office',true,null,null], ['contractor','contractor',true,null,null],
  ['companyAdmin','contractor',true,1,'company_admin'], ['invoiceMember','contractor',true,1,'invoice'],
  ['reportTechnician','contractor',true,1,'report_only'], ['technician','contractor',true,1,'invoice'],
  ['formerTechnician','contractor',true,1,'report_only'], ['inactive','manager',false,null,null],
  ['otherCompany','contractor',true,2,'company_admin'], ['secondAdmin','contractor',true,1,'company_admin'],
  ['handoffOnly','back_office',true,null,null],
];

export async function seedPerformanceFixture(db,{workOrders=50000,largeDirectories=true}={}) {
  assert.ok(Number.isInteger(workOrders)&&workOrders>=100&&workOrders<=50000);
  const actors=Object.fromEntries(actorDefinitions.map(([name],index)=>[name,syntheticId('80',index+1)]));
  for(const index of [1,2]) await db.query('insert into public.organizations(id,name,slug,active) values($1,$2,$3,true)',
    [syntheticId('81',index),`Synthetic performance company ${index}`,`synthetic-performance-company-${index}`]);
  for(const [index,[name,role,active,company,access]] of actorDefinitions.entries()) {
    const id=actors[name];
    await db.query('insert into auth.users(id,email) values($1,$2)',[id,`${name}@performance.example.invalid`]);
    await db.query(`update public.profiles set name=$2,role=$3,active=$4,is_assignable=$5,
      contractor_organization_id=$6,contractor_access_level=$7 where id=$1`,
    [id,`Synthetic ${name}`,role,active,access===null||access==='company_admin',company===null?null:syntheticId('81',company),access]);
    assert.equal(id,syntheticId('80',index+1));
  }
  await db.query('update public.organizations set canonical_contractor_id=$2 where id=$1',[syntheticId('81',1),actors.companyAdmin]);
  await db.query('update public.organizations set canonical_contractor_id=$2 where id=$1',[syntheticId('81',2),actors.otherCompany]);
  await db.query("insert into public.staff_permission_grants(profile_id,permission) values($1,'invoice_controller'),($2,'quickbooks_handoff'),($2,'invoice_controller')",
    [actors.controller,actors.quickbooksOnly]);
  await db.query("insert into public.staff_permission_grants(profile_id,permission) values($1,'quickbooks_handoff')",[actors.handoffOnly]);
  for(const [index,name] of ['invoiceMember','reportTechnician','technician','formerTechnician'].entries()) {
    await db.query('insert into public.contractor_technicians(id,contractor_id,profile_id,name,is_active) values($1,$2,$3,$4,$5)',
      [syntheticId('82',index+1),actors.companyAdmin,actors[name],`Synthetic ${name}`,name!=='formerTechnician']);
  }
  // Exact owner-only synthetic seed. All triggers are restored before any
  // measured/authorized read; constraints and actual RLS remain installed.
  await db.transaction(async tx=>{
    for(const table of ['work_orders','activities','invoices','invoice_lines','photos','work_order_visits','wo_parts','contractor_invoice_payment_holds','private_object_bindings'])
      await tx.exec(`alter table public.${table} disable trigger user`);
    await tx.query(`insert into public.work_orders(id,contractor_id,status,priority,functional_status,summary,
      created_at,updated_at,closed_at,deleted_at,contractor_assignment_version,contractor_assignment_started_at,
      assigned_technician_profile_id,response_breach_at,resolution_breach_at,dispatched_at,store_state,invoice_total)
      select 'SYNTHETIC-PERF-'||lpad(n::text,6,'0'),case n%5 when 0 then null when 1 then $2::uuid
        when 2 then $3::uuid when 3 then $3::uuid else $4::uuid end,
      (array['unassigned','assigned','wip','parts','capital','completed','pending_invoice','pending_approval','pending_payment','closed'])[1+n%10]::public.wo_status,
      (array['p1','p2','p3','p4'])[1+n%4]::public.wo_priority,'New','Synthetic performance fixture',
      '2026-09-01'::timestamptz-n*interval '1 minute','2026-09-01'::timestamptz-n*interval '1 minute',
      case when n%10=9 then '2026-09-02'::timestamptz else null end,
      case when n%101=0 then '2026-09-03'::timestamptz else null end,
      case when n%5=0 then 0 else 1 end,case when n%5=0 then null else '2026-01-01'::timestamptz end,
      case when n%5 in (2,3) then (array[$5::uuid,$6::uuid,$7::uuid])[1+n%3] else null end,
      '2026-09-01'::timestamptz+n*interval '1 minute','2026-09-02'::timestamptz+n*interval '1 minute',
      '2026-08-30'::timestamptz,'FL',100 from generate_series(1,$1::integer)n`,
    [workOrders,actors.contractor,actors.companyAdmin,actors.otherCompany,actors.invoiceMember,actors.reportTechnician,actors.technician]);
    await tx.query(`insert into public.activities(id,work_order_id,author_id,author_name,text,type,created_at,
      contractor_assignment_version,activity_channel,is_staff_only,entered_by_role)
      select ('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      'SYNTHETIC-PERF-'||lpad((1+(n-1)%$1)::text,6,'0'),$2,'Synthetic actor','Synthetic performance note','note',
      '2026-09-04'::timestamptz+n*interval '1 second',1,'internal_note',true,'manager'
      from generate_series(1,$1::integer*2)n`,[workOrders,actors.manager]);
    // Ten hot parents add timeline skew; mixed field-note flags exercise
    // unread/pending filters without changing any SLA or workflow field.
    await tx.query(`insert into public.activities(id,work_order_id,author_id,author_name,text,type,created_at,
      contractor_assignment_version,activity_channel,is_staff_only,entered_by_role,
      requires_7eleven_sync,requires_contractor_attention)
      select ('9a000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      'SYNTHETIC-PERF-'||lpad((1+n%10)::text,6,'0'),$1,'Synthetic field actor','Synthetic field note','note',
      '2026-09-05'::timestamptz+n*interval '1 second',1,
      case when n%3=0 then 'field_note' else 'contractor_message' end,false,'contractor',n%3=0,n%7=0
      from generate_series(1,1000)n`,[actors.contractor]);
    const invoices=Math.min(workOrders,10000);
    await tx.query(`insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,invoice_date,state,subtotal,sales_tax,total,created_at,updated_at)
      select ('92000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'SYNTHETIC-'||n,
      'SYNTHETIC-PERF-'||lpad(n::text,6,'0'),case when n%2=0 then null else $2::uuid end,
      case when n%2=0 then 'staff' else 'contractor' end,'2026-09-01',
      (array['draft','submitted','approved','rejected','revised','paid'])[1+n%6]::public.invoice_state,
      100,0,100,'2026-09-01'::timestamptz+n*interval '1 second','2026-09-01'::timestamptz+n*interval '1 second'
      from generate_series(1,$1::integer)n`,[invoices,actors.contractor]);
    await tx.query(`insert into public.invoice_lines(id,invoice_id,position,type,description,qty,rate)
      select ('93000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      ('92000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,1,'Labor','Synthetic line',1,100
      from generate_series(1,$1::integer)n`,[invoices]);
    await tx.query(`insert into public.contractor_invoice_payment_holds(invoice_id,placed_at,placed_by,reason)
      select ('92000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      '2026-09-01'::timestamptz+(n/123)*interval '1 second',$2,'Synthetic hold'
      from generate_series(1,$1::integer,2)n where n%3<>0`,[invoices,actors.manager]);
    await tx.query(`insert into public.wo_parts(id,work_order_id,description,qty,status,ordering_responsibility,p1_order_status,p1_requested_at,p1_requested_by,created_at)
      select ('94000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'SYNTHETIC-PERF-'||lpad(n::text,6,'0'),
      'Synthetic part',1,'ordered',case when n%2=0 then 'p1' else 'contractor' end,
      case when n%2=0 then 'requested' else null end,
      case when n%2=0 then '2026-09-04'::timestamptz else null end,
      case when n%2=0 then $2::uuid else null end,
      '2026-09-04'::timestamptz from generate_series(1,$1::integer)n`,[workOrders,actors.manager]);
    await tx.query(`insert into public.work_order_visits(id,work_order_id,contractor_id,check_in_at,check_out_at,checked_in_by,checked_out_by)
      select ('95000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'SYNTHETIC-PERF-'||lpad(n::text,6,'0'),
      $2,'2026-09-04'::timestamptz,'2026-09-04'::timestamptz+interval '1 hour',$2,$2 from generate_series(1,$1::integer)n`,
    [Math.min(workOrders,30000),actors.contractor]);
    await tx.query(`insert into public.photos(id,work_order_id,storage_path,uploader_id,uploader_name,created_at)
      select ('96000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'SYNTHETIC-PERF-'||lpad(n::text,6,'0'),
      'wo/SYNTHETIC-PERF-'||lpad(n::text,6,'0')||'/synthetic-image',$2,'Synthetic uploader','2026-09-04'::timestamptz
      from generate_series(1,$1::integer)n`,[Math.min(workOrders,25000),actors.contractor]);
    await tx.query(`insert into public.private_object_bindings(id,bucket,object_path,storage_object_id,purpose,
      work_order_id,photo_id,actor_id,assignment_version,workflow_cycle,validation,review_reference)
      select ('9b000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'photos',
      'wo/SYNTHETIC-PERF-'||lpad(n::text,6,'0')||'/synthetic-image',
      ('9c000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'photo','SYNTHETIC-PERF-'||lpad(n::text,6,'0'),
      ('96000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$2,1,1,'legacy_reviewed','SYNTHETIC-PERFORMANCE-FIXTURE'
      from generate_series(1,$1::integer)n`,[Math.min(workOrders,25000),actors.contractor]);
    for(const table of ['work_orders','activities','invoices','invoice_lines','photos','work_order_visits','wo_parts','contractor_invoice_payment_holds','private_object_bindings'])
      await tx.exec(`alter table public.${table} enable trigger user`);
  });
  if(largeDirectories) {
    await db.exec(`insert into auth.users(id,email) select ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      'directory-'||n||'@performance.example.invalid' from generate_series(1,5000)n;
      update public.profiles set name='Synthetic directory '||lpad((substring(id::text from 25)::integer%100)::text,3,'0'),
      role=case when substring(id::text from 25)::integer<=2000 then 'back_office'::public.user_role else 'contractor'::public.user_role end,
      active=substring(id::text from 25)::integer%7<>0,is_assignable=true where id::text like '97000000-%';`);
    await db.query(`insert into public.contractor_technicians(id,contractor_id,name,is_active)
      select ('98000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'Synthetic technician '||lpad((n%100)::text,3,'0')||' '||n,true
      from generate_series(1,5000)n`,[actors.companyAdmin]);
  }
  for(const table of ['work_orders','activities','invoices','invoice_lines','photos','work_order_visits','wo_parts',
    'profiles','organizations','contractor_technicians','contractor_invoice_payment_holds']) await db.exec(`analyze public.${table}`);
  const as=actorTransactions(db);
  const read=(actor,sql,params=[],role='authenticated')=>as(role,actor,async tx=>{
    await tx.exec('set transaction read only'); return tx.query(sql,params);
  });
  return {actors,read,as,scale:{workOrders,activities:workOrders*2+1000,invoices:Math.min(workOrders,10000),
    parts:workOrders,visits:Math.min(workOrders,30000),photos:Math.min(workOrders,25000),
    holds:(await db.query('select count(*)::integer count from public.contractor_invoice_payment_holds')).rows[0].count,
    directoryProfiles:largeDirectories?5000:0,technicianLinks:largeDirectories?5004:4}};
}

export async function seedNotificationPerformanceFixture(db,actors,{rows=1000}={}) {
  assert.ok(Number.isInteger(rows)&&rows>=1&&rows<=1000);
  const owned=['contractor_receiving_dispatch_deliveries','financial_notification_events',
    'financial_notification_deliveries','p1_parts_alert_recipients','p1_parts_alert_deliveries','activities'];
  await db.transaction(async tx=>{
    for(const table of owned) await tx.exec(`alter table public.${table} disable trigger user`);
    await tx.query(`insert into public.contractor_receiving_dispatch_deliveries(id,work_order_id,assignment_version,event_type,
      recipient_profile_id,recipient_email_snapshot,recipient_name_snapshot,status,attempt_count,created_by,created_at)
      select ('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      'SYNTHETIC-PERF-'||lpad(n::text,6,'0'),1,'assignment',$2,'synthetic@performance.example.invalid','Synthetic recipient',
      (array['pending','unknown','failed','sent','not_deliverable'])[1+n%5],
      case when n%5=0 then 0 else 3 end,$3,'2026-09-05'::timestamptz+n*interval '1 second'
      from generate_series(1,$1::integer)n`,[rows,actors.contractor,actors.manager]);
    await tx.query(`update public.activities set event_key='invoice_rejected',
      event_data=jsonb_build_object('invoiceId','92000000-0000-4000-8000-'||substring(id::text from 25),'revision','1')
      where id between '91000000-0000-4000-8000-000000000001'::uuid and
        ('91000000-0000-4000-8000-'||lpad($1::text,12,'0'))::uuid`,[rows]);
    await tx.query(`insert into public.financial_notification_events(id,source_kind,source_id,family,invoice_id,work_order_id,
      contractor_id,actor_id,operation_id,message_context,review_revision,created_at)
      select ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'review_activity',
      ('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'invoice_rejected',
      ('92000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'SYNTHETIC-PERF-'||lpad(n::text,6,'0'),$2,$3,
      ('a3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'{}',1,'2026-09-05'::timestamptz+n*interval '1 second'
      from generate_series(1,$1::integer)n`,[rows,actors.contractor,actors.manager]);
    await tx.query(`insert into public.financial_notification_deliveries(id,event_id,recipient_profile_id,recipient_kind,
      recipient_email_snapshot,state,attempt_count,created_at)
      select ('a4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      ('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$2,'contractor','synthetic@performance.example.invalid',
      (array['pending','unknown','failed','sent','not_deliverable'])[1+n%5],case when n%5=0 then 0 else 3 end,
      '2026-09-05'::timestamptz+n*interval '1 second' from generate_series(1,$1::integer)n`,[rows,actors.contractor]);
    await tx.query(`insert into public.p1_parts_alert_recipients(id,profile_id,phone_e164,active,added_by)
      values('a5000000-0000-4000-8000-000000000001',$1,'+12025550123',true,$1)`,[actors.manager]);
    await tx.query(`insert into public.p1_parts_alert_deliveries(id,recipient_id,recipient_profile_id,local_date,request_signature,
      status,attempt_count,provenance,phone_snapshot,timezone,configuration_version,created_at)
      select ('a6000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'a5000000-0000-4000-8000-000000000001',$2,
      '2026-09-05'::date,md5(n::text)||md5(n::text),(array['pending','unknown','failed','delivered','not_deliverable'])[1+n%5],
      case when n%5=0 then 0 else 3 end,'owned_v1','+12025550123','UTC',1,
      '2026-09-05'::timestamptz+n*interval '1 second' from generate_series(1,$1::integer)n`,[rows,actors.manager]);
    for(const table of owned) await tx.exec(`alter table public.${table} enable trigger user`);
  });
  for(const table of owned)await db.exec(`analyze public.${table}`);
  return {receivingDeliveries:rows,financialEvents:rows,financialDeliveries:rows,partsSmsDeliveries:rows,
    states:'20% pending,20% unknown,20% exhausted failed,20% terminal,20% not-deliverable; no provider calls'};
}
