import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkedBillingSql as sql } from './linked-billing-test-support.mjs';

export function invoiceConflictExportFixture() {
  assert.equal(sql("select count(*) from auth.users where email not like '%@p1.invalid'"), '0');
  const actors = JSON.parse(sql(`select jsonb_object_agg(email,id) from public.profiles where active
    and email in ('e2e.direct@p1.invalid','e2e.company.admin@p1.invalid','e2e.backoffice@p1.invalid','e2e.report.tech@p1.invalid')`));
  const direct = actors['e2e.direct@p1.invalid']; const other = actors['e2e.company.admin@p1.invalid'];
  const reportTechnician = actors['e2e.report.tech@p1.invalid'];
  assert.ok(direct && other && actors['e2e.backoffice@p1.invalid'] && reportTechnician);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const tag = `EXPORT-SYNTH-${suffix}`;
  const target = `E2E-CONFLICT-${suffix}`;
  const taken = `SYNTH-TAKEN-${suffix}`;
  const reportWork = `E2E-REPORT-EXPORT-${suffix}`;
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  const ownCount = 160;
  const workRows = []; const invoiceRows = []; const lineRows = [];
  const contractorInvoiceIds = []; const staffInvoiceIds = [];
  for (let index = 0; index < ownCount + 1; index++) {
    const own = index < ownCount; const owner = own ? direct : other;
    const work = `${tag}-${String(index).padStart(3,'0')}`;
    const state = ['TX','VA','FL'][index % 3];
    const summary = index === 0 ? '=SYNTHETIC("Café"),\nCSV safety sample' : `${tag} synthetic export scope ${index}`;
    workRows.push(`(${quote(work)},'completed','Completed',${quote(owner)},1,0,3,now()-interval '1 day',
      'E2E001',${quote(state)},${quote(index === 0 ? `${summary} ${tag}` : summary)})`);
    const contractorId = randomUUID(); const staffId = randomUUID();
    contractorInvoiceIds.push(contractorId); staffInvoiceIds.push(staffId);
    const number = own ? `${tag}-C-${String(index).padStart(3,'0')}` : `${tag}-OTHER-C`;
    const contractorState = index % 4 === 0 ? 'draft' : index % 4 === 1 ? 'submitted' : index % 4 === 2 ? 'approved' : 'paid';
    const staffState = index % 3 === 0 ? 'draft' : index % 3 === 1 ? 'submitted' : 'approved';
    invoiceRows.push(`(${quote(contractorId)},${quote(number)},${quote(work)},${quote(owner)},'contractor','invoice',
      '${contractorState}',current_date,10,0,10)`);
    invoiceRows.push(`(${quote(staffId)},${quote(`${tag}-P1-${String(index).padStart(3,'0')}`)},${quote(work)},null,'staff','invoice',
      '${staffState}',current_date,25,0,25)`);
    lineRows.push(`(${quote(contractorId)},1,'Labor','Synthetic invoice export line',1,10,false)`);
    lineRows.push(`(${quote(staffId)},1,'Labor','Synthetic staff export line',1,25,false)`);
  }
  const takenId = randomUUID();
  sql(`begin;
    insert into public.work_orders(id,status,functional_status,contractor_id,contractor_assignment_version,
      workflow_cycle,lifecycle_version,contractor_assignment_started_at,store_number,store_state,summary)
    values ${workRows.join(',')},(${quote(target)},'completed','Completed',${quote(direct)},1,0,3,
      now()-interval '1 day','E2E001','TX','Synthetic replica: completed standalone contractor call, no invoice'),
      (${quote(`${tag}-READY`)},'pending_invoice','Completed',${quote(direct)},1,0,3,
      now()-interval '1 day','E2E001','TX',${quote(`${tag} synthetic ready-to-bill call`)});
    insert into public.work_orders(id,status,functional_status,contractor_id,assigned_technician_profile_id,
      contractor_assignment_version,workflow_cycle,lifecycle_version,contractor_assignment_started_at,store_number,summary)
      values(${quote(reportWork)},'completed','Completed',${quote(other)},${quote(reportTechnician)},1,0,3,
      now()-interval '1 day','E2E001','Synthetic report-only invoice permission check');
    insert into public.invoices(id,num,work_order_id,contractor_id,invoice_type,document_kind,state,invoice_date,subtotal,sales_tax,total)
      values ${invoiceRows.join(',')},(${quote(takenId)},${quote(taken)},${quote(`${tag}-000`)},${quote(direct)},
      'contractor','invoice','draft',current_date,1,0,1);
    insert into public.invoice_lines(invoice_id,position,type,description,qty,rate,is_taxable)
      values ${lineRows.join(',')};
    commit;`);
  // Invoice search also matches the work order: the reserved-number draft
  // belongs to tag-000 and is therefore an additional legitimate match.
  return { tag, target, taken, takenId, reportWork, ownCount, ownInvoiceCount: ownCount + 1,
    workCount: ownCount + 2, invoiceCount: ownCount + 2,
    direct, other, contractorInvoiceIds, staffInvoiceIds,
    txCount: Math.ceil((ownCount + 1) / 3) + 1 };
}

export function freshConflictTarget(fixture) {
  assert.match(fixture.direct, /^[a-f0-9-]{36}$/);
  const target = `E2E-CONFLICT-${randomUUID().replaceAll('-', '').slice(0,8)}`;
  sql(`insert into public.work_orders(id,status,functional_status,contractor_id,contractor_assignment_version,
    workflow_cycle,lifecycle_version,contractor_assignment_started_at,store_number,store_state,summary)
    values('${target}','completed','Completed','${fixture.direct}',1,0,3,
    now()-interval '1 day','E2E001','TX','Synthetic replica: completed standalone contractor call, no invoice');`);
  return target;
}

export function conflictInvoiceSnapshot(workOrderId) {
  assert.match(workOrderId, /^E2E-CONFLICT-[a-f0-9]{8}$/);
  return JSON.parse(sql(`select jsonb_build_object('work_order_id',w.id,'status',w.status,
    'assignment_version',w.contractor_assignment_version,'workflow_cycle',w.workflow_cycle,
    'invoices',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'number',i.num,'state',i.state,
      'line_count',(select count(*) from public.invoice_lines l where l.invoice_id=i.id),'total',i.total))
      from public.invoices i where i.work_order_id=w.id),'[]'::jsonb))
    from public.work_orders w where w.id='${workOrderId}'`));
}
