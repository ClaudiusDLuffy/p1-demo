// Isolated SQL stand-ins only; no gateway, provider, real diagnostics or remote data.
import assert from 'node:assert/strict';
import { createDatabase, applyThrough, diagnosticFixtures, signature, bucketTable } from './client-diagnostic-test-support/fixtures.mjs';
import { verifyDiagnosticAdmission } from './client-diagnostic-test-support/acceptance.mjs';
import { verifyDiagnosticSecurity } from './client-diagnostic-test-support/security.mjs';
import { verifyDiagnosticAudit } from './client-diagnostic-test-support/audit.mjs';
import { verifyPriorDiagnosticSchema } from './client-diagnostic-test-support/final-schema.mjs';

assert.ok(process.argv.slice(2).every(value => ['--baseline-only', '--focused-only'].includes(value)));
const db = await createDatabase();
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
try {
  await applyThrough(db, 140);
  await check('pre0141 diagnostics has no durable admission command or cross-instance limiter bucket', async () => {
    const row = (await db.query('select to_regprocedure($1) command,to_regclass($2) ledger', [signature, `public.${bucketTable}`])).rows[0];
    assert.equal(row.command, null);
    assert.equal(row.ledger, null);
  });
  if (!process.argv.includes('--baseline-only')) {
    await check('diagnostic forward upgrade 0140 to 0141 installs service-only limiter', () => applyThrough(db, 141, 141));
    await check('diagnostic final0142 schema preserves admission while adding read-only SLA parity', () => applyThrough(db, 142, 142));
    const f = await diagnosticFixtures(db);
    await verifyDiagnosticAdmission(f, check);
    await verifyDiagnosticSecurity(f, check);
    await verifyDiagnosticAudit(f, check);
    const sorted = [...f.timings].sort((a, b) => a - b);
    console.log(`MEASURE diagnostic admission: ${sorted.length} isolated transactions; median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}ms; max ${sorted.at(-1).toFixed(2)}ms`);
    if (!process.argv.includes('--focused-only')) await verifyPriorDiagnosticSchema(check);
  }
  console.log(`Client diagnostic SQL: ${passed} passed; 0 failed.`);
  console.log('UNVERIFIED: real PostgREST/JWT and independent PostgreSQL sessions. No external diagnostic/provider request.');
} catch (error) {
  console.error(`FAIL client diagnostic SQL: ${error.code || 'ASSERTION'}`);
  if (error.code === 'ERR_ASSERTION') console.error(error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally { await db.close(); }
