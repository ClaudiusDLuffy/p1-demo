// Separate exact decision over already captured evidence; no DB work or production mutation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const directory = process.argv[2];
assert.ok(typeof directory === 'string' && directory.startsWith('/private/tmp/p1-phase7c3p-controlled-photo-capture-'));
const index = JSON.parse(readFileSync(join(directory, 'INDEX.json'), 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
assert.ok(Array.isArray(index.receipts) && Array.isArray(index.artifacts));
const reports = [];
for (const receipt of index.receipts) {
  assert.ok(Number.isInteger(receipt.index) && receipt.index >= 1 && receipt.index <= 5);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, `process-${receipt.index}.receipt.json`), 'utf8')), receipt);
  for (const kind of ['stdout', 'stderr']) {
    assert.equal(receipt[kind].path, join(directory, `process-${receipt.index}.${kind}.log`));
    assert.equal(hash(receipt[kind].path), receipt[kind].sha256, `Raw ${kind} integrity`);
  }
}
for (const artifact of index.artifacts) {
  assert.match(artifact.path, /^\/private\/tmp\/p1-phase7c3p-photo-measured-[1-5]-[a-zA-Z0-9]+\/evidence\.json$/);
  assert.equal(hash(artifact.path), artifact.sha256, 'Indexed measurement artifact integrity');
  const report = JSON.parse(readFileSync(artifact.path, 'utf8'));
  reports.push(report);
  for (const ref of [report.planEvidence?.catalogArtifact, ...(report.planEvidence?.artifacts ?? []).map(item => item.artifact)].filter(Boolean)) {
    assert.ok(ref.path.startsWith(artifact.path.slice(0, -'evidence.json'.length)));
    assert.equal(hash(ref.path), ref.sha256, 'Indexed exact/inner/nested plan artifact integrity');
  }
}
const failures = [...index.comparison.issues];
for (const receipt of index.receipts) {
  if (receipt.exitCode !== 0 || receipt.timedOut || receipt.sourceFreeze !== 'PASS') failures.push(`PROCESS_${receipt.index}_EXECUTION_OR_SOURCE_INTEGRITY_FAILED`);
}
const primary = reports.find(report => report.runIndex === 1);
if (!primary) failures.push('PRIMARY_ACTOR_PLAN_AND_CORRECTNESS_EVIDENCE_MISSING');
else {
  if (!Array.isArray(primary.correctness) || primary.correctness.some(item => item.result !== 'PASS')) failures.push('RETAINED_CORRECTNESS_FAILURE');
  for (const actor of ['inactive', 'formerTechnician', 'otherCompany']) {
    if (!primary.correctness?.some(item => item.actor === actor && item.classification === 'Correctness, never substitute for authorized performance'
      && item.result === 'PASS')) failures.push(`REQUIRED_DENIAL_${actor}_MISSING_OR_FAILED`);
  }
  if (!Array.isArray(primary.resets) || primary.resets.length !== 10 || primary.resets.some(item => item.status !== 'success')) {
    failures.push('SAME_BACKEND_RESET_DIAGNOSTIC_INCOMPLETE_NOT_NEW_SESSIONS');
  }
  for (let reset = 0; reset < 10; reset++) {
    for (const variant of ['default_first_page', 'default_continuation']) {
      const attempts = primary.samples?.filter(sample => sample.category === 'same_backend_reset_diagnostic' && sample.sampleIndex === reset && sample.variant === variant) ?? [];
      if (attempts.length !== 1 || attempts[0].status !== 'success') failures.push('RETAINED_RESET_READ_FAILURE_OR_MISSING_SAMPLE');
    }
  }
  const plans = primary.planEvidence;
  if (!plans) failures.push('REQUIRED_ROLE_EQUIVALENT_PLAN_EVIDENCE_MISSING');
  else {
    if (plans.result !== 'LOCAL_CAPTURE_COMPLETED_NOT_MIGRATION_APPROVAL' || plans.failures?.length
      || plans.capability?.runtimeLoaded !== true || plans.capability?.failure !== null) failures.push('PLAN_CAPTURE_INCOMPLETE_OR_ENGINE_CAPABILITY_LIMITATION');
    if (!plans.catalogArtifact || !Array.isArray(plans.requested) || !Array.isArray(plans.artifacts)
      || !plans.requested.length || plans.requested.length !== plans.artifacts.length) failures.push('PLAN_REQUEST_ARTIFACT_COVERAGE_INCOMPLETE');
    const key = item => JSON.stringify([item.actor, item.variant, item.parent, item.inputCursor, item.limit, item.mode, item.nestedRequested]);
    const artifacts = plans.artifacts ?? [];
    for (const request of plans.requested ?? []) {
      const matches = artifacts.filter(item => key(item) === key(request));
      if (matches.length !== 1 || matches[0].result !== 'EXACT_AND_INNER_CAPTURED') failures.push('PLAN_REQUEST_NOT_SATISFIED_EXACTLY_ONCE');
    }
    for (const summary of primary.summaries ?? []) {
      if (!summary.expected?.actorAuthorized || !summary.distributions?.warmApplicationRead) continue;
      const expected = summary.expected;
      if (!artifacts.some(item => item.mode === 'auto' && item.actor === expected.actor && item.variant === expected.variant
        && item.parent === expected.parent && item.inputCursor === expected.inputCursor && item.limit === expected.limit)) {
        failures.push('AUTHORIZED_MEASURED_VARIANT_PLAN_MISSING');
      }
    }
    const nested = artifacts.filter(item => item.mode === 'auto' && item.nestedRequested);
    if (!nested.length || nested.some(item => !Number.isInteger(item.nestedNoticeCount) || item.nestedNoticeCount <= 0
      || !Number.isInteger(item.nestedCandidateCount) || item.nestedCandidateCount <= 0)) failures.push('ACTUAL_NESTED_HELPER_PLAN_NOT_ESTABLISHED');
  }
}
if (!index.comparison.warmBudgetPass) failures.push('WARM_P95_EXCEEDS_UNCHANGED_500_MS_OR_UNRESOLVED_SAMPLE_FAILURE');
if (!index.comparison.crossProcessParity) failures.push('RESULT_PARITY_FAILURE');
if (index.comparison.trueNewSessions !== 'TEN_GENUINE_AUTHENTICATED_SESSIONS_VERIFIED') failures.push('TEN_GENUINE_NEW_SESSIONS_UNAVAILABLE');
console.log(JSON.stringify({ verdict: failures.length ? 'CORRECTED_BEFORE_GATE_FAILED' : 'CORRECTED_BEFORE_GATE_PASSED',
  failures: [...new Set(failures)], originalFailed500msAssertionUnchanged: true, migrationCreated: false, extractionStarted: false }, null, 2));
process.exitCode = failures.length ? 1 : 0;
