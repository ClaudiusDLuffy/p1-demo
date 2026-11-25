import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createManualInvoiceDraftAttempt,createPriorInvoiceSubmitAttempt,priorInvoiceContextSchema,priorInvoiceError,
  type PriorInvoiceContext} from "./priorContractorInvoices";
const current=randomUUID(),vendor=randomUUID(),operation=randomUUID(),invoiceId=randomUUID();
const context:PriorInvoiceContext={workOrderId:"SYNTHETIC-MANUAL",assignmentVersion:1,workflowCycle:0,assignments:[],drafts:[],
  manualIntake:{eligible:true,currentContractorId:current}};
const fields={num:"SYNTHETIC-VERIFIED-001",invoiceDate:"2026-10-01",total:125.5,salesTax:5.5,note:"Verified original earlier-work bill"};
const receipt=(extra={})=>({invoiceId,invoiceNum:fields.num,workOrderId:context.workOrderId,assignmentId:null,
  manualContractorId:vendor,assignmentVersion:1,workflowCycle:0,invoiceVersion:1,total:fields.total,state:"draft",
  operationId:operation,applied:true,activityId:randomUUID(),...extra});
test("manual context is opt-in and malformed dual/no-identity drafts fail closed",()=>{
  assert.ok(priorInvoiceContextSchema.safeParse({...context,manualIntake:undefined}).success);
  for(const identity of [{assignmentId:null,manualContractorId:null},{assignmentId:randomUUID(),manualContractorId:vendor}]){
    assert.equal(priorInvoiceContextSchema.safeParse({...context,drafts:[{...identity,id:invoiceId,num:fields.num,
      invoiceDate:fields.invoiceDate,total:125.5,salesTax:5.5,note:fields.note,state:"draft",invoiceVersion:1,hasPdf:false}]}).success,false);
  }
});
test("manual intake requires explicit verification, backend eligibility and a different contractor UUID",()=>{
  assert.throws(()=>createManualInvoiceDraftAttempt(context,vendor,fields,false),/Verify the original/);
  for(const id of ["", "Anderson",current])assert.throws(()=>createManualInvoiceDraftAttempt(context,id,fields,true),/earlier contractor/);
  for(const c of [{...context,manualIntake:undefined},{...context,manualIntake:{eligible:false,currentContractorId:current}},
    {...context,assignments:[{id:randomUUID(),contractorId:vendor,contractorName:"Recorded contractor",assignmentVersion:0,startedAt:null,endedAt:"2026-10-01"}]}]){
    assert.throws(()=>createManualInvoiceDraftAttempt(c,vendor,fields,true),/no recorded past assignment/);
  }
});
test("manual attempts freeze verified fields and reuse one operation across uncertain responses",async()=>{
  const input={...fields}; const attempt=createManualInvoiceDraftAttempt(context,vendor,input,true,null,operation);
  input.total=999; const calls:{name:string;args:unknown}[]=[];
  await assert.rejects(attempt(async(name,args)=>{calls.push({name,args});return {data:null,error:new Error("Synthetic lost response")};}),
    error=>priorInvoiceError(error).uncertain);
  await attempt(async(name,args)=>{calls.push({name,args});return {data:receipt(),error:null};});
  assert.equal(calls[0].name,"save_verified_manual_contractor_invoice_v1");assert.deepEqual(calls[0],calls[1]);
  const args=calls[0].args as {p_payload:typeof fields & {verified:boolean};p_contractor_id:string};
  assert.equal(args.p_payload.total,125.5);assert.equal(args.p_payload.verified,true);assert.equal(args.p_contractor_id,vendor);
  assert.equal(Object.isFrozen(args),true);assert.equal(Object.isFrozen(args.p_payload),true);
});
test("manual responses bind operation, work order, contractor, source, version, number and amount",async()=>{
  for(const extra of [{manualContractorId:current},{manualContractorId:undefined},{assignmentId:randomUUID()},
    {operationId:randomUUID()},{workOrderId:"OTHER"},{assignmentVersion:2},{workflowCycle:1},{invoiceNum:"OTHER"},
    {total:1},{state:"approved"}]){
    const attempt=createManualInvoiceDraftAttempt(context,vendor,fields,true,null,operation);
    await assert.rejects(attempt(async()=>({data:receipt(extra),error:null})),error=>priorInvoiceError(error).uncertain);
  }
});
test("retained manual drafts keep immutable identity even when new-intake eligibility changes",async()=>{
  const draft={id:invoiceId,invoiceVersion:1,assignmentId:null,manualContractorId:vendor,num:fields.num,
    invoiceDate:fields.invoiceDate,total:125.5,salesTax:5.5,note:fields.note,state:"draft" as const,hasPdf:false};
  const c={...context,manualIntake:{eligible:false,currentContractorId:current}};
  assert.throws(()=>createManualInvoiceDraftAttempt(c,randomUUID(),fields,true,draft),/no recorded past assignment/);
  const attempt=createManualInvoiceDraftAttempt(c,vendor,fields,true,draft,operation);
  await assert.rejects(attempt(async()=>({data:receipt(),error:null})),error=>priorInvoiceError(error).uncertain);
  await attempt(async()=>({data:receipt({invoiceVersion:2}),error:null}));
  const returning=createManualInvoiceDraftAttempt({...c,manualIntake:{eligible:false,currentContractorId:vendor}},vendor,fields,true,draft,operation);
  await returning(async()=>({data:receipt({invoiceVersion:2}),error:null}));
});
test("manual submission cannot accept a receipt for a different intake identity",async()=>{
  const submit=createPriorInvoiceSubmitAttempt(context,{id:invoiceId,invoiceVersion:1},operation,
    {assignmentId:null,manualContractorId:vendor});
  for(const extra of [{manualContractorId:current},{assignmentId:randomUUID(),manualContractorId:null}]){
    await assert.rejects(submit(async()=>({data:receipt({...extra,invoiceVersion:2,state:"submitted"}),error:null})),
      error=>priorInvoiceError(error).uncertain);
  }
  await submit(async()=>({data:receipt({invoiceVersion:2,state:"submitted"}),error:null}));
});
