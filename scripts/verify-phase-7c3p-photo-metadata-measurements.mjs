// Test-only sequential synthetic measurements; requires the verified preservation/baseline gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repository = '/Users/nxs/projects/p1-demo';
const manifest = '/Users/nxs/p1-stabilization-recovery/2026-09-13/pre-phase7c3p-photo-plan-investigation-2gwUjO/all-source-baseline.json';
const privacy = path.join(repository, 'scripts/pagination-test-support/syntheticSqlPrivacy.mjs');
const networkGuard = '/private/tmp/p1-phase7c1-controller-review-Mf37Tx/no-network.mjs';
const worker = '/Users/nxs/projects/p1-demo/scripts/photo-plan-test-support/worker.mjs';
const sourcePaths = [fileURLToPath(import.meta.url), worker, '/Users/nxs/projects/p1-demo/scripts/photo-plan-test-support/experiment.mjs',
  '/Users/nxs/projects/p1-demo/scripts/photo-plan-test-support/plans.mjs', '/Users/nxs/projects/p1-demo/scripts/verify-phase-7c3p-photo-metadata-gate.mjs',
  '/Users/nxs/projects/p1-demo/src/lib/photo-plan-test-support/measurement.ts', privacy, networkGuard];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceManifest = JSON.parse(fs.readFileSync(manifest, 'utf8'));
assert.ok(Array.isArray(sourceManifest.records) && sourceManifest.records.length === 1220);
const protectedSources = sourceManifest.records;
const frozenHelpers = sourcePaths.map(file => ({ path: file, sha256: hash(file) }));
const protect = () => {
  for (const source of protectedSources) assert.equal(hash(path.join(repository, source.path)), source.sha256, `Original source changed: ${source.path}`);
  for (const source of frozenHelpers) assert.equal(hash(source.path), source.sha256, `Experiment helper changed: ${source.path}`);
};
protect();
const output = fs.mkdtempSync('/private/tmp/p1-phase7c3p-controlled-photo-capture-'); fs.chmodSync(output, 0o700);
const write = (name, value) => fs.writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: '/private/tmp',
  TZ: 'Asia/Manila', LANG: 'C.UTF-8', NEXT_TELEMETRY_DISABLED: '1', npm_config_userconfig: '/dev/null',
  P1_SQL_TEST_ENGINE_DIR: '/private/tmp/p1-phase6a-sql-engine.ED2BUV',
  NODE_OPTIONS: `--import=${privacy} --import=${networkGuard}` };
const startedAt = new Date().toISOString();
write('plan.json', { startedAt, repository, output, manifest, sourceManifestSha256: hash(manifest),
  protectedSources: protectedSources.length, frozenHelpers, workers: 5,
  concurrency: 1, budget: 'Unchanged 500 ms warm p95; collector does not label budget failure as command failure/pass',
  trueNewSessions: 'Unavailable in single-connection PGlite. Ten reset diagnostics do not replace required sessions.',
  safeScope: 'Isolated generated SQL fixtures only; no external environment variables, provider calls, dependency install, or repository writes' });
console.log(JSON.stringify({ output, workers: 5 }));
const receipts = [], artifacts = [];
for (let index = 1; index <= 5; index++) {
  protect();
  const args = ['--import', privacy, '--import', networkGuard, '--import', 'tsx', worker, `--process-index=${index}`];
  const stdout = path.join(output, `process-${index}.stdout.log`), stderr = path.join(output, `process-${index}.stderr.log`);
  const out = fs.openSync(stdout, 'wx', 0o600), err = fs.openSync(stderr, 'wx', 0o600);
  const started = new Date().toISOString(), monotonicStarted = performance.now();
  console.log(JSON.stringify({ phase: 'process_started', index, started, stdout, stderr }));
  const child = spawn(process.execPath, args, { cwd: repository, env, stdio: ['ignore', out, err] });
  let timedOut = false, forcedKill;
  const timeoutMs = index === 1 ? 1800000 : 900000;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM');
    forcedKill = setTimeout(() => child.kill('SIGKILL'), 10000); }, timeoutMs);
  const outcome = await new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: null, signal: null, error: { name: error.name, code: error.code } }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, error: null }));
  });
  clearTimeout(timeout); clearTimeout(forcedKill); fs.closeSync(out); fs.closeSync(err);
  const commandTotalMs = performance.now() - monotonicStarted;
  let artifact = null;
  const lines = fs.readFileSync(stdout, 'utf8').split('\n');
  for (const line of lines) {
    let value; try { value = JSON.parse(line); } catch { continue; }
    if (typeof value.output === 'string' && value.output.startsWith(`/private/tmp/p1-phase7c3p-photo-measured-${index}-`)) {
      const file = path.join(value.output, 'evidence.json');
      if (fs.existsSync(file)) artifact = { path: file, sha256: hash(file), bytes: fs.statSync(file).size };
    }
  }
  let sourceFreeze = 'PASS', sourceFailure = null;
  try { protect(); } catch (error) { sourceFreeze = 'FAIL'; sourceFailure = error.message; }
  const receipt = { index, command: [process.execPath, ...args], started, completedAt: new Date().toISOString(),
    command_total_ms: commandTotalMs, ...outcome, timedOut, timeoutMs, sourceFreeze, sourceFailure,
    stdout: { path: stdout, sha256: hash(stdout), bytes: fs.statSync(stdout).size },
    stderr: { path: stderr, sha256: hash(stderr), bytes: fs.statSync(stderr).size }, artifact };
  receipts.push(receipt); write(`process-${index}.receipt.json`, receipt); console.log(JSON.stringify(receipt));
  if (artifact) artifacts.push({ index, ...artifact });
  // Budget failures, runtime failures and timeouts are retained while remaining independent processes still execute.
  // A source-integrity change alone stops further execution because the controlled experiment identity is lost.
  if (sourceFreeze === 'FAIL') break;
}
const comparison = { requiredWorkers: 5, collectedWorkers: receipts.length, checkedSamples: 0, issues: [],
  trueNewSessions: 'UNAVAILABLE_NOT_SUBSTITUTED', warmBudgetPass: true, crossProcessParity: true };
const observations = new Map();
const reports = artifacts.map(artifact => ({ ...artifact, data: JSON.parse(fs.readFileSync(artifact.path, 'utf8')) }));
if (reports.length !== 5 || receipts.length !== 5) comparison.issues.push('MISSING_FRESH_PROCESS_EVIDENCE');
for (const receipt of receipts) {
  if (receipt.exitCode !== 0) comparison.issues.push(`PROCESS_${receipt.index}_COMMAND_NONZERO`);
  if (receipt.timedOut) comparison.issues.push(`PROCESS_${receipt.index}_COMMAND_TIMED_OUT`);
  if (receipt.sourceFreeze !== 'PASS') comparison.issues.push(`PROCESS_${receipt.index}_SOURCE_FREEZE_FAILED`);
}
const identities = new Set(reports.map(report => JSON.stringify({ fixture: report.data.fixtureIdentity,
  functions: report.data.productionFunctionSha256, rows: report.data.scale })));
if (identities.size !== 1) comparison.issues.push('FIXTURE_OR_FUNCTION_IDENTITY_CHANGED');
for (const report of reports) {
  if (report.data.warmGate !== 'PASS') { comparison.warmBudgetPass = false; comparison.issues.push(`PROCESS_${report.index}_WARM_GATE_${report.data.warmGate ?? 'MISSING'}`); }
  if (report.data.result !== 'MEASUREMENT_COMPLETED') comparison.issues.push(`PROCESS_${report.index}_NOT_COMPLETE`);
  for (const sample of report.data.samples) {
    if (!['fresh_process_cold', 'same_session_warm'].includes(sample.category)) continue;
    if (sample.status !== 'success') { comparison.issues.push(`PROCESS_${report.index}_RETAINED_SAMPLE_FAILURE`); continue; }
    const key = JSON.stringify([sample.actor, sample.variant, sample.parent, sample.inputCursor, sample.limit]);
    const value = JSON.stringify([sample.responseBytes, sample.resultSha256, sample.cursor, sample.hasMore, sample.queryCount, sample.countQueryCount]);
    if (observations.has(key) && observations.get(key) !== value) {
      comparison.crossProcessParity = false; comparison.issues.push(`PROCESS_${report.index}_RESULT_PARITY_CHANGED`);
    } else observations.set(key, value);
    comparison.checkedSamples++;
  }
}
comparison.issues = [...new Set(comparison.issues)];
write('CONTROLLED_MEASUREMENT_COMPARISON.json', comparison);
write('INDEX.json', { startedAt, completedAt: new Date().toISOString(), observed_driver_process_total_ms: performance.now(),
  completeDriverCommandQualification: 'Observed Node performance timeline, not parent-shell spawn origin; each child command_total_ms is measured from parent spawn through exit',
  result: 'COLLECTION_FINISHED_NOT_A_RELEASE_GATE_VERDICT', receipts, artifacts, comparison });
console.log(JSON.stringify({ output, result: 'COLLECTION_FINISHED_NOT_A_RELEASE_GATE_VERDICT', comparison }));
// This exit code certifies collection integrity only. Separate gate evaluator must fail missing sessions/budget failures.
process.exitCode = receipts.length !== 5 || receipts.some(item => item.exitCode !== 0 || item.timedOut || item.sourceFreeze !== 'PASS') ? 1 : 0;
