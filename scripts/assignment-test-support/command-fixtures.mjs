import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInvoiceCommandFixtures } from '../invoice-test-support/command-fixtures.mjs';

export async function createAssignmentFixtures({ db,as,actors }) {
  const financial=await createInvoiceCommandFixtures({ db,as,actors });
  const identities=financial.actors;
  for (const [name,role] of [['dispatcher','dispatcher'],['backOffice','back_office']]) {
    const id=randomUUID();
    await db.query('insert into auth.users(id,email) values($1,$2)',[id,`${name}@assignment.example.invalid`]);
    await db.query('update public.profiles set role=$2,active=true,name=$3 where id=$1',[id,role,`Synthetic ${name}`]);
    identities[name]=id;
  }
  identities.nonassignable='74000000-0000-4000-8000-000000000002';
  let sequence=0;
  async function workOrder(options={}) {
    const id=`WOT95${String(++sequence).padStart(5,'0')}`;
    await db.query(`insert into public.work_orders(id,status,functional_status,contractor_id)
      values($1,$2,$3,$4)`,[id,options.status || 'unassigned',options.functional || 'New',options.owner || null]);
    return id;
  }
  async function context(id,operationId=randomUUID()) {
    const row=(await db.query(`select contractor_assignment_version,workflow_cycle,lifecycle_version
      from public.work_orders where id=$1`,[id])).rows[0];
    assert.ok(row);
    return [id,row.contractor_assignment_version,row.workflow_cycle,Number(row.lifecycle_version),operationId];
  }
  function query(tx,family,args,payload=null) {
    const signatures={ transition:'transition_work_order_contractor_v1',reject:'reject_unassigned_work_order_v1',
      duplicate:'duplicate_work_order_for_reassignment_v1' };
    assert.ok(Object.hasOwn(signatures,family));
    const values=family === 'duplicate' ? args : [args[0],payload,...args.slice(1)];
    return tx.query(`select public.${signatures[family]}(${values.map((_,index)=>`$${index+1}`).join(',')}) result`,values);
  }
  async function command(family,actor,args,payload=null,role='authenticated') {
    return (await as(role,actor,tx=>query(tx,family,args,payload))).rows[0].result;
  }
  async function snapshot() {
    const tables=['work_orders','work_order_financials','work_order_visits','wo_parts','work_order_assignment_history','activities','contractor_assignment_transition_deliveries',
      'work_order_assignment_operations','work_order_assignment_command_guards','work_order_assignment_transition_guards'];
    const result={};
    for (const table of tables) {
      result[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') rows from public.${table} t`)).rows[0].rows;
    }
    return result;
  }
  async function parent(id) { return (await db.query('select * from public.work_orders where id=$1',[id])).rows[0]; }
  async function reject(run,codes=['42501','PT409','22023','23514','P0002']) {
    await assert.rejects(run,error=>codes.includes(error.code), 'The complete assignment command must fail');
  }
  async function rawDenied(actor,sql,values=[],role='authenticated') {
    const before=await snapshot();
    try {
      const result=await as(role,actor,tx=>tx.query(sql,values));
      assert.equal(result.rows.length,0,'RLS denial can affect zero rows but cannot return an updated target');
    } catch(error) { assert.ok(['42501','23514','PT409'].includes(error.code),`Expected authorization denial, received ${error.code}`); }
    assert.deepEqual(await snapshot(),before,'Denied raw write must leave all assignment state unchanged');
  }
  return { db,as,actors:identities,financial,lifecycle:financial.lifecycle,workOrder,context,query,command,snapshot,parent,reject,rawDenied };
}
