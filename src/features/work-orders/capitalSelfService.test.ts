import assert from "node:assert/strict";
import test from "node:test";
import { capitalFieldsSchema, createCapitalAttempt, capitalError } from "./capitalSelfService";

const work = { id: "E2E-CAP-COMMAND", contractorAssignmentVersion: 1, workflowCycle: 0, lifecycleVersion: 7 };
const operationId = "00000000-0000-4000-8000-000000000001";
const activityId = "00000000-0000-4000-8000-000000000002";
test("capital actions require explicit facts and a bounded audit note", () => {
  assert.equal(capitalFieldsSchema.safeParse({action:"capital_confirmed_completion",note:"Confirmed installation",confirmed:false}).success,false);
  assert.equal(capitalFieldsSchema.safeParse({action:"capital_external_handoff",note:"Confirmed approval",confirmed:true,reference:""}).success,false);
  assert.equal(capitalFieldsSchema.safeParse({action:"capital_quote_revision",note:"Confirmed changes",confirmed:true}).success,false);
  assert.equal(capitalFieldsSchema.safeParse({action:"capital_confirmed_completion",note:"Confirmed installation",confirmed:true,forceClose:true}).success,false);
});
test("capital attempts retain exact operation and payload for uncertain retries", async () => {
  const attempt = createCapitalAttempt(work,{action:"capital_confirmed_completion",note:"Synthetic installation is finished",confirmed:true},operationId);
  const calls: unknown[]=[];
  const result={applied:true,reason:"applied",workOrderId:work.id,operationId,assignmentVersion:1,workflowCycle:0,lifecycleVersion:8,
    activityId,workOrderStatus:"pending_invoice",functionalStatus:"Completed",action:"capital_confirmed_completion",
    externalQuoteId:null,invoiceId:null,invoiceVersion:null};
  await assert.rejects(()=>attempt((name,args)=>{calls.push([name,args]); return Promise.resolve({data:null,error:new Error("lost response")});}),/Retry this unchanged/);
  await attempt((name,args)=>{calls.push([name,args]);return Promise.resolve({data:result,error:null});});
  assert.deepEqual(calls[0],calls[1]);
  await assert.rejects(()=>attempt(()=>Promise.resolve({data:{...result,lifecycleVersion:7},error:null})),/could not be verified/);
  await assert.rejects(()=>attempt(()=>Promise.resolve({data:{...result,workOrderStatus:"closed"},error:null})),/could not be verified/);
});
test("capital errors do not expose provider data", () => {
  assert(!capitalError({code:"XX000",message:"private provider detail"}).message.includes("private"));
  assert.equal(capitalError({code:"42501",message:"private provider detail"}).uncertain,false);
});
