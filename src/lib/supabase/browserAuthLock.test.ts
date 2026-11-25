import assert from "node:assert/strict";
import test from "node:test";
import { NavigatorLockAcquireTimeoutError, type LockFunc } from "@supabase/supabase-js";
import { createBrowserAuthLock } from "./browserAuthLock";

function harness(available: boolean) {
  const calls: {name:string; options:LockOptions}[]=[];
  const callbackOutcomes: unknown[]=[];
  const locks={async request<R>(name:string,options:LockOptions,callback:LockGrantedCallback<R>):Promise<R>{
    calls.push({name,options});
    const result=await callback(available?{name,mode:"exclusive"} as Lock:null);
    callbackOutcomes.push(result);return result;
  }} as unknown as Pick<LockManager,"request">;
  return {calls,callbackOutcomes,locks};
}
test("unavailable refresh probe never calls auth work or rejects inside the native callback",async()=>{
  const h=harness(false);let ran=false;
  await assert.rejects(createBrowserAuthLock(h.locks)("auth",0,async()=>{ran=true;}),
    error=>error instanceof NavigatorLockAcquireTimeoutError&&error.isAcquireTimeout);
  assert.equal(ran,false);assert.deepEqual(h.callbackOutcomes,[{kind:"unavailable"}]);
  assert.deepEqual(h.calls,[{name:"auth",options:{mode:"exclusive",ifAvailable:true}}]);
});
test("an acquired probe holds its exclusive lock until auth work settles",async()=>{
  const h=harness(true);let release!:()=>void,finished=false;
  const pending=createBrowserAuthLock(h.locks)("auth",0,async()=>{
    await new Promise<void>(resolve=>{release=resolve;});return 42;
  });
  void pending.then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);assert.equal(h.callbackOutcomes.length,0);
  release();assert.equal(await pending,42);assert.deepEqual(h.callbackOutcomes,[{kind:"completed",value:42}]);
});
test("failed auth work still rejects with the original error outside the callback",async()=>{
  const h=harness(true),cause=new Error("Synthetic auth failure");
  await assert.rejects(createBrowserAuthLock(h.locks)("auth",0,async()=>{throw cause;}),error=>error===cause);
  assert.deepEqual(h.callbackOutcomes,[{kind:"failed",error:cause}]);
});
test("undefined auth results are preserved",async()=>{
  assert.equal(await createBrowserAuthLock(harness(true).locks)("auth",0,async()=>undefined),undefined);
});
for(const timeout of [5000,-1])test(`nonzero timeout ${timeout} retains installed SDK lock semantics`,async()=>{
  const h=harness(true),calls:unknown[]=[];
  const fallback:LockFunc=async(name,wait,fn)=>{calls.push([name,wait]);return fn();};
  assert.equal(await createBrowserAuthLock(h.locks,fallback)("auth",timeout,async()=>"value"),"value");
  assert.deepEqual(calls,[["auth",timeout]]);assert.equal(h.calls.length,0);
});
test("native request failures remain failures and never run auth work",async()=>{
  const cause=new Error("Synthetic native request failure");let ran=false;
  const locks={request:async()=>{throw cause;}} as unknown as Pick<LockManager,"request">;
  await assert.rejects(createBrowserAuthLock(locks)("auth",0,async()=>{ran=true;}),error=>error===cause);
  assert.equal(ran,false);
});
