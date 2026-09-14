import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInvoiceCommandFixtures } from '../invoice-test-support/command-fixtures.mjs';

// Accepted operations are created against actual 0128, then replayed after the
// 0129 schema expansion. Nullable columns must not invalidate old snapshots.
export async function preparePreAssignmentFinancialReplay({ db,as,actors }) {
  const financial=await createInvoiceCommandFixtures({ db,as,actors });
  const id=await financial.workOrder();const args=await financial.context(id);const input=financial.payload();
  const accepted=await financial.command('draft',actors.contractor,args,input);
  return { financial,verify:async check=>{
    await check('accepted pre0127 financial operation survives assignment and hybrid metadata expansions without historical backfill',async()=>{
      const replay=await financial.command('draft',actors.contractor,args,input);
      assert.equal(replay.reason,'already_applied');assert.equal(replay.invoiceId,accepted.invoiceId);
      assert.equal((await financial.snapshot(id)).invoices.length,1);
      assert.equal((await financial.document(replay.invoiceId)).lines.length,input.lines.length);
    });
  } };
}

export async function preparePreHybridReplay({ db,as,actors,financial }) {
  const assignedId='WOT9780101';const lifecycleId='WOT9780102';
  await db.query("insert into public.work_orders(id,status,functional_status) values($1,'unassigned','New')",[assignedId]);
  const assignmentValues=[assignedId,actors.contractor,0,0,0,randomUUID()];
  const assignment=()=>as('authenticated',actors.mgr,tx=>tx.query(
    'select public.transition_work_order_contractor_v1($1,$2,$3,$4,$5,$6) result',assignmentValues));
  const acceptedAssignment=(await assignment()).rows[0].result;
  await db.query(`insert into public.work_orders(id,status,functional_status,contractor_id,contractor_assignment_started_at)
    values($1,'assigned','Dispatched',$2,now()-interval '1 hour')`,[lifecycleId,actors.contractor]);
  const row=(await db.query('select contractor_assignment_version,workflow_cycle,lifecycle_version from public.work_orders where id=$1',[lifecycleId])).rows[0];
  const lifecycleValues=[lifecycleId,row.contractor_assignment_version,row.workflow_cycle,row.lifecycle_version,randomUUID(),new Date(Date.now()-60_000).toISOString(),null];
  const lifecycle=()=>as('authenticated',actors.contractor,tx=>tx.query(
    'select public.start_work_order_visit_v1($1,$2,$3,$4,$5,$6,$7) result',lifecycleValues));
  const acceptedLifecycle=(await lifecycle()).rows[0].result;
  const financialId=await financial.workOrder();const financialArgs=await financial.context(financialId);const financialInput=financial.payload();
  const acceptedFinancial=await financial.command('draft',actors.contractor,financialArgs,financialInput);
  return async check=>{
    await check('accepted pre0129 assignment operation replays after new activity metadata without duplicate evidence',async()=>{
      const replay=(await assignment()).rows[0].result;assert.equal(replay.reason,'already_applied');
      assert.equal(replay.operationId,acceptedAssignment.operationId);assert.equal(replay.assignmentVersion,acceptedAssignment.assignmentVersion);
      assert.equal((await db.query('select count(*)::int count from public.activities where assignment_operation_id=$1',[assignmentValues[5]])).rows[0].count,1);
    });
    await check('accepted pre0129 lifecycle start replays after new visit metadata without duplicate visit',async()=>{
      const replay=(await lifecycle()).rows[0].result;assert.equal(replay.reason,'already_applied');
      assert.equal(replay.visitId,acceptedLifecycle.visitId);
      assert.equal((await db.query('select count(*)::int count from public.work_order_visits where work_order_id=$1',[lifecycleId])).rows[0].count,1);
    });
    await check('accepted pre0129 financial draft replays after new activity metadata without duplicate invoice or lines',async()=>{
      const replay=await financial.command('draft',actors.contractor,financialArgs,financialInput);
      assert.equal(replay.reason,'already_applied');assert.equal(replay.invoiceId,acceptedFinancial.invoiceId);
      const invoice=await financial.document(replay.invoiceId);assert.equal(invoice.lines.length,financialInput.lines.length);
      assert.equal((await financial.snapshot(financialId)).invoices.length,1);
    });
  };
}
