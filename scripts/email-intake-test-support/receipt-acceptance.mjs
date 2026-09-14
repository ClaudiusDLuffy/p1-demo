import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function receiptTools(fixture) {
  const { db,as,workOrder,actors } = fixture;
  const payload = (patch = {}) => ({ email_id:'synthetic-graph-message',subject:'Synthetic safe subject',
    action:'created',work_order_id:workOrder,reason:'Synthetic processing outcome',parse_confidence:'high',
    contractor_assigned:actors.contractor,raw_subject:'Synthetic safe original subject',raw_from:'sender@example.invalid',...patch });
  const query = (tx,id,source,input) => tx.query('select public.record_email_intake_result_v1($1,$2,$3) result',[id,source,JSON.stringify(input)]);
  const command = async (id,source,input,role = 'service_role',actor = null) =>
    (await as(role,actor,tx => query(tx,id,source,input))).rows[0].result;
  const row = async id => (await db.query('select * from public.email_intake_log where event_id=$1',[id])).rows[0];
  async function rejected(run, codes = ['42501','22023','23514','PT409','PT422','P0002','22P02']) {
    const before = await fixture.snapshot();
    await assert.rejects(run,error => codes.includes(error.code), 'Invalid intake command must fail');
    assert.deepEqual(await fixture.snapshot(),before,'Rejected command must perform zero log writes');
  }
  return { payload,query,command,row,rejected };
}

export async function verifyEmailReceipts(fixture,check) {
  const { db,actors,workOrder,legacyLog,snapshot } = fixture;
  const { payload,command,row,rejected } = receiptTools(fixture);
  await check('Receipt migration marks existing records legacy/unverified without inventing trusted source identity',async () => {
    const legacy = (await db.query('select * from public.email_intake_log where id=$1',[legacyLog])).rows[0];
    assert.equal(legacy.provenance,'legacy_unverified');
    assert.equal(legacy.event_id,null);assert.equal(legacy.source_message_id,null);
    assert.equal(legacy.email_id,'synthetic-legacy-email');assert.equal(legacy.action,'created');
  });
  for (const action of ['created','updated','skipped','failed']) {
    await check(`Service records ${action} with immutable trusted provenance and server-owned timestamps`,async () => {
      const eventId = randomUUID();
      const before = (await db.query('select clock_timestamp()::text timestamp')).rows[0].timestamp;
      const result = await command(eventId,`synthetic-source-${action}`,payload({ action }));
      assert.equal(result.applied,true);assert.equal(result.reason,'recorded');
      assert.equal(result.eventId,eventId);assert.equal(result.sourceMessageId,`synthetic-source-${action}`);
      const record = await row(eventId);assert.equal(result.logId,record.id);
      assert.equal(record.provenance,'trusted_service_v1');assert.equal(record.action,action);
      assert.equal(record.work_order_id,workOrder);assert.equal(record.contractor_assigned,actors.contractor);
      const timestamp=value=>value instanceof Date?value.getTime():Date.parse(value);
      assert.ok(timestamp(record.processed_at)>=timestamp(before),`${record.processed_at} must be after ${before}`);
      assert.equal(timestamp(result.processedAt),timestamp(record.processed_at));
      assert.ok(timestamp(record.created_at)>=timestamp(before));
    });
  }
  await check('Same event/source/normalized payload replay retains original result, row identity and processing time',async () => {
    const eventId=randomUUID(),source='synthetic-replay-source',input=payload();
    const first=await command(eventId,source,input),before=await snapshot();
    const replay=await command(eventId,source,Object.fromEntries(Object.entries(input).reverse()));
    assert.equal(replay.applied,false);assert.equal(replay.reason,'already_recorded');
    assert.deepEqual({...replay,applied:true,reason:'recorded'},first);assert.deepEqual(await snapshot(),before);
  });
  await check('Source identity may have multiple distinct outcomes and later attempts without suppressing legitimate history',async () => {
    const source='synthetic-multi-outcome';
    const eventIds=[];
    for (const action of ['failed','created','skipped']) {
      const id=randomUUID();eventIds.push(id);
      await command(id,source,payload({ action }));
    }
    const rows=(await db.query('select event_id,action from public.email_intake_log where source_message_id=$1 order by action',[source])).rows;
    assert.equal(rows.length,3);assert.deepEqual(rows.map(record=>record.action),['created','failed','skipped']);
    assert.deepEqual(new Set(rows.map(record=>record.event_id)),new Set(eventIds));
  });
  const conflicts = {
    source: input => ({ source:'different-source',input }),
    action: input => ({ input:{...input,action:'updated'} }),
    reason: input => ({ input:{...input,reason:'Changed outcome'} }),
    workOrder: input => ({ input:{...input,work_order_id:fixture.archivedWorkOrder} }),
    contractor: input => ({ input:{...input,contractor_assigned:actors.outsider} }),
    graphAlias: input => ({ input:{...input,email_id:'different-graph-alias'} }),
    confidence: input => ({ input:{...input,parse_confidence:'low'} }),
  };
  for (const [name,mutate] of Object.entries(conflicts)) {
    await check(`Same event identity rejects conflicting ${name} instead of overwriting evidence`,async () => {
      const id=randomUUID(),source=`synthetic-conflict-${name}`,input=payload();
      await command(id,source,input);const changed=mutate(input);
      await rejected(()=>command(id,changed.source || source,changed.input),['PT409','23514']);
    });
  }
  await check('Missing optional fields and explicit null normalize consistently without requiring an existing target',async () => {
    const id=randomUUID(),source='synthetic-optional-normalization';
    const input={email_id:'synthetic-minimum',action:'skipped',reason:'Synthetic skip',parse_confidence:'low'};
    await command(id,source,input);
    const result=await command(id,source,{...input,subject:null,work_order_id:null,
      contractor_assigned:null,raw_subject:null,raw_from:null});
    assert.equal(result.reason,'already_recorded');
  });
  await check('Inactive historical contractor reference is recorded as a past result, not reinterpreted as a new assignment',async () => {
    const id=randomUUID();await command(id,'synthetic-historical-contractor',payload({ contractor_assigned:actors.inactiveContractor }));
    assert.equal((await row(id)).contractor_assigned,actors.inactiveContractor);
  });
  await check('Receipt binds normalized source, UUID and optional strings consistently',async()=>{
    const id=randomUUID(),source='synthetic-normalized-replay',input=payload();
    await command(id,source,input);
    const result=await command(id,`  ${source}  `,{...input,email_id:` ${input.email_id} `,
      contractor_assigned:input.contractor_assigned.toUpperCase(),reason:` ${input.reason} `,raw_from:` ${input.raw_from} `});
    assert.equal(result.reason,'already_recorded');
  });
  await check('Safe redaction markers and normalized operational summaries remain recordable',async()=>{
    const id=randomUUID();
    const input=payload({reason:'  Provider failure: [REDACTED]\nRetry requires review.  ',subject:'Synthetic\tstatus'});
    await command(id,'synthetic-safe-redacted',input);
    const result=await row(id);
    assert.equal(result.reason,'Provider failure: [REDACTED] Retry requires review.');
    assert.equal(result.subject,'Synthetic status');
    assert.equal((await command(id,'synthetic-safe-redacted',{...input,reason:result.reason,subject:result.subject})).reason,'already_recorded');
  });
}

export async function verifyEmailReceiptValidation(fixture,check) {
  const { payload,command,rejected }=receiptTools(fixture);
  const invalids=[
    ['null body',null],['array body',[]],['scalar body','text'],
    ['unknown action',payload({action:'approved'})],['numeric action',payload({action:1})],
    ['missing action',Object.fromEntries(Object.entries(payload()).filter(([key])=>key!=='action'))],
    ['blank Graph id',payload({email_id:' \t\n '})],['NBSP Graph id',payload({email_id:'\u00a0'})],
    ['BOM Graph id',payload({email_id:'\ufeff'})],['numeric Graph id',payload({email_id:123})],
    ['embedded control Graph id',payload({email_id:'synthetic\nmessage'})],
    ['unknown confidence',payload({parse_confidence:'certain'})],['numeric confidence',payload({parse_confidence:1})],
    ['missing confidence',payload({parse_confidence:null})],['missing reason',payload({reason:null})],
    ['blank reason',payload({reason:' \t\n '})],
    ['unknown field',payload({actor_id:fixture.actors.mgr})],
    ['caller processing timestamp',payload({processed_at:'2001-01-01T00:00:00Z'})],
    ['caller creation timestamp',payload({created_at:'2001-01-01T00:00:00Z'})],
    ['caller provenance',payload({provenance:'trusted_service_v1'})],
    ['nonexistent work order',payload({work_order_id:'WOT9600999'})],
    ['numeric work order',payload({work_order_id:123})],
    ['empty work order',payload({work_order_id:''})],['successful missing work order',payload({work_order_id:null})],
    ['nonexistent contractor',payload({contractor_assigned:'99999999-9999-4999-8999-999999999999'})],
    ['malformed contractor',payload({contractor_assigned:'Not a UUID'})],
    ['numeric contractor',payload({contractor_assigned:123})],
    ['empty contractor',payload({contractor_assigned:''})],
    ['object reason',payload({reason:{message:'bad'}})],
    ['oversized document',payload({extra:'x'.repeat(32769)})],
  ];
  for(const value of ['access_token=synthetic-token-not-a-real-key','refresh_token: synthetic-test-value',
    'client_secret=synthetic-credential','Authorization: Bearer synthetic-token','api_key=synthetic-credential',
    'Bearer synthetic-token','eyJzdWJqZWN0.SYNTHETIC.TEST']) {
    invalids.push(['unsafe credential-shaped summary',payload({reason:value})]);
  }
  for(const [field,max] of [['email_id',2048],['subject',1024],['raw_subject',1024],['reason',2000],['raw_from',320],['work_order_id',128]]) {
    invalids.push([`oversized ${field}`,payload({[field]:'x'.repeat(max+1)})]);
  }
  for(const [name,input] of invalids) {
    await check(`Receipt rejects ${name} atomically before recording any outcome`,()=>
      rejected(()=>command(randomUUID(),`synthetic-invalid-${name}`,input)));
  }
  for(const source of [null,'',' \t\n ','\u00a0','\ufeff','x'.repeat(2049)]) {
    await check(`Receipt rejects ${source===null?'null':source.length>2048?'oversized':'blank'} source identity`,()=>
      rejected(()=>command(randomUUID(),source,payload())));
  }
  await check('Receipt rejects missing event identity',()=>rejected(()=>command(null,'synthetic-missing-event',payload())));
  await check('Receipt rejects embedded control source identity',()=>rejected(()=>command(randomUUID(),'synthetic\nsource',payload())));
}
