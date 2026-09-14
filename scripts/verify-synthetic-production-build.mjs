import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = mkdtempSync('/private/tmp/p1-phase-5d-build-');
const guardDirectory = resolve(directory, 'guards');
mkdirSync(guardDirectory);
const repository = process.cwd();
const canary = 'p1_synthetic_build_secret_canary_3d_6f49d1e7a0354a6fa530e73e4be728cb';
const serverSecrets = {
  SUPABASE_SECRET_KEY: `sb_secret_${canary}`,
  CRON_SECRET: `${canary}_cron`, OUTLOOK_CLIENT_SECRET: `${canary}_graph`,
  TWILIO_API_KEY_SECRET: `${canary}_twilio`, QUICKBOOKS_SANDBOX_CLIENT_SECRET: `${canary}_quickbooks`,
  QUICKBOOKS_TOKEN_ENCRYPTION_KEY: Buffer.from('p1-build-encryption-canary-00001').toString('base64'),
};
assert.equal(Buffer.from(serverSecrets.QUICKBOOKS_TOKEN_ENCRYPTION_KEY, 'base64').length, 32);
// Do not spread process.env: credentials, provider configuration and .env
// values from the developer's shell must not reach a synthetic build.
const environment = {
  PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? '/private/tmp', LANG: 'en_US.UTF-8',
  NODE_ENV: 'production', CI: '1', NEXT_TELEMETRY_DISABLED: '1', npm_config_userconfig: '/dev/null',
  NODE_OPTIONS: `--import=${pathToFileURL(resolve('scripts/build-test-support/syntheticBuildGuard.mjs')).href}`,
  P1_SYNTHETIC_BUILD_PROOF_DIR: guardDirectory,
  P1_APP_ENV: 'production', NEXT_PUBLIC_P1_APP_ENV: 'production', VERCEL_ENV: 'production',
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_build_3d',
  P1_EXPECTED_SUPABASE_PROJECT_REF: 'synthetic', NEXT_PUBLIC_APP_URL: 'https://portal.example.invalid',
  P1_GRAPH_ENV: 'production', P1_TWILIO_ENV: 'production',
  OUTLOOK_TENANT_ID: 'synthetic-build-tenant', OUTLOOK_CLIENT_ID: 'synthetic-build-client', OUTLOOK_USER_EMAIL: 'synthetic@example.invalid',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`, TWILIO_MESSAGING_SERVICE_SID: `MG${'c'.repeat(32)}`,
  EMAIL_INTAKE_ENABLED: 'false', QUICKBOOKS_ENVIRONMENT: 'sandbox', QUICKBOOKS_SANDBOX_CLIENT_ID: 'synthetic-build-client',
  QUICKBOOKS_SANDBOX_REDIRECT_URI: 'https://portal.example.invalid/api/quickbooks/callback',
  ...serverSecrets,
};
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const protectedHashes = new Map(['package.json', 'package-lock.json'].map(path => [path, hash(path)]));
const results = [];
async function run(name, command, args, timeout = 180_000, overrides = {}) {
  const started = performance.now();
  const stream = createWriteStream(resolve(directory, `${name}.log`));
  const child = spawn(command, args, { cwd: repository, env: { ...environment, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'], timeout });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  const code = await new Promise((resolveResult, reject) => {
    child.once('error', reject); child.once('close', resolveResult);
  }).finally(() => stream.end());
  const result = { name, command: [command, ...args].join(' '), code, durationMs: Math.round(performance.now() - started) };
  results.push(result); console.log(JSON.stringify(result));
  assert.equal(code, 0, `${name} failed; inspect its synthetic-only local log`);
}
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(directory, entry.name);
  return entry.isDirectory() ? files(path) : [path];
});
console.log(JSON.stringify({ syntheticBuildDirectory: directory, networkPolicy: 'Only existing Google font hosts; no provider or application API access', environmentFiles: 'Reads blocked in all Node subprocesses' }));
try {
  await run('guard-self-test', process.execPath, ['scripts/build-test-support/verifySyntheticBuildGuard.mjs'], 10_000,
    { P1_SYNTHETIC_BUILD_SELF_TEST: '1' });
  await run('webpack', 'npm', ['run', 'build', '--', '--webpack']);
  // The unchanged packaged harnesses replace every gateway and use .invalid
  // origins. Execute that fake runtime in local test mode, not as a deployment.
  const fakeRuntime = { NODE_ENV: 'test', VERCEL_ENV: '', P1_APP_ENV: '', NEXT_PUBLIC_P1_APP_ENV: '',
    P1_EXPECTED_SUPABASE_PROJECT_REF: '', P1_GRAPH_ENV: '', P1_TWILIO_ENV: '' };
  await run('packaged-pdf', process.execPath, ['--import', 'tsx', 'scripts/verify-invoice-pdf-build.ts'], 180_000, fakeRuntime);
  await run('packaged-photo', process.execPath, ['--import', 'tsx', 'scripts/verify-photo-image-build.ts'], 180_000, fakeRuntime);
  await run('browser-boundary', process.execPath, ['scripts/verify-configuration-boundaries.mjs', '--build']);
  const artifacts = files(resolve('.next/static'));
  assert.ok(artifacts.length > 0 && artifacts.length < 10_000);
  let publicValueObserved = false;
  let artifactBytes = 0;
  const needles = [...Object.values(serverSecrets), canary].map(value => Buffer.from(value));
  for (const file of artifacts) {
    const bytes = statSync(file).size;
    assert.ok(bytes < 100_000_000, 'Browser artifact inspection bound exceeded');
    artifactBytes += bytes;
    const contents = readFileSync(file);
    assert.ok(needles.every(needle => !contents.includes(needle)), 'Synthetic server secret entered a browser artifact');
    if (contents.includes(Buffer.from(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY))) publicValueObserved = true;
  }
  assert.ok(publicValueObserved, 'Synthetic public build value was not observed; canary build was not proven');
  results.push({ name: 'exact-browser-canaries', passed: true, artifacts: artifacts.length, artifactBytes, publicValueObserved });
} catch (error) {
  process.exitCode = 1;
  console.error(JSON.stringify({ result: 'failed', code: error.code ?? 'VERIFICATION_FAILED', logDirectory: directory }));
} finally {
  const allGuards = readdirSync(guardDirectory).map(name => JSON.parse(readFileSync(resolve(guardDirectory, name), 'utf8')));
  const guards = allGuards.filter(row => !row.selfTest);
  const selfTestGuards = allGuards.filter(row => row.selfTest);
  const totals = guards.reduce((sum, row) => ({ processes: sum.processes + 1,
    environmentProbesBlocked: sum.environmentProbesBlocked + row.environmentProbesBlocked,
    environmentReadsBlocked: sum.environmentReadsBlocked + row.environmentReadsBlocked,
    networkBlocked: sum.networkBlocked + row.networkBlocked, fontRequests: sum.fontRequests + row.fontRequests,
    localPipeRequests: sum.localPipeRequests + row.localPipeRequests,
  }), { processes: 0, environmentProbesBlocked: 0, environmentReadsBlocked: 0, networkBlocked: 0, fontRequests: 0, localPipeRequests: 0 });
  if (!guards.length || totals.networkBlocked > 0 || selfTestGuards.length < 3
    || selfTestGuards.some(row => row.networkBlocked !== 4 || row.environmentReadsBlocked !== 3)) process.exitCode = 1;
  for (const [path, expected] of protectedHashes) assert.equal(hash(path), expected, 'Dependency files changed during synthetic build');
  const receipt = { results, guards: totals, guardSelfTestProcesses: selfTestGuards.length,
    packageFilesUnchanged: true, result: process.exitCode ? 'failed' : 'passed' };
  writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, logDirectory: directory }));
}
