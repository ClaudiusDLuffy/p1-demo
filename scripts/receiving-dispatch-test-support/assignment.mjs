import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { administrativeTransferFixtures } from '../assignment-test-support/administrative-transfer-fixtures.mjs';
import { deliveryTable, withWriteFailure } from './fixtures.mjs';

export async function verifyCloseoutAssignment(f, check) {
  const deliveries = id => f.db.query(`select * from public.${deliveryTable} where work_order_id=$1 order by created_at,id`, [id]).then(result => result.rows);
  for (const email of [false, true]) {
    await check(`${email ? 'trusted email' : 'manual'} create-and-assign queues exactly once and replay preserves the same intent`, async () => {
      const target = await f.create({ email });
      assert.equal((await deliveries(target.id)).length, 1);
      assert.equal(target.delivery.assignment_version, target.row.contractor_assignment_version);
      assert.equal(target.delivery.recipient_profile_id, target.row.contractor_id);
      assert.equal(target.delivery.status, 'pending');
      await f.create({ email, id: target.id, operation: target.operation });
      assert.equal((await deliveries(target.id)).length, 1);
      assert.equal((await f.current(target)).delivery.id, target.delivery.id);
    });
  }
  await check('initial transition, reassignment, unassignment, duplicate continuation preserve separate event ownership', async () => {
    const target = await f.create({ owner: null });
    assert.equal((await deliveries(target.id)).length, 0);
    await f.assignment.command('transition', f.actors.mgr, await f.assignment.context(target.id), f.actors.contractor);
    assert.equal((await deliveries(target.id)).length, 1);
    const args = await f.assignment.context(target.id);
    const assigned = await f.assignment.command('transition', f.actors.mgr, args, f.actors.outsider);
    assert.ok(assigned.deliveryId, 'Outgoing contractor transition remains separate');
    assert.equal((await deliveries(target.id)).length, 2);
    const outgoing = (await f.db.query('select * from public.contractor_assignment_transition_deliveries where id=$1', [assigned.deliveryId])).rows[0];
    assert.equal(outgoing.outgoing_contractor_id, f.actors.contractor);
    assert.equal((await deliveries(target.id))[1].recipient_profile_id, f.actors.outsider);
    await f.assignment.command('transition', f.actors.mgr, args, f.actors.outsider);
    assert.equal((await deliveries(target.id)).length, 2);
    await f.assignment.command('transition', f.actors.mgr, await f.assignment.context(target.id), null);
    assert.equal((await deliveries(target.id)).length, 2);
    const source = await f.create();
    const duplicate = await f.assignment.command('duplicate', f.actors.mgr, await f.assignment.context(source.id));
    assert.equal((await deliveries(duplicate.workOrderId)).length, 0, 'Duplicate creates an unassigned continuation');
    await f.assignment.command('transition', f.actors.mgr, await f.assignment.context(duplicate.workOrderId), f.actors.outsider);
    assert.equal((await deliveries(duplicate.workOrderId)).length, 1);
  });
  await check('rejection of pristine unassigned work creates no receiving intent', async () => {
    const target = await f.create({ owner: null });
    await f.assignment.command('reject', f.actors.mgr, await f.assignment.context(target.id), 'Synthetic rejected duplicate');
    assert.equal((await deliveries(target.id)).length, 0);
  });
  await check('administrative active-visit transfer queues the new receiving assignment atomically', async () => {
    const hybrid = administrativeTransferFixtures(f.assignment);
    const { id } = await hybrid.activeWorkOrder();
    const before = await deliveries(id);
    await hybrid.transfer(await f.assignment.context(id), f.actors.outsider);
    const after = await deliveries(id);
    assert.equal(after.length, before.length + 1);
    assert.equal(after.at(-1).recipient_profile_id, f.actors.outsider);
    assert.equal(after.at(-1).assignment_version, (await f.parent(id)).contractor_assignment_version);
  });
  for (const email of [false, true]) {
    await check(`receiving-intent insert failure rolls back ${email ? 'trusted email' : 'manual'} work-order creation`, async () => {
      const id = email ? 'WOT9799991' : 'WOT9799990';
      await withWriteFailure(f.db, deliveryTable, 'insert', () => f.denied(() => f.create({ id, email }), ['P0001']));
      assert.equal(await f.parent(id), undefined);
      assert.equal((await deliveries(id)).length, 0);
    });
  }
  await check('receiving-intent failure rolls back assignment version, evidence, and outgoing delivery', async () => {
    const target = await f.create();
    const assignmentBefore = await f.assignment.snapshot();
    const dispatchBefore = await f.snapshot();
    const args = await f.assignment.context(target.id);
    await withWriteFailure(f.db, deliveryTable, 'insert', () => f.denied(() => f.assignment.command('transition', f.actors.mgr,
      args, f.actors.outsider), ['P0001']));
    assert.deepEqual(await f.assignment.snapshot(), assignmentBefore);
    assert.deepEqual(await f.snapshot(), dispatchBefore);
  });
  await check('current status detects a corrupt second live original candidate without selecting an arbitrary record', async () => {
    const target = await f.create();
    const rollback = new Error('Rollback synthetic identity corruption');
    await assert.rejects(() => f.db.transaction(async tx => {
      await tx.exec(`alter table public.${deliveryTable} disable trigger user`);
      await tx.query(`insert into public.${deliveryTable}(id,work_order_id,assignment_version,event_type,recipient_profile_id)
        values($1,$2,$3,'reassignment',$4)`, [randomUUID(), target.id, target.row.contractor_assignment_version, f.actors.contractor]);
      await tx.exec(`alter table public.${deliveryTable} enable trigger user`);
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true)", [f.actors.mgr]);
      try {
        await tx.query('select public.get_receiving_dispatch_current_v1($1,$2)', [target.id, target.row.contractor_assignment_version]);
      } catch (error) { assert.equal(error.code, 'PT409'); throw rollback; }
      assert.fail('Multiple current candidates must be an integrity conflict');
    }), error => error === rollback);
  });
}
