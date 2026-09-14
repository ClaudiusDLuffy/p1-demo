import './pagination-test-support/syntheticSqlPrivacy.mjs';
import { verifyPriorPaginationSchema } from './pagination-test-support/final-schema.mjs';
import { createDatabase, applyThrough, diagnosticFixtures } from './client-diagnostic-test-support/fixtures.mjs';
import { verifyDiagnosticAdmission } from './client-diagnostic-test-support/acceptance.mjs';
import { verifyDiagnosticSecurity } from './client-diagnostic-test-support/security.mjs';
import { verifyDiagnosticAudit } from './client-diagnostic-test-support/audit.mjs';
import { slaFixtures, reproduceSlaReadDivergence } from './sla-read-test-support/fixtures.mjs';
import { verifySlaMigration } from './sla-read-test-support/migration-audit.mjs';
import { verifySlaSqlParity } from './sla-read-test-support/parity.mjs';
import { verifySlaReadApis } from './sla-read-test-support/reads.mjs';
import { syntheticSqlPrivacyReceipt } from './pagination-test-support/syntheticSqlPrivacy.mjs';

let checks = 0;
const check = async (label, run) => { await run(); checks++; console.log(`PASS ${label}`); };
try {
  // Original prior acceptance functions execute unchanged on the final schema.
  // The single historical blocked-recurrence assertion remains explicitly
  // identified by the inherited suite; approved recurrence checks replace it.
  await verifyPriorPaginationSchema(check, 145);
  const diagnostics = await createDatabase();
  try {
    await applyThrough(diagnostics, 145);
    const fixture = await diagnosticFixtures(diagnostics);
    await verifyDiagnosticAdmission(fixture, check);
    await verifyDiagnosticSecurity(fixture, check);
    await verifyDiagnosticAudit(fixture, check);
  } finally { await diagnostics.close(); }
  const sla = await createDatabase();
  try {
    await applyThrough(sla, 141);
    const fixture = await slaFixtures(sla);
    const baseline = await reproduceSlaReadDivergence(fixture, check);
    const definitions = await fixture.definitions();
    const rows = await fixture.assignment.snapshot();
    await applyThrough(sla, 145, 142);
    await verifySlaMigration(fixture, definitions, rows, check);
    await verifySlaSqlParity(fixture, check);
    await verifySlaReadApis(fixture, baseline, check);
  } finally { await sla.close(); }
  console.log(JSON.stringify({ finalMigration: 145, priorPhaseChecks: checks, failed: 0,
    privacy: syntheticSqlPrivacyReceipt(), hostedCertification: false }));
} catch (error) {
  console.error(`FAIL final-schema regression: ${typeof error?.code === 'string' ? error.code : 'ASSERTION'}`);
  if (error?.code === 'ERR_ASSERTION') console.error(error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 5).join('\n'));
  process.exitCode = 1;
}
