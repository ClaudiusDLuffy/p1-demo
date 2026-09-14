import { createDatabase, applyThrough, partsSmsFixtures } from '../parts-sms-test-support/fixtures.mjs';
import { reproduceLegacyPartsSms } from '../parts-sms-test-support/legacy-reproductions.mjs';
import { verifyLegacyPartsSms } from '../parts-sms-test-support/legacy.mjs';
import { recurrenceFixtures } from './fixtures.mjs';
import { applyPartsRecurrenceMigration } from './migration.mjs';
import { reproduceBlockedPartsRecurrence, verifyRecurrenceUpgrade } from './upgrade.mjs';
import { verifyPartsRecurrencePolicy } from './policy.mjs';
import { verifyPartsRecurrenceBoundaries } from './boundaries.mjs';
import { verifyPartsRecurrenceSecurity } from './security-atomicity.mjs';
import { verifyPartsRecurrenceActionsHistory } from './actions-history.mjs';
import { verifyPartsRecurrenceAudit } from './audit.mjs';
import { verifyPartsRecurrenceUpgradeBoundaries } from './upgrade-boundaries.mjs';
import { verifyPartsSmsDelivery } from '../parts-sms-test-support/delivery.mjs';
import { verifyPartsSmsStatusRuns } from '../parts-sms-test-support/status-runs.mjs';
import { verifyPartsSmsSecurityActions } from '../parts-sms-test-support/security-actions.mjs';
import { verifyPartsSmsPagination } from '../parts-sms-test-support/pagination.mjs';
import { verifyPartsSmsBoundsCompatibility } from '../parts-sms-test-support/bounds-compatibility.mjs';

export async function verifyPartsSmsSourceRecurrence(check) {
  const db = await createDatabase();
  try {
    await applyThrough(db, 139);
    const f = recurrenceFixtures(await partsSmsFixtures(db));
    const target = await reproduceBlockedPartsRecurrence(f, check);
    await applyPartsRecurrenceMigration(db);
    await verifyRecurrenceUpgrade(f, target, check);
    await verifyPartsRecurrencePolicy(f, check);
    await verifyPartsRecurrenceBoundaries(f, check);
    await verifyPartsRecurrenceActionsHistory(f, check);
    await verifyPartsRecurrenceSecurity(f, check);
  } finally { await db.close(); }
  await verifyPartsRecurrenceAudit(check);
  await verifyPartsRecurrenceUpgradeBoundaries(check);
}

export async function verifyPartsSmsOriginalChecksOnFinalSchema(check) {
  const db = await createDatabase();
  try {
    await applyThrough(db, 138);
    const base = await partsSmsFixtures(db);
    const finalCheck = (name, run) => check(`Final 0140: ${name}`, run);
    await reproduceLegacyPartsSms(base, finalCheck);
    await verifyLegacyPartsSms(base, finalCheck);
    base.legacyBefore = (await db.query('select * from public.p1_parts_alert_deliveries order by id')).rows;
    await applyThrough(db, 139, 139);
    await applyPartsRecurrenceMigration(db);
    const f = recurrenceFixtures(base);
    await verifyPartsSmsDelivery(f, (name, run) => {
      if (name === 'parts SMS real procurement request A then B then ordering B can recur original exact A signature') {
        console.log('POLICY REPLACEMENT (not a pass): original 0139 blocked-recurrence assertion executed before migration; final 0140 uses the approved narrow recurrence acceptance suite.');
        return Promise.resolve();
      }
      return finalCheck(name, run);
    });
    await verifyPartsSmsStatusRuns(f, finalCheck);
    await verifyPartsSmsSecurityActions(f, finalCheck);
    await verifyPartsSmsPagination(f, finalCheck);
    await verifyPartsSmsBoundsCompatibility(f, finalCheck);
  } finally { await db.close(); }
}
