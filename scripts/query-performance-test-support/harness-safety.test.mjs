import test from 'node:test';
import assert from 'node:assert/strict';
import { captureIsolatedPlan,classifyHarnessFailure } from './harness-safety.mjs';
import { seedPerformanceFixture } from './fixtures.mjs';

test('missing isolated engine is unavailable, never a production fallback',()=>{
  const failure=classifyHarnessFailure('engine',Object.assign(new Error('synthetic-secret-canary'),{code:'MODULE_NOT_FOUND'}));
  assert.equal(failure.evidence,'UNAVAILABLE');assert.equal(failure.code,'MODULE_NOT_FOUND');
  assert.match(failure.message,/no production fallback/);assert.ok(!JSON.stringify(failure).includes('canary'));
});
test('plan rejection including unsupported BUFFERS is surfaced once, without fallback',async()=>{
  let attempts=0;
  const failure=Object.assign(new Error('synthetic-private-query'),{code:'0A000'});
  await assert.rejects(()=>captureIsolatedPlan(async()=>{attempts++;throw failure;},'select 1'),error=>error===failure);
  assert.equal(attempts,1);assert.equal(classifyHarnessFailure('plan',failure).evidence,'LOCAL_VERIFICATION_FAILED');
});
test('missing or malformed plan cannot be reported as measured',async()=>{
  for(const result of [{rows:[]},{rows:[{'QUERY PLAN':[{}]}]}])
    await assert.rejects(()=>captureIsolatedPlan(async()=>result,'select 1'),error=>error.code==='LOCAL_PLAN_UNAVAILABLE');
});
test('fixture over-scale and failed local assertion stay failed, not lowered or certified',async()=>{
  let attempts=0;
  await assert.rejects(()=>seedPerformanceFixture({query:async()=>{attempts++;}},{workOrders:50001}));
  assert.equal(attempts,0,'unsupported scale is rejected before any fixture write');
  assert.equal(classifyHarnessFailure('fixture',new Error('overscale')).evidence,'LOCAL_VERIFICATION_FAILED');
  assert.match(classifyHarnessFailure('fixture',new Error('overscale')).message,/requested scale not certified/);
  assert.equal(classifyHarnessFailure('measurement',new Error('budget')).evidence,'LOCAL_VERIFICATION_FAILED');
});
test('valid isolated plan retains actual execution evidence',async()=>{
  const plan={Plan:{'Node Type':'Result'},'Execution Time':1.2};
  assert.equal(await captureIsolatedPlan(async()=>({rows:[{'QUERY PLAN':[plan]}]}),'select 1'),plan);
});
