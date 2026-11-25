// Separate explicit disposable targets; never accept arbitrary containers,
// daemon endpoints or hosted projects from an environment variable.
import assert from 'node:assert/strict';
export const localTestProject=process.env.P1_E2E_PROJECT_ID || 'p1-demo-e2e';
assert.ok(['p1-demo-e2e','p1-demo-recursive-20261125-fi5oom'].includes(localTestProject),'Unknown disposable local test project');
export const localTestDatabase=`supabase_db_${localTestProject}`;
export const localTestGateway=`supabase_kong_${localTestProject}`;
export const localTestEnvFile=localTestProject==='p1-demo-e2e'?'.env.e2e.local'
  :'/Users/nxs/p1-stabilization-recovery/recursive-audit-20261125.fI5oom/isolated/.env.e2e.local';
