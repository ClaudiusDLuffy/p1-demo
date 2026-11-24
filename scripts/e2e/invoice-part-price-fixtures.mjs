import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {linkedBillingSql as sql} from './linked-billing-test-support.mjs';
export function invoicePartPriceFixture() {
  assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"),'0');
  const actor=sql("select id from public.profiles where email='e2e.backoffice@p1.invalid' and active");
  const contractor=sql("select id from public.profiles where email='e2e.direct@p1.invalid' and active");
  assert.match(actor,/^[a-f0-9-]{36}$/);assert.match(contractor,/^[a-f0-9-]{36}$/);
  const suffix=randomUUID().slice(0,8),work=`E2E-PRICE-UI-${suffix}`,part=randomUUID(),number=`SYNTH-PRICE-UI-${suffix}`;
  sql(`begin;
    insert into public.work_orders(id,status,functional_status,contractor_id,contractor_assignment_version,
      workflow_cycle,lifecycle_version,contractor_assignment_started_at,store_number,store_state,summary,nte)
    values('${work}','completed','Completed','${contractor}',1,0,3,now()-interval '1 day','E2E001','TX','Synthetic compressor price editor',10000);
    insert into public.wo_parts(id,work_order_id,description,part_number,qty)
      values('${part}','${work}','Synthetic compressor price editor','SYNTHETIC-PRICE-PART',1);
    do $claims$ begin perform set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','role','authenticated')::text,true);end $claims$;
    set local role authenticated;
    do $setup$ begin perform public.request_p1_part_order('${part}'::uuid);
      perform public.set_p1_part_order_status_with_cost('${part}'::uuid,'ordered',1.01);end $setup$;
    commit;`);
  return {actor,contractor,work,part,number};
}
export function invoicePartPriceSnapshot(f) {
  assert.match(f.work,/^E2E-PRICE-UI-[a-f0-9]{8}$/);assert.match(f.part,/^[a-f0-9-]{36}$/);
  return JSON.parse(sql(`select jsonb_build_object('purchaseCost',(select unit_cost from public.p1_part_costs where part_id='${f.part}'),
    'invoices',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'number',i.num,'state',i.state,'total',i.total,
      'lines',(select jsonb_agg(to_jsonb(l) order by l.position) from public.invoice_lines l where l.invoice_id=i.id))),'[]'::jsonb)
      from public.invoices i where i.work_order_id='${f.work}' and i.invoice_type='staff'),
    'audit',(select coalesce(jsonb_agg(jsonb_build_object('actor',a.actor_id,'correction',a.correction)),'[]'::jsonb)
      from public.invoice_part_price_audit a join public.invoices i on i.id=a.invoice_id where i.work_order_id='${f.work}'))`));
}

export function addContractorPriceSource(f) {
  assert.match(f.work,/^E2E-PRICE-UI-[a-f0-9]{8}$/);
  const id=randomUUID(),lineId=randomUUID(),number=f.number+'-CONTRACTOR';
  sql(`begin;
    insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,state,invoice_date,subtotal,sales_tax,total)
      values('${id}','${number}','${f.work}','${f.contractor}','contractor','submitted',current_date,100,0,100);
    insert into public.invoice_lines(id,invoice_id,position,type,description,qty,rate)
      values('${lineId}','${id}',1,'Parts/Hardware','Synthetic contractor-supplied motor',1,100);
    commit;`);
  return {id,lineId,number};
}
