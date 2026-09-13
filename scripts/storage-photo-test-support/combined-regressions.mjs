import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeLifecycleActors,actorTransactions } from '../lifecycle-test-support/engine-fixtures.mjs';
import { createAssignmentFixtures } from '../assignment-test-support/command-fixtures.mjs';
import { verifyLifecycleCommands } from '../lifecycle-test-support/command-acceptance.mjs';
import { verifyLifecycleAtomicity } from '../lifecycle-test-support/atomicity-acceptance.mjs';
import { verifyLifecycleInterleavings } from '../lifecycle-test-support/concurrency-compatibility.mjs';
import { verifyContractorFinancialCommands } from '../invoice-test-support/contractor-acceptance.mjs';
import { verifyStaffFinancialCommands } from '../invoice-test-support/staff-acceptance.mjs';
import { verifyFinancialDeleteAndEvidence } from '../invoice-test-support/delete-evidence-acceptance.mjs';
import { verifyAssignmentCommands } from '../assignment-test-support/command-acceptance.mjs';
import { verifyRejectionAndDuplication } from '../assignment-test-support/rejection-duplicate-acceptance.mjs';
import { verifyAssignmentCreationAndDelivery } from '../assignment-test-support/creation-delivery-acceptance.mjs';
import { verifyAdministrativeTransfers } from '../assignment-test-support/administrative-transfer-acceptance.mjs';
import { verifyAdministrativeTransferSecurity } from '../assignment-test-support/administrative-transfer-security.mjs';
import { verifyAdministrativeTransferAtomicity } from '../assignment-test-support/administrative-transfer-atomicity.mjs';
import { verifyAdministrativeContinuation } from '../assignment-test-support/administrative-transfer-continuation.mjs';
import { createEmailSecurityFixtures } from '../email-intake-test-support/fixtures.mjs';
import { verifyEmailReceipts,verifyEmailReceiptValidation } from '../email-intake-test-support/receipt-acceptance.mjs';
import { verifyActiveEmailAuthorization,verifyEmailRawAndGrants } from '../email-intake-test-support/authorization-acceptance.mjs';
import { verifyEmailReceiptAtomicity,verifyEmailAudit,verifyEmailAuditAnomalies } from '../email-intake-test-support/atomicity-and-release.mjs';

// Actual earlier-batch routines execute unchanged on final 0132. Separate old
// harnesses stopping at 0123/0125/0128/0130 do not establish this compatibility.
export async function verifyPriorBatchesOnFinalStorageSchema({createDatabase,applyThrough,check,repo}) {
  let currentCase='';
  const checked=(name,run)=>check(name.startsWith('REVIEW GATE')
    ? `${name} (final 0132 compatibility only)` : `Final 0132 regression: ${name}`,async()=>{
      currentCase=name;
      try { await run(); } finally { currentCase=''; }
    });
  const db=await createDatabase();
  try {
    await applyThrough(db,132);
    const actors=await initializeLifecycleActors(db);
    const nonassignable='74000000-0000-4000-8000-000000000002';
    await db.query('insert into auth.users(id,email) values($1,$2)',[nonassignable,'synthetic-nonassignable@storage.example.invalid']);
    await db.query("update public.profiles set role='contractor',active=true,is_assignable=false where id=$1",[nonassignable]);
    const fixture=await createAssignmentFixtures({db,as:actorTransactions(db),actors});
    const originalCommand=fixture.financial.command;
    fixture.financial.command=async(...args)=>{
      const result=await originalCommand(...args);
      if(currentCase==='existing draft financial save/submission preserves its supported original PDF reference'
        && args[0]==='draft') {
        const path=`${result.invoiceId}/synthetic-original.pdf`;
        const existing=await db.query('select id from public.private_object_bindings where bucket=$1 and object_path=$2',['invoice-pdfs',path]);
        if(!existing.rows.length) {
          // The unchanged prior positive control uses a fixed legacy filename,
          // not a new intent UUID. First prove that old unbound attach is now
          // denied, then seed an explicitly owner-verified synthetic legacy
          // document as its prerequisite. The real authenticated attach and
          // financial save/submit assertions still run unchanged below. This
          // does NOT certify new-upload decoding or invent new_validated facts.
          await assert.rejects(()=>fixture.as('authenticated',actors.contractor,tx=>tx.query(
            'select public.attach_contractor_invoice_pdf($1,$2)',[result.invoiceId,path])),error=>error.code==='42501');
          const objectId=randomUUID();
          await db.query('insert into storage.objects(id,bucket_id,name,owner,metadata) values($1,$2,$3,$4,$5)',
            [objectId,'invoice-pdfs',path,actors.contractor,JSON.stringify({mimetype:'application/pdf',size:128})]);
          await db.query(`insert into public.private_object_bindings(id,bucket,object_path,storage_object_id,purpose,
            work_order_id,parent_id,actor_id,assignment_version,workflow_cycle,validation,review_reference)
            select $1,'invoice-pdfs',$2,$3,'invoice_original',i.work_order_id,i.id,i.created_by,
              w.contractor_assignment_version,w.workflow_cycle,'legacy_reviewed','Synthetic approved prior-PDF compatibility fixture'
            from public.invoices i join public.work_orders w on w.id=i.work_order_id where i.id=$4`,
          [randomUUID(),path,objectId,result.invoiceId]);
          assert.equal((await db.query('select pdf_storage_path from public.invoices where id=$1',[result.invoiceId])).rows[0].pdf_storage_path,null,
            'Fixture prerequisite must not bypass the actual authenticated invoice attachment write');
        }
      }
      return result;
    };
    await verifyLifecycleCommands(fixture.lifecycle,checked);
    await verifyLifecycleAtomicity(fixture.lifecycle,checked);
    await verifyLifecycleInterleavings(fixture.lifecycle,checked);
    await verifyContractorFinancialCommands(fixture.financial,checked);
    await verifyStaffFinancialCommands(fixture.financial,checked);
    await verifyFinancialDeleteAndEvidence(fixture.financial,checked);
    await verifyAssignmentCommands(fixture,checked);
    await verifyRejectionAndDuplication(fixture,checked);
    await verifyAssignmentCreationAndDelivery(fixture,checked);
    await verifyAdministrativeTransfers(fixture,checked);
    await verifyAdministrativeTransferSecurity(fixture,checked);
    await verifyAdministrativeTransferAtomicity(fixture,checked);
    await verifyAdministrativeContinuation(fixture,checked);
  } finally { await db.close(); }

  // Fixed earlier fixture identifiers deliberately live in a second disposable
  // final-schema database; do not rewrite their actors or weaken constraints.
  const intake=await createDatabase();
  try {
    await applyThrough(intake,132);
    const actors=await initializeLifecycleActors(intake);
    const fixture=await createEmailSecurityFixtures({db:intake,as:actorTransactions(intake),actors});
    await verifyActiveEmailAuthorization(fixture,checked);
    await verifyEmailReceipts(fixture,checked);
    await verifyEmailReceiptValidation(fixture,checked);
    await verifyEmailRawAndGrants(fixture,checked);
    await verifyEmailReceiptAtomicity(fixture,checked);
    await verifyEmailAudit(intake,repo,checked,'Final 0132 prior intake audit');
    await verifyEmailAuditAnomalies(fixture,repo,checked);
  } finally { await intake.close(); }
}
