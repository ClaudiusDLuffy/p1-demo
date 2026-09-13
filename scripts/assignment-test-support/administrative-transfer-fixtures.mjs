import assert from 'node:assert/strict';

export const ADMINISTRATIVE_TRANSFER_EVENT = 'visit_administratively_closed_for_transfer';
export const ADMINISTRATIVE_TRANSFER_RPC = 'administrative_close_visit_and_transfer_v1';
export const TRANSFER_REASON = 'Synthetic emergency contractor transfer; actual duration requires review';

export function administrativeTransferFixtures(fixture) {
  const { db,as,actors,lifecycle }=fixture;
  async function activeWorkOrder(options={}) {
    const id=await lifecycle.workOrder({ status:'wip',functional:'Work in Progress',visit:true,...options });
    const visit=(await db.query('select * from public.work_order_visits where work_order_id=$1 and check_out_at is null',[id])).rows[0];
    assert.ok(visit);
    return { id,visit };
  }
  function query(tx,args,target,reason=TRANSFER_REASON,confirmed=true) {
    const values=[args[0],target,...args.slice(1),reason,confirmed];
    return tx.query(`select public.${ADMINISTRATIVE_TRANSFER_RPC}(${values.map((_,index)=>`$${index+1}`).join(',')}) result`,values);
  }
  async function transfer(args,target=actors.outsider,reason=TRANSFER_REASON,confirmed=true,actor=actors.mgr,role='authenticated') {
    return (await as(role,actor,tx=>query(tx,args,target,reason,confirmed))).rows[0].result;
  }
  async function visit(id) { return (await db.query('select * from public.work_order_visits where id=$1',[id])).rows[0]; }
  async function events(id) {
    return (await db.query('select * from public.activities where work_order_id=$1 order by created_at,id',[id])).rows;
  }
  async function freshVisit(kind,actor,id) {
    // Keep server microsecond precision so an immediate synthetic receiving
    // check-in cannot precede the just-written assignment within one JS ms.
    const stamp=(await db.query('select clock_timestamp()::text stamp')).rows[0].stamp;
    return lifecycle.command(kind,actor,await lifecycle.context(id),[stamp,'Synthetic receiving contractor continuation']);
  }
  return { ...fixture,activeWorkOrder,queryTransfer:query,transfer,visit,events,freshVisit };
}

// Controlled AFTER-write failures exist only in this isolated synthetic test DB.
export async function withAdministrativeTransferFailure(db,{ table,operation,condition='true' },run) {
  assert.ok(['work_orders','work_order_visits','work_order_assignment_history','activities',
    'contractor_assignment_transition_deliveries','work_order_assignment_operations'].includes(table));
  assert.ok(['insert','update'].includes(operation));
  assert.ok(['true',`new.event_key = '${ADMINISTRATIVE_TRANSFER_EVENT}'`,
    "new.event_key = 'work_order_reassigned'","new.event_key = 'work_order_unassigned'"].includes(condition));
  await db.exec(`create or replace function pg_temp.fail_administrative_transfer_fixture()
    returns trigger language plpgsql as $$ begin
      if ${condition} then raise exception 'Synthetic administrative transfer post-write failure' using errcode='P0001'; end if;
      return new;
    end $$;
    create trigger administrative_transfer_fixture_failure after ${operation} on public.${table}
      for each row execute function pg_temp.fail_administrative_transfer_fixture();`);
  try { await run(); }
  finally { await db.exec(`drop trigger administrative_transfer_fixture_failure on public.${table}`); }
}
