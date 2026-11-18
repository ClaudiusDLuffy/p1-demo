import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {linkedBillingSql as sql} from './linked-billing-test-support.mjs';

export function ntePendingFilterFixture() {
  assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"),'0');
  const prefix = 'E2E-NTE-FILTER-' + randomUUID().slice(0,8);
  const actor = sql("select id from public.profiles where email='e2e.manager@p1.invalid'");
  const contractor = sql("select id from public.profiles where email='e2e.direct@p1.invalid'");
  assert.match(actor,/^[a-f0-9-]{36}$/); assert.match(contractor,/^[a-f0-9-]{36}$/);
  const rows = Array.from({length:18},(_,index)=>({
    id: `${prefix}-${String(index+1).padStart(3,'0')}`, invoiceId:randomUUID(),
    status:index===15?'closed':'pending_invoice', state:index%2===0?'TX':'FL',
    priority:index%2===0?'p2':'p3', waiting:index<16, contractor,
  }));
  sql('begin;'+rows.map((row,index)=>`
    insert into public.work_orders(id,status,functional_status,store_number,store_state,summary,priority,contractor_id,created_at,nte_flagged)
    values('${row.id}','${row.status}','Completed','E2E001','${row.state}','Synthetic NTE filter ${prefix} row ${index+1}',
      '${row.priority}','${contractor}',now()-interval '${index+1} minutes',${index===17});
    insert into public.invoices(id,work_order_id,num,invoice_type,document_kind,state,invoice_date,subtotal,total)
    values('${row.invoiceId}','${row.id}','${row.id}','staff','invoice','draft',current_date,100,100);
    ${index!==17?`insert into public.staff_invoice_nte_wait_flags(invoice_id,waiting_on_nte_approval,updated_by)
      values('${row.invoiceId}',${row.waiting},'${actor}');`:''}
  `).join('')+'commit;');
  // Two waiting invoices must still produce ONE work-order result.
  const secondInvoiceId=randomUUID();
  sql(`insert into public.invoices(id,work_order_id,num,invoice_type,document_kind,state,invoice_date,subtotal,total)
    values('${secondInvoiceId}','${rows[0].id}','${prefix}-SECOND','staff','invoice','draft',current_date,100,100);
    insert into public.staff_invoice_nte_wait_flags(invoice_id,waiting_on_nte_approval,updated_by)
    values('${secondInvoiceId}',true,'${actor}');`);
  return {prefix,actor,contractor,rows,secondInvoiceId};
}

export function nteFixtureFingerprint(fixture, includeMarkerAudit = true) {
  assert.match(fixture.prefix,/^E2E-NTE-FILTER-[a-f0-9]{8}$/);
  return sql(`select md5(jsonb_build_object(
    'workOrders',(select jsonb_agg(to_jsonb(w) order by id) from public.work_orders w where id like '${fixture.prefix}%'),
    'invoices',(select jsonb_agg(to_jsonb(i) order by id) from public.invoices i where work_order_id like '${fixture.prefix}%'),
    'flags',(select jsonb_agg(${includeMarkerAudit ? 'to_jsonb(f)' : "jsonb_build_object('invoice_id',f.invoice_id,'waiting_on_nte_approval',f.waiting_on_nte_approval)"} order by invoice_id) from public.staff_invoice_nte_wait_flags f
      join public.invoices i on i.id=f.invoice_id where i.work_order_id like '${fixture.prefix}%'))::text)`);
}

export function nteAuthenticatedRead(email,name,args={}) {
  assert.match(email,/^e2e\.[a-z.0-9]+@p1\.invalid$/);
  assert.ok(['list_work_orders_nte_rows_v1','count_work_orders_nte_v1',
    'list_work_orders_nte_table_rows_v1','count_work_orders_nte_table_v1'].includes(name));
  const id=sql(`select id from public.profiles where email='${email}'`); assert.match(id,/^[a-f0-9-]{36}$/);
  const literal=value=>value===null?'null':typeof value==='number'?String(value):typeof value==='boolean'?String(value):"'"+String(value).replaceAll("'","''")+"'";
  const parameters=Object.entries(args).map(([key,value])=>{
    assert.match(key,/^p_[a-z_]+$/);return key+'=>'+literal(value);
  }).join(',');
  return JSON.parse(sql(`begin; do $$ begin perform set_config('request.jwt.claims','{"sub":"${id}","role":"authenticated"}',true); end $$;
    set local role authenticated; select public.${name}(${parameters}); rollback;`));
}
