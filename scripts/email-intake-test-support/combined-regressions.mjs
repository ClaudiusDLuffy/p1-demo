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

// These are the actual previous-batch acceptance routines, run unchanged on
// the final 0131 schema. Separate older harness success alone would not prove
// that a new authorization policy preserves existing transaction commands.
export async function verifyPriorBatchesOnFinalEmailSchema({createDatabase,applyThrough,check}) {
  const db=await createDatabase();
  try {
    await applyThrough(db,131);
    const actors=await initializeLifecycleActors(db);
    const nonassignable='74000000-0000-4000-8000-000000000002';
    await db.query('insert into auth.users(id,email) values($1,$2)',[nonassignable,'synthetic-nonassignable@intake.example.invalid']);
    await db.query("update public.profiles set role='contractor',active=true,is_assignable=false where id=$1",[nonassignable]);
    const fixture=await createAssignmentFixtures({db,as:actorTransactions(db),actors});
    const checked=(name,run)=>check(name.startsWith('REVIEW GATE')?`${name} (final 0131 compatibility only)`:`Final 0131 regression: ${name}`,run);
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
}
