import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase,applyThrough } from './fixtures.mjs';
import { initializeLifecycleActors,actorTransactions } from '../lifecycle-test-support/engine-fixtures.mjs';
import { verifyPriorBatchesOnFinalStorageSchema } from '../storage-photo-test-support/combined-regressions.mjs';
import { createStoragePhotoFixtures } from '../storage-photo-test-support/fixtures.mjs';
import { verifyCanonicalObjectCommands } from '../storage-photo-test-support/command-acceptance.mjs';

export async function verifyPriorFinancialNotificationSchema(f,check) {
  // Existing prior suites run unchanged. Only the injected migration target and
  // output label move forward; no prior assertion or role grant is weakened.
  await verifyPriorBatchesOnFinalStorageSchema({createDatabase,
    applyThrough:(db)=>applyThrough(db,137),
    repo:fileURLToPath(new URL('../../',import.meta.url)),
    check:(name,run)=>check(name.replaceAll('Final 0132','Final 0137').replaceAll('final 0132','final 0137'),run)});
  const storage=await createDatabase();
  try {
    await applyThrough(storage,137);
    const actors=await initializeLifecycleActors(storage);
    const fixture=await createStoragePhotoFixtures({db:storage,as:actorTransactions(storage),actors});
    await verifyCanonicalObjectCommands(fixture,(name,run)=>check(`Final 0137 Storage: ${name}`,run));
  } finally {await storage.close();}
  await check('final0137 receiving assignment intent, worker unknown quarantine, safe status and explicit resolution remain compatible',async()=>{
    const target=await f.create();
    assert.ok(target.delivery);
    const receivingRpc=(name,args,actor=null,role='service_role')=>f.as(role,actor,
      tx=>tx.query(`select to_jsonb(public.${name}(${args.map((_,index)=>`$${index+1}`).join(',')})) result`,args)).then(result=>result.rows[0].result);
    const receivingClaim=token=>f.as('service_role',null,tx=>tx.query('select * from public.claim_receiving_dispatch_deliveries_v1(25,60,$1)',[token])).then(result=>result.rows);
    let token;let found=false;
    for(let pass=0;pass<100 && !found;pass++) {
      token=randomUUID();const claimed=await receivingClaim(token);
      for(const row of claimed) {
        if(row.id===target.delivery.id){found=true;continue;}
        const other=await receivingRpc('prepare_receiving_dispatch_send_v1',[row.id,token]);
        if(other)await receivingRpc('complete_receiving_dispatch_delivery_v1',[row.id,token,'sent',null,202,null]);
      }
    }
    assert.ok(found,'Receiving claim reaches target after bounded preexisting synthetic queue');
    const message=await receivingRpc('prepare_receiving_dispatch_send_v1',[target.delivery.id,token]);assert.ok(message);
    await receivingRpc('complete_receiving_dispatch_delivery_v1',[target.delivery.id,token,'unknown','GRAPH_OUTCOME_UNKNOWN',null,null]);
    const current=await receivingRpc('get_receiving_dispatch_current_v1',[target.id,target.row.contractor_assignment_version],f.actors.mgr,'authenticated');
    assert.equal(current.delivery.state,'unknown');
    const operation=randomUUID();
    const resend=await receivingRpc('request_receiving_dispatch_resend_v1',[target.delivery.id,target.row.contractor_assignment_version,operation,'Synthetic receiving resend'],f.actors.mgr,'authenticated');
    assert.equal(resend.status,'queued');
    assert.equal((await f.db.query('select status from public.contractor_receiving_dispatch_deliveries where id=$1',[target.delivery.id])).rows[0].status,'unknown');
    const next=randomUUID();const children=await receivingClaim(next);
    assert.ok(children.some(row=>row.id===resend.deliveryId));
    await receivingRpc('prepare_receiving_dispatch_send_v1',[resend.deliveryId,next]);
    await receivingRpc('complete_receiving_dispatch_delivery_v1',[resend.deliveryId,next,'unknown','GRAPH_OUTCOME_UNKNOWN',null,null]);
    const manual=await receivingRpc('resolve_receiving_dispatch_out_of_band_v1',[resend.deliveryId,target.row.contractor_assignment_version,randomUUID(),'Synthetic receiving manual contact'],f.actors.mgr,'authenticated');
    assert.equal(manual.status,'manually_resolved');
  });
}
