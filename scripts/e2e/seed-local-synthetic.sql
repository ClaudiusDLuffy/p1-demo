begin;

-- This database is dedicated to synthetic E2E testing. Reset every operational
-- work-order child through the real foreign-key graph while retaining schema,
-- policy, pricing and notification configuration installed by migrations.
-- Accounting handoff batches intentionally outlive invoices in production,
-- so they are outside that graph. This database is disposable and synthetic;
-- reset the batch root explicitly to avoid retaining item-less audit rows after
-- the invoice cascade between local test runs.
truncate table public.controller_invoice_export_batches cascade;
truncate table public.work_orders cascade;

-- The tax-rule CRUD browser case writes real local rows outside the work-order
-- foreign-key graph. Remove only its synthetic fixture so repeated runs stay
-- deterministic without resetting migration-installed billing policy.
delete from public.billing_tax_rules
where name = 'Synthetic compressor tax rule';

insert into public.organizations (id, name, slug, plan, settings, active, canonical_contractor_id)
values (
  '00000000-0000-4000-8000-00000000e201',
  'Synthetic Service Company',
  'synthetic-service-company',
  'test',
  '{}'::jsonb,
  true,
  null
)
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  plan = excluded.plan,
  settings = excluded.settings,
  active = excluded.active,
  canonical_contractor_id = null,
  updated_at = now();

insert into public.profiles (
  id, name, initials, email, role, title, company, territory, trades, color,
  active, contractor_tier, dispatcher_id, is_assignable,
  contractor_organization_id, contractor_access_level
)
values
  (:'manager_id'::uuid, 'Synthetic Manager', 'SM', 'e2e.manager@p1.invalid', 'manager', 'Owner', null, null, '{}', '#1F1E1C', true, null, null, true, null, null),
  (:'dispatcher_id'::uuid, 'Synthetic Dispatcher', 'SD', 'e2e.dispatcher@p1.invalid', 'dispatcher', 'Dispatcher', null, null, '{}', '#A67C00', true, null, null, true, null, null),
  (:'backoffice_id'::uuid, 'Synthetic Back Office', 'SB', 'e2e.backoffice@p1.invalid', 'back_office', 'Back office', null, null, '{}', '#4A7C59', true, null, null, true, null, null),
  (:'controller_id'::uuid, 'Synthetic Controller', 'SC', 'e2e.controller@p1.invalid', 'back_office', 'Payables controller', null, null, '{}', '#5B4B8A', true, null, null, true, null, null),
  (:'accounting_id'::uuid, 'Synthetic Accounting', 'SA', 'e2e.accounting@p1.invalid', 'back_office', 'Accounting handoff', null, null, '{}', '#0891B2', true, null, null, true, null, null),
  (:'direct_id'::uuid, 'Synthetic Direct Contractor', 'DC', 'e2e.direct@p1.invalid', 'contractor', null, 'Synthetic Direct Services', 'Test Territory', array['hvac'], '#8B5CF6', true, 'direct', null, true, null, null),
  (:'company_admin_id'::uuid, 'Synthetic Company Admin', 'CA', 'e2e.company.admin@p1.invalid', 'contractor', null, 'Synthetic Service Company', 'Test Territory', array['refrigeration'], '#F59E0B', true, 'direct', null, true, '00000000-0000-4000-8000-00000000e201', 'company_admin'),
  (:'company_admin_2_id'::uuid, 'Synthetic Company Admin Two', 'C2', 'e2e.company.admin2@p1.invalid', 'contractor', null, 'Synthetic Service Company', 'Test Territory', array['refrigeration'], '#B45309', true, 'direct', null, true, '00000000-0000-4000-8000-00000000e201', 'company_admin'),
  (:'invoice_tech_id'::uuid, 'Synthetic Invoice Technician', 'IT', 'e2e.invoice.tech@p1.invalid', 'contractor', null, 'Synthetic Service Company', 'Test Territory', array['refrigeration'], '#10B981', true, 'contracted', null, true, '00000000-0000-4000-8000-00000000e201', 'invoice'),
  (:'legacy_invoice_tech_id'::uuid, 'Synthetic Legacy Invoice Technician', 'LI', 'e2e.legacy.invoice.tech@p1.invalid', 'contractor', null, 'Synthetic Service Company', 'Test Territory', array['refrigeration'], '#0D9488', true, null, null, true, '00000000-0000-4000-8000-00000000e201', 'invoice'),
  (:'revocation_tech_id'::uuid, 'Synthetic Revocation Technician', 'RV', 'e2e.revocation.tech@p1.invalid', 'contractor', null, 'Synthetic Service Company', 'Test Territory', array['refrigeration'], '#047857', true, 'contracted', null, true, '00000000-0000-4000-8000-00000000e201', 'invoice'),
  (:'report_tech_id'::uuid, 'Synthetic Report Technician', 'RT', 'e2e.report.tech@p1.invalid', 'contractor', null, 'Synthetic Service Company', 'Test Territory', array['refrigeration'], '#EC4899', true, 'contracted', null, true, '00000000-0000-4000-8000-00000000e201', 'report_only'),
  (:'team_lead_id'::uuid, 'Synthetic Team Lead', 'TL', 'e2e.team.lead@p1.invalid', 'contractor', null, 'Synthetic Service Company · Field Team', 'Test Territory', array['general'], '#0F766E', true, 'mr_freeze', null, true, '00000000-0000-4000-8000-00000000e201', 'report_only'),
  (:'team_member_id'::uuid, 'Synthetic Team Member', 'TM', 'e2e.team.member@p1.invalid', 'contractor', null, 'Synthetic Service Company · Field Team', 'Test Territory', array['general'], '#2563EB', true, 'contracted', :'team_lead_id'::uuid, true, '00000000-0000-4000-8000-00000000e201', 'report_only')
on conflict (id) do update set
  name = excluded.name,
  initials = excluded.initials,
  email = excluded.email,
  role = excluded.role,
  title = excluded.title,
  company = excluded.company,
  territory = excluded.territory,
  trades = excluded.trades,
  color = excluded.color,
  active = excluded.active,
  contractor_tier = excluded.contractor_tier,
  dispatcher_id = excluded.dispatcher_id,
  is_assignable = excluded.is_assignable,
  contractor_organization_id = excluded.contractor_organization_id,
  contractor_access_level = excluded.contractor_access_level,
  updated_at = now();

update public.organizations
set canonical_contractor_id = :'company_admin_id'::uuid, updated_at = now()
where id = '00000000-0000-4000-8000-00000000e201';

delete from public.staff_permission_grants
where profile_id in (:'manager_id'::uuid, :'dispatcher_id'::uuid, :'backoffice_id'::uuid, :'controller_id'::uuid, :'accounting_id'::uuid);

insert into public.staff_permission_grants (profile_id, permission, granted_by)
values
  (:'controller_id'::uuid, 'invoice_controller', :'manager_id'::uuid),
  (:'accounting_id'::uuid, 'quickbooks_export', :'manager_id'::uuid),
  (:'accounting_id'::uuid, 'quickbooks_handoff', :'manager_id'::uuid);

delete from public.contractor_technicians
where contractor_id = :'company_admin_id'::uuid
   or profile_id in (:'invoice_tech_id'::uuid, :'legacy_invoice_tech_id'::uuid, :'revocation_tech_id'::uuid, :'report_tech_id'::uuid,
     :'team_lead_id'::uuid, :'team_member_id'::uuid);

insert into public.contractor_technicians (contractor_id, profile_id, name, tier, is_active)
values
  (:'company_admin_id'::uuid, :'invoice_tech_id'::uuid, 'Synthetic Invoice Technician', 'contracted', true),
  (:'company_admin_id'::uuid, :'legacy_invoice_tech_id'::uuid, 'Synthetic Legacy Invoice Technician', 'contracted', true),
  (:'company_admin_id'::uuid, :'revocation_tech_id'::uuid, 'Synthetic Revocation Technician', 'contracted', true),
  (:'company_admin_id'::uuid, :'report_tech_id'::uuid, 'Synthetic Report Technician', 'contracted', true),
  (:'company_admin_id'::uuid, :'team_lead_id'::uuid, 'Synthetic Team Lead', 'mr_freeze', true),
  (:'company_admin_id'::uuid, :'team_member_id'::uuid, 'Synthetic Team Member', 'contracted', true);

insert into public.afms (id, name, email, region)
values ('00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', 'afm@synthetic.invalid', 'Synthetic Region')
on conflict (id) do update set name = excluded.name, email = excluded.email, region = excluded.region;

insert into public.stores (store_number, city, state, address, default_afm_id, notes)
values
  ('E2E001', 'Synthetic City', 'TX', '100 Test Fixture Way, Synthetic City, TX 75001', '00000000-0000-4000-8000-00000000e301', 'Synthetic E2E store only'),
  ('38839', 'Store Search City', 'TX', '38839 Search Test Way, Store Search City, TX 75001', '00000000-0000-4000-8000-00000000e301', 'Synthetic exact-store search only')
on conflict (store_number) do update set city = excluded.city, state = excluded.state, address = excluded.address,
  default_afm_id = excluded.default_afm_id, notes = excluded.notes;

insert into public.work_orders (
  id, incident_id, store_number, city, address, store_state, store_timezone,
  line_of_service, business_service, category, sub_category, summary, description,
  priority, status, functional_status, contractor_id, afm_id, afm_name, afm_email,
  nte, dispatched_at, start_time, end_time, is_capital, capital_status,
  created_by, source, billing_only, billing_ready_at, billing_ready_by,
  contractor_assignment_started_at, contractor_assignment_version,
  assigned_technician_profile_id, technician_on_job, workflow_cycle, lifecycle_version
)
values
  ('E2E-NEW-START', 'E2E-INC-001', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'Refrigeration', 'Synthetic equipment', 'Fixture', 'New assignment', 'Email-intake assignment', 'Email-intake-style assignment in New functional status.',
   'p2', 'assigned', 'New', :'company_admin_id'::uuid, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   1500, now() - interval '10 minutes', null, null, false, null, :'dispatcher_id'::uuid, 'email', false, null, null,
   now() - interval '10 minutes', 1, :'invoice_tech_id'::uuid, 'Synthetic Invoice Technician', 0, 0),

  ('E2E-REPORT-START', 'E2E-INC-002', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'Refrigeration', 'Synthetic equipment', 'Fixture', 'Report-only field work', 'Report technician assignment', 'Assigned specifically to the report-only technician.',
   'p3', 'assigned', 'Dispatched', :'company_admin_id'::uuid, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   1200, now() - interval '8 minutes', null, null, false, null, :'dispatcher_id'::uuid, 'manual', false, null, null,
   now() - interval '8 minutes', 1, :'report_tech_id'::uuid, 'Synthetic Report Technician', 0, 0),

  ('E2E-ADMIN-WORKFLOW', 'E2E-INC-003', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'Refrigeration', 'Synthetic equipment', 'Fixture', 'Company administrator workflow', 'Company workflow', 'Company-wide field workflow fixture.',
   'p3', 'assigned', 'Dispatched', :'company_admin_id'::uuid, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   1800, now() - interval '6 minutes', null, null, false, null, :'dispatcher_id'::uuid, 'manual', false, null, null,
   now() - interval '6 minutes', 1, null, null, 0, 0),

  ('E2E-DIRECT-INVOICE', 'E2E-INC-004', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'HVAC', 'Synthetic equipment', 'Fixture', 'Direct contractor invoicing', 'Direct invoice workflow', 'Completed work ready for a contractor invoice.',
   'p3', 'pending_invoice', 'Completed', :'direct_id'::uuid, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   2000, now() - interval '3 hours', now() - interval '2 hours', now() - interval '1 hour', false, null, :'dispatcher_id'::uuid, 'manual', false, null, null,
   now() - interval '3 hours', 1, null, 'Synthetic Direct Contractor', 0, 2),

  ('E2E-TECH-INVOICE', 'E2E-INC-005', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'Refrigeration', 'Synthetic equipment', 'Fixture', 'Invoice technician invoicing', 'Technician invoice workflow', 'Completed work assigned to an invoice-capable technician.',
   'p3', 'pending_invoice', 'Completed', :'company_admin_id'::uuid, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   2000, now() - interval '3 hours', now() - interval '2 hours', now() - interval '1 hour', false, null, :'dispatcher_id'::uuid, 'manual', false, null, null,
   now() - interval '3 hours', 1, :'invoice_tech_id'::uuid, 'Synthetic Invoice Technician', 0, 2),

  ('E2E-STAFF-CAPITAL', 'E2E-INC-006', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'Refrigeration', 'Synthetic equipment', 'Fixture', 'Staff capital transition', 'Capital workflow', 'Fixture for the guarded capital flag action.',
   'p2', 'assigned', 'Dispatched', :'direct_id'::uuid, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   4500, now() - interval '20 minutes', null, null, false, null, :'dispatcher_id'::uuid, 'manual', false, null, null,
   now() - interval '20 minutes', 1, null, null, 0, 0),

  ('E2E-STAFF-ASSIGN', 'E2E-INC-007', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'General', 'Synthetic equipment', 'Fixture', 'Staff assignment workflow', 'Assignment workflow', 'Unassigned fixture for dispatch and reassignment.',
   'p3', 'unassigned', 'New', null, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   1000, null, null, null, false, null, :'dispatcher_id'::uuid, 'manual', false, null, null,
   null, 0, null, null, 0, 0),

  ('E2E-STAFF-BILLING', 'E2E-INC-008', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'General', 'Synthetic equipment', 'Fixture', 'Staff billing workflow', 'Billing workflow', 'Billing-only fixture ready for P1-to-customer invoicing.',
   'p3', 'pending_invoice', 'Completed', null, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   1000, null, null, now() - interval '30 minutes', false, null, :'backoffice_id'::uuid, 'manual', true, now() - interval '30 minutes', :'backoffice_id'::uuid,
   null, 0, null, null, 0, 1),

  ('E2E-SUB-TEAM', 'E2E-INC-009', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'General', 'Synthetic equipment', 'Fixture', 'Legacy team dispatch workflow', 'Team dispatch workflow', 'Fixture visible to a synthetic team lead and member.',
   'p4', 'assigned', 'Dispatched', :'company_admin_id'::uuid, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   900, now() - interval '12 minutes', null, null, false, null, :'dispatcher_id'::uuid, 'manual', false, null, null,
   now() - interval '12 minutes', 1, :'team_member_id'::uuid, 'Synthetic Team Member', 0, 0),

  ('E2E-MOBILE-INVOICE', 'E2E-INC-010', 'E2E001', 'Synthetic City, TX', '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
   'HVAC', 'Synthetic equipment', 'Fixture', 'Narrow viewport invoicing', 'Mobile invoice workflow', 'Isolated completed work for narrow-viewport invoice controls.',
   'p3', 'pending_invoice', 'Completed', :'direct_id'::uuid, '00000000-0000-4000-8000-00000000e301', 'Synthetic AFM', null,
   2000, now() - interval '3 hours', now() - interval '2 hours', now() - interval '1 hour', false, null, :'dispatcher_id'::uuid, 'manual', false, null, null,
   now() - interval '3 hours', 1, null, 'Synthetic Direct Contractor', 0, 2);

-- Independent workflow fixtures.  Each destructive browser scenario receives
-- its own work order so a successful transition cannot hide a later control or
-- make the suite order-dependent.
insert into public.work_orders (
  id, incident_id, store_number, city, address, store_state, store_timezone,
  line_of_service, business_service, category, sub_category, summary, description,
  priority, status, functional_status, contractor_id, afm_id, afm_name, afm_email,
  nte, dispatched_at, start_time, end_time, is_capital, capital_status,
  created_by, source, billing_only, billing_ready_at, billing_ready_by,
  contractor_assignment_started_at, contractor_assignment_version,
  assigned_technician_profile_id, technician_on_job, workflow_cycle, lifecycle_version,
  closed_at
)
select
  fixture.id,
  'E2E-INC-' || fixture.sequence,
  case when fixture.sequence in ('062', '063') then '38839' else 'E2E001' end,
  case when fixture.sequence in ('062', '063') then 'Store Search City, TX' else 'Synthetic City, TX' end,
  case when fixture.sequence in ('062', '063') then '38839 Search Test Way, Store Search City, TX 75001' else '100 Test Fixture Way, Synthetic City, TX 75001' end,
  'TX',
  'America/Chicago',
  fixture.line_of_service,
  fixture.business_service,
  'Synthetic fixture',
  fixture.summary,
  fixture.summary,
  'Disposable local E2E fixture for ' || fixture.summary || '.',
  fixture.priority::public.wo_priority,
  fixture.status::public.wo_status,
  fixture.functional_status::public.fsm_functional_status,
  fixture.contractor_id,
  '00000000-0000-4000-8000-00000000e301'::uuid,
  'Synthetic AFM',
  null,
  fixture.nte,
  case when fixture.contractor_id is null then null else now() - interval '4 hours' end,
  fixture.start_time,
  fixture.end_time,
  fixture.is_capital,
  fixture.capital_status::public.capital_status,
  :'dispatcher_id'::uuid,
  'manual',
  fixture.billing_only,
  case when fixture.status in ('pending_invoice', 'pending_approval', 'pending_payment') then now() - interval '30 minutes' else null end,
  case when fixture.status in ('pending_invoice', 'pending_approval', 'pending_payment') then :'backoffice_id'::uuid else null end,
  case when fixture.contractor_id is null then null else now() - interval '4 hours' end,
  case when fixture.contractor_id is null then 0 else 1 end,
  fixture.assigned_technician_profile_id,
  fixture.technician_on_job,
  fixture.workflow_cycle,
  fixture.lifecycle_version,
  fixture.closed_at
from (values
  ('E2E-EDIT',                 '011', 'General',       'HVAC',                    'Edit work order',                  'p3', 'unassigned',                'New',                         null::uuid,                  1200::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 null::text,                         0, 0::bigint, null::timestamptz),
  ('E2E-REJECT',               '012', 'General',       'Plumbing',                'Reject untouched work order',      'p4', 'unassigned',                'New',                         null::uuid,                   900::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 null::text,                         0, 0::bigint, null::timestamptz),
  ('E2E-STRAIGHT-BILL',        '013', 'General',       'General Maintenance',      'Straight to billing',              'p3', 'unassigned',                'New',                         null::uuid,                  1000::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 null::text,                         0, 0::bigint, null::timestamptz),
  ('E2E-ETA',                  '014', 'Refrigeration', 'Refrigeration equipment',  'Set contractor ETA',               'p2', 'assigned',                  'Dispatched',                  :'company_admin_id'::uuid,   1500::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              :'invoice_tech_id'::uuid,    'Synthetic Invoice Technician',    0, 0::bigint, null::timestamptz),
  ('E2E-REASSIGN',             '015', 'HVAC',          'HVAC',                    'Reassign contractor',               'p3', 'assigned',                  'Dispatched',                  :'direct_id'::uuid,          1800::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 0::bigint, null::timestamptz),
  ('E2E-UNASSIGN',             '016', 'HVAC',          'HVAC',                    'Unassign contractor',               'p3', 'assigned',                  'Dispatched',                  :'direct_id'::uuid,          1800::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 0::bigint, null::timestamptz),
  ('WOT9000001',               '017', 'HVAC',          'HVAC',                    'Duplicate for reassignment',        'p3', 'assigned',                  'Dispatched',                  :'direct_id'::uuid,          1800::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 0::bigint, null::timestamptz),
  ('E2E-CLOSE-NO-INVOICE',     '018', 'General',       'General Maintenance',      'Close without invoice',             'p4', 'assigned',                  'Dispatched',                  :'direct_id'::uuid,           800::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 0::bigint, null::timestamptz),
  ('E2E-CAPITAL-DECLINE',      '019', 'Refrigeration', 'Refrigeration equipment',  'Decline capital request',           'p2', 'capital',                   'Pending Capital Approval',    :'direct_id'::uuid,          5000::numeric, true,  'Pending approval',      false, null::timestamptz,              null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 1::bigint, null::timestamptz),
  ('E2E-CAPITAL-COMPLETE',     '020', 'Refrigeration', 'Refrigeration equipment',  'Complete approved capital work',    'p2', 'pending_capital_completion','Pending Capital Completion',  :'direct_id'::uuid,          5000::numeric, true,  'Approved - work authorized',false, now() - interval '2 hours',   null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 1::bigint, null::timestamptz),
  ('E2E-PORTAL-UPDATE',        '021', 'General',       'General Maintenance',      'Portal update transition',          'p3', 'completed',                 'Completed',                   :'direct_id'::uuid,          1200::numeric, false, null,                    false, now() - interval '2 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-ACTIVITY',             '022', 'General',       'General Maintenance',      'Activity controls',                 'p3', 'assigned',                  'Dispatched',                  :'direct_id'::uuid,          1200::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 0::bigint, null::timestamptz),
  ('E2E-PARTS',                '023', 'Refrigeration', 'Refrigeration equipment',  'Parts CRUD controls',               'p3', 'wip',                       'Work in Progress',            :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '2 hours',   null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 1::bigint, null::timestamptz),
  ('E2E-PHOTO',                '024', 'Refrigeration', 'Refrigeration equipment',  'Photo CRUD controls',               'p3', 'wip',                       'Work in Progress',            :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '2 hours',   null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 1::bigint, null::timestamptz),
  ('E2E-VISIT-CORRECT',        '025', 'Refrigeration', 'Refrigeration equipment',  'Visit correction controls',         'p3', 'pending_invoice',           'Completed',                   :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-ESTIMATE',             '026', 'HVAC',          'HVAC',                    'Estimate workflow',                 'p3', 'pending_invoice',           'Completed',                   :'direct_id'::uuid,          3500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-REVIEW-APPROVE',       '027', 'HVAC',          'HVAC',                    'Approve contractor invoice',        'p3', 'pending_approval',          'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-REVIEW-REJECT',        '028', 'HVAC',          'HVAC',                    'Reject contractor invoice',         'p3', 'pending_approval',          'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-REJECTED-EDIT',        '029', 'HVAC',          'HVAC',                    'Correct rejected invoice',          'p3', 'pending_invoice',           'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-DRAFT-DELETE',         '030', 'HVAC',          'HVAC',                    'Delete contractor draft',           'p3', 'pending_invoice',           'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-APPROVED-HOLD',        '031', 'HVAC',          'HVAC',                    'Payment hold controls',             'p3', 'pending_payment',           'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-APPROVED-HANDOFF',     '032', 'HVAC',          'HVAC',                    'QuickBooks handoff selection',      'p3', 'pending_payment',           'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-PAID',                 '033', 'HVAC',          'HVAC',                    'Paid contractor bill',              'p3', 'pending_payment',           'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 3::bigint, null::timestamptz),
  ('E2E-STAFF-BILL-SUBMIT',    '034', 'General',       'General Maintenance',      'Staff invoice submission',          'p3', 'pending_invoice',           'Completed',                   null::uuid,                  1500::numeric, false, null,                    true,  null::timestamptz,              now() - interval '1 hour',    null::uuid,                 null::text,                         0, 1::bigint, null::timestamptz),
  ('E2E-STAFF-BILL-EDIT',      '035', 'General',       'General Maintenance',      'Staff billing edit and delete',     'p3', 'pending_invoice',           'Completed',                   null::uuid,                  1500::numeric, false, null,                    true,  null::timestamptz,              now() - interval '1 hour',    null::uuid,                 null::text,                         0, 1::bigint, null::timestamptz),
  ('E2E-CLOSED-REOPEN',        '036', 'General',       'General Maintenance',      'Reopen closed work order',          'p3', 'closed',                    'Completed',                   :'direct_id'::uuid,          1200::numeric, false, null,                    false, now() - interval '4 hours',   now() - interval '2 hours',   null::uuid,                 'Synthetic Direct Contractor',     0, 3::bigint, now() - interval '1 hour'),
  ('E2E-TRANSFER-OPEN',        '037', 'HVAC',          'HVAC',                    'Emergency open-visit transfer',     'p2', 'wip',                       'Work in Progress',            :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '2 hours',   null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     1, 1::bigint, null::timestamptz),
  ('E2E-APPROVED-CANCEL',      '038', 'HVAC',          'HVAC',                    'QuickBooks handoff cancellation',   'p3', 'pending_payment',           'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-STAFF-DELETE',         '039', 'HVAC',          'HVAC',                    'Staff deletes contractor draft',    'p3', 'pending_invoice',           'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-BATCH-APPROVE-A',     '040', 'HVAC',          'HVAC',                    'Batch approve contractor bill A',   'p3', 'pending_approval',          'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-BATCH-APPROVE-B',     '041', 'HVAC',          'HVAC',                    'Batch approve contractor bill B',   'p3', 'pending_approval',          'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-BATCH-REJECT-A',      '042', 'HVAC',          'HVAC',                    'Batch reject contractor bill A',    'p3', 'pending_approval',          'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-BATCH-REJECT-B',      '043', 'HVAC',          'HVAC',                    'Batch reject contractor bill B',    'p3', 'pending_approval',          'Completed',                   :'direct_id'::uuid,          2500::numeric, false, null,                    false, now() - interval '3 hours',   now() - interval '1 hour',    null::uuid,                 'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-HISTORY-FILES',       '044', 'Refrigeration', 'Refrigeration equipment',  'Closed-history private files',      'p3', 'wip',                       'Work in Progress',            :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '2 hours',   null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 1::bigint, null::timestamptz),
  ('E2E-WORK-REPORT',         '045', 'Refrigeration', 'Refrigeration equipment',  'Work report controls',              'p3', 'wip',                       'Work in Progress',            :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '2 hours',   null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 1::bigint, null::timestamptz),
  ('E2E-ACCESS-REVOCATION',   '046', 'Refrigeration', 'Refrigeration equipment',  'Live access revocation',            'p2', 'assigned',                  'Dispatched',                  :'company_admin_id'::uuid,   1500::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              :'revocation_tech_id'::uuid, 'Synthetic Revocation Technician', 0, 0::bigint, null::timestamptz),
  ('E2E-AGED-PARTS',          '047', 'Refrigeration', 'Refrigeration equipment',  'Aged paused field work',            'p2', 'parts',                     'Awaiting Parts',              :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '32 days',  null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 4::bigint, null::timestamptz),
  ('E2E-AGED-CAPITAL-PARTS',  '048', 'Refrigeration', 'Refrigeration equipment',  'Aged paused capital field work',    'p2', 'parts',                     'Awaiting Parts',              :'direct_id'::uuid,          5000::numeric, true,  'Approved - work authorized',false, now() - interval '32 days',  null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 4::bigint, null::timestamptz),
  ('E2E-AGED-INVOICE-PARTS',  '049', 'Refrigeration', 'Refrigeration equipment',  'Aged paused invoicing field work',  'p2', 'pending_invoice',           'Awaiting Parts',              :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '32 days',  null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 4::bigint, null::timestamptz),
  ('E2E-AGED-CAPITAL-WAIT',   '050', 'Refrigeration', 'Refrigeration equipment',  'Aged capital authorization wait',   'p2', 'pending_capital_completion','Pending Capital Completion',  :'direct_id'::uuid,          5000::numeric, true,  'Approved - work authorized',false, now() - interval '32 days',  null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 4::bigint, null::timestamptz),
  ('E2E-STAFF-BILL-CALC',     '051', 'General',       'General Maintenance',      'Billing calculation persistence',   'p3', 'pending_invoice',           'Completed',                   null::uuid,                  2000::numeric, false, null,                    true,  null::timestamptz,              now() - interval '1 hour',    null::uuid,                 null::text,                         0, 1::bigint, null::timestamptz),
  ('WOTEST3',                 '052', 'Refrigeration', 'Refrigeration equipment',  'Full synthetic role workflow',      'p2', 'unassigned',                'New',                         null::uuid,                  2500::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 null::text,                         0, 0::bigint, null::timestamptz),
  ('WOTEST4',                 '053', 'General',       'General Maintenance',      'Capital and team mixed workflow',   'p1', 'unassigned',                'New',                         null::uuid,                  6000::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 null::text,                         0, 0::bigint, null::timestamptz),
  ('E2E-AGED-VISIT-CORRECT',  '054', 'Refrigeration', 'Refrigeration equipment',  'Aged contractor visit correction',  'p3', 'pending_invoice',           'Completed',                   :'direct_id'::uuid,          1800::numeric, false, null,                    false, '2024-01-15 12:00:00+00'::timestamptz, '2024-01-15 13:00:00+00'::timestamptz, null::uuid,          'Synthetic Direct Contractor',     0, 2::bigint, null::timestamptz),
  ('E2E-COMPLETED-RETURN',    '055', 'Refrigeration', 'Refrigeration equipment',  'Completed company return visit',    'p1', 'completed',                 'Completed',                   :'company_admin_id'::uuid,   5000::numeric, false, null,                    false, now() - interval '6 days',    now() - interval '6 days' + interval '2 hours', :'report_tech_id'::uuid, 'Synthetic Report Technician', 2, 5::bigint, null::timestamptz),
  ('E2E-COMPLETED-RETURN-MOBILE','056','Refrigeration','Refrigeration equipment',  'Completed mobile return visit',     'p2', 'completed',                 'Completed',                   :'company_admin_id'::uuid,   4000::numeric, false, null,                    false, now() - interval '8 days',    now() - interval '8 days' + interval '90 minutes', :'report_tech_id'::uuid, 'Synthetic Report Technician', 1, 4::bigint, null::timestamptz),
  ('E2E-COMPLETED-RETURN-STAFF','057','HVAC',          'HVAC',                    'Completed staff return visit',      'p2', 'pending_approval',          'Completed',                   :'direct_id'::uuid,          3000::numeric, false, null,                    false, now() - interval '4 days',    now() - interval '4 days' + interval '2 hours', null::uuid, 'Synthetic Direct Contractor', 1, 4::bigint, null::timestamptz),
  ('E2E-MOBILE-FIELD',        '058', 'Refrigeration', 'Refrigeration equipment',  'Isolated mobile field lifecycle',   'p3', 'assigned',                  'Dispatched',                  :'company_admin_id'::uuid,   1800::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              :'report_tech_id'::uuid, 'Synthetic Report Technician', 0, 0::bigint, null::timestamptz),
  ('E2E-MOBILE-STANDALONE',   '059', 'Refrigeration', 'Refrigeration equipment',  'Installed mobile field lifecycle',  'p3', 'assigned',                  'Dispatched',                  :'company_admin_id'::uuid,   1800::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              :'report_tech_id'::uuid, 'Synthetic Report Technician', 0, 0::bigint, null::timestamptz),
  ('E2E-PHOTO-CONCURRENT-A',  '060', 'Refrigeration', 'Refrigeration equipment',  'Concurrent mobile photo batch A',   'p3', 'wip',                       'Work in Progress',            :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '2 hours',   null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 1::bigint, null::timestamptz),
  ('E2E-PHOTO-CONCURRENT-B',  '061', 'Refrigeration', 'Refrigeration equipment',  'Concurrent mobile photo batch B',   'p3', 'wip',                       'Work in Progress',            :'direct_id'::uuid,          1800::numeric, false, null,                    false, now() - interval '2 hours',   null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 1::bigint, null::timestamptz),
  ('E2E-STORE-ACTIVE',        '062', 'General',       'General Maintenance',      'Exact store active call',            'p3', 'assigned',                  'Dispatched',                  :'direct_id'::uuid,          1200::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              null::uuid,                 'Synthetic Direct Contractor',     0, 1::bigint, null::timestamptz),
  ('E2E-STORE-CLOSED',        '063', 'General',       'General Maintenance',      'Exact store historical call',        'p3', 'closed',                    'Completed',                   :'direct_id'::uuid,          1200::numeric, false, null,                    false, now() - interval '3 days',    now() - interval '3 days' + interval '1 hour', null::uuid,          'Synthetic Direct Contractor',     0, 3::bigint, now() - interval '2 days'),
  ('WOTEST5',                 '064', 'Refrigeration', 'Refrigeration equipment',  'Legacy-linked mobile field work',    'p2', 'assigned',                  'Dispatched',                  :'company_admin_id'::uuid,   2400::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              :'legacy_invoice_tech_id'::uuid, 'Synthetic Legacy Invoice Technician', 0, 0::bigint, null::timestamptz),
  ('WOTEST5-OVERLAP',         '065', 'Refrigeration', 'Refrigeration equipment',  'Parallel assigned mobile field work','p3', 'assigned',                  'Dispatched',                  :'company_admin_id'::uuid,   1800::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              :'legacy_invoice_tech_id'::uuid, 'Synthetic Legacy Invoice Technician', 0, 0::bigint, null::timestamptz),
  ('WOTEST6',                 '066', 'HVAC',          'HVAC',                     'Aged mixed billing field workflow',  'p1', 'pending_invoice',           'Awaiting Parts',              :'company_admin_id'::uuid,   4200::numeric, false, null,                    false, now() - interval '30 days',   now() - interval '30 days' + interval '90 minutes', :'invoice_tech_id'::uuid, 'Synthetic Invoice Technician', 0, 4::bigint, null::timestamptz),
  ('WOT9005005',              '067', 'Refrigeration', 'Refrigeration equipment',  'Exact high-volume assignment lookup','p3', 'assigned',                  'Dispatched',                  :'company_admin_id'::uuid,   1800::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              :'legacy_invoice_tech_id'::uuid, 'Synthetic Legacy Invoice Technician', 0, 0::bigint, null::timestamptz),
  ('WOTEST7',                 '068', 'Refrigeration', 'Refrigeration equipment',  'Active visit enters capital review', 'p1', 'assigned',                  'Dispatched',                  :'company_admin_id'::uuid,   6400::numeric, false, null,                    false, null::timestamptz,              null::timestamptz,              :'invoice_tech_id'::uuid, 'Synthetic Invoice Technician', 0, 0::bigint, null::timestamptz)
) as fixture(
  id, sequence, line_of_service, business_service, summary, priority, status,
  functional_status, contractor_id, nte, is_capital, capital_status,
  billing_only, start_time, end_time, assigned_technician_profile_id,
  technician_on_job, workflow_cycle, lifecycle_version, closed_at
);

-- Eleazar/Cliff-style accounts can carry many active assignments. Keep this
-- synthetic legacy-linked technician above the 25-row My Jobs page size so
-- exact search, cursor reset, counts and direct detail access are exercised
-- together instead of only on a short first page.
insert into public.work_orders (
  id, incident_id, store_number, city, address, store_state, store_timezone,
  line_of_service, business_service, category, sub_category, summary, description,
  priority, status, functional_status, contractor_id, afm_id, afm_name, afm_email,
  nte, dispatched_at, is_capital, created_by, source, billing_only,
  contractor_assignment_started_at, contractor_assignment_version,
  assigned_technician_profile_id, technician_on_job, workflow_cycle, lifecycle_version
)
select
  'WOTEST5-Q' || lpad(sequence::text, 2, '0'),
  'E2E-INC-5Q' || lpad(sequence::text, 2, '0'),
  'E2E001', 'Synthetic City, TX',
  '100 Test Fixture Way, Synthetic City, TX 75001', 'TX', 'America/Chicago',
  'Refrigeration', 'Refrigeration equipment', 'Synthetic fixture',
  'High-volume assigned queue',
  'Legacy-linked assignment ' || sequence,
  'Disposable active queue fixture ' || sequence || ' for pagination and search.',
  'p3'::public.wo_priority, 'assigned'::public.wo_status,
  'Dispatched'::public.fsm_functional_status,
  :'company_admin_id'::uuid,
  '00000000-0000-4000-8000-00000000e301'::uuid,
  'Synthetic AFM', null, 1800, now() - make_interval(mins => sequence),
  false, :'dispatcher_id'::uuid, 'manual', false,
  now() - make_interval(mins => sequence), 1,
  :'legacy_invoice_tech_id'::uuid, 'Synthetic Legacy Invoice Technician', 0, 0::bigint
from generate_series(1, 26) sequence;

-- A legacy company technician without a login is a real supported directory
-- shape.  It must remain visible to company administrators without exposing
-- edit/deactivate controls that require a profile identity.
insert into public.contractor_technicians (contractor_id, profile_id, name, tier, is_active)
values (:'company_admin_id'::uuid, null, 'Synthetic Legacy Technician', 'contracted', true);

-- Seed a contractor-owned part so browser coverage can exercise edit, status,
-- purchasing-request and removal controls.  Postgres owner maintenance is used
-- only by this disposable local seed; browser mutations still use real RPCs.
insert into public.wo_parts (
  id, work_order_id, description, part_number, qty, status,
  tracking_number, expected_return_date, created_by
)
values (
  '00000000-0000-4000-8000-00000000f101', 'E2E-PARTS',
  'Synthetic condenser fan motor', 'SYN-FAN-001', 1, 'ordered',
  'SYNTRACK001', current_date + 3, :'direct_id'::uuid
);

insert into public.work_order_visits (
  id, work_order_id, contractor_id, check_in_at, check_out_at,
  checked_in_by, checked_out_by
)
values
  (
    '00000000-0000-4000-8000-00000000f201', 'E2E-VISIT-CORRECT',
    :'direct_id'::uuid, now() - interval '3 hours', now() - interval '2 hours',
    :'direct_id'::uuid, :'direct_id'::uuid
  ),
  (
    '00000000-0000-4000-8000-00000000f202', 'E2E-TRANSFER-OPEN',
    :'direct_id'::uuid, now() - interval '2 hours', null,
    :'direct_id'::uuid, null
  ),
  (
    '00000000-0000-4000-8000-00000000f203', 'E2E-AGED-PARTS',
    :'direct_id'::uuid, now() - interval '32 days', now() - interval '32 days' + interval '90 minutes',
    :'direct_id'::uuid, :'direct_id'::uuid
  ),
  (
    '00000000-0000-4000-8000-00000000f204', 'E2E-AGED-CAPITAL-PARTS',
    :'direct_id'::uuid, now() - interval '32 days', now() - interval '32 days' + interval '75 minutes',
    :'direct_id'::uuid, :'direct_id'::uuid
  ),
  (
    '00000000-0000-4000-8000-00000000f205', 'E2E-AGED-INVOICE-PARTS',
    :'direct_id'::uuid, now() - interval '32 days', now() - interval '32 days' + interval '60 minutes',
    :'direct_id'::uuid, :'direct_id'::uuid
  ),
  (
    '00000000-0000-4000-8000-00000000f206', 'E2E-AGED-CAPITAL-WAIT',
    :'direct_id'::uuid, now() - interval '32 days', now() - interval '32 days' + interval '45 minutes',
    :'direct_id'::uuid, :'direct_id'::uuid
  ),
  (
    '00000000-0000-4000-8000-00000000f207', 'E2E-AGED-VISIT-CORRECT',
    :'direct_id'::uuid, '2024-01-15 12:00:00+00'::timestamptz, '2024-01-15 13:00:00+00'::timestamptz,
    :'direct_id'::uuid, :'direct_id'::uuid
  ),
  (
    '00000000-0000-4000-8000-00000000f208', 'E2E-COMPLETED-RETURN',
    :'company_admin_id'::uuid, now() - interval '6 days', now() - interval '6 days' + interval '2 hours',
    :'report_tech_id'::uuid, :'report_tech_id'::uuid
  ),
  (
    '00000000-0000-4000-8000-00000000f209', 'E2E-COMPLETED-RETURN-MOBILE',
    :'company_admin_id'::uuid, now() - interval '8 days', now() - interval '8 days' + interval '90 minutes',
    :'report_tech_id'::uuid, :'report_tech_id'::uuid
  ),
  (
    '00000000-0000-4000-8000-00000000f210', 'E2E-COMPLETED-RETURN-STAFF',
    :'direct_id'::uuid, now() - interval '4 days', now() - interval '4 days' + interval '2 hours',
    :'direct_id'::uuid, :'direct_id'::uuid
  ),
  (
    '00000000-0000-4000-8000-00000000f211', 'WOTEST6',
    :'company_admin_id'::uuid, now() - interval '30 days', now() - interval '30 days' + interval '90 minutes',
    :'invoice_tech_id'::uuid, :'invoice_tech_id'::uuid
  );

insert into public.activities (
  id, work_order_id, author_id, author_name, text, type,
  entered_by_role, event_key, event_data, requires_7eleven_sync,
  is_staff_only, contractor_assignment_version, workflow_cycle, activity_channel
)
values
  ('00000000-0000-4000-8000-00000000f301', 'E2E-ACTIVITY', :'direct_id'::uuid,
   'Synthetic Direct Contractor', 'Synthetic contractor update for acknowledgement.', 'note',
   'contractor', 'note', '{}'::jsonb, false, false, 1, 0, 'contractor_message'),
  ('00000000-0000-4000-8000-00000000f302', 'E2E-ACTIVITY', :'manager_id'::uuid,
   'Synthetic Manager', 'Synthetic 7-Eleven update requiring confirmation.', 'note',
   'manager', 'note', '{}'::jsonb, true, false, 1, 0, 'field_note'),
  ('00000000-0000-4000-8000-00000000f303', 'E2E-ACTIVITY', :'manager_id'::uuid,
   'Synthetic Manager', 'Synthetic internal note for deletion.', 'note',
   'manager', 'note', '{}'::jsonb, false, true, 1, 0, 'internal_note');

insert into public.invoices (
  id, num, work_order_id, store_number, store_address, contractor_id, cme,
  invoice_date, service_date, due_date, terms, state, subtotal, sales_tax, total,
  rejection_reason, qbo_invoice_id, qbo_synced_at, paid_at, created_by,
  invoice_type, territory, review_revision, rejected_at, rejected_by,
  document_kind, equipment_tag, invoice_version
)
values
  ('00000000-0000-4000-8000-00000000a101', 'E2E-SUBMITTED-APPROVE', 'E2E-REVIEW-APPROVE', 'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 200, 0, 200, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a102', 'E2E-SUBMITTED-REJECT',  'E2E-REVIEW-REJECT',  'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 210, 0, 210, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a103', 'E2E-REJECTED',           'E2E-REJECTED-EDIT',   'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'rejected', 220, 0, 220, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 2),
  ('00000000-0000-4000-8000-00000000a104', 'E2E-DRAFT-DELETE',       'E2E-DRAFT-DELETE',     'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'draft', 230, 0, 230, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a105', 'E2E-APPROVED-HOLD',      'E2E-APPROVED-HOLD',    'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'approved', 240, 0, 240, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 2),
  ('00000000-0000-4000-8000-00000000a106', 'E2E-APPROVED-HANDOFF',   'E2E-APPROVED-HANDOFF', 'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'approved', 250, 0, 250, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 2),
  ('00000000-0000-4000-8000-00000000a107', 'E2E-PAID',               'E2E-PAID',             'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'paid', 260, 0, 260, null, 'SYN-QBO-001', now() - interval '1 hour', now() - interval '1 hour', :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 3),
  ('00000000-0000-4000-8000-00000000a108', 'P1-E2E-EDIT-001',        'E2E-STAFF-BILL-EDIT',  'E2E001', '100 Test Fixture Way', null, 'Synthetic P1 billing draft', current_date, current_date, current_date + 60, 'Net 60', 'draft', 300, 0, 300, null, null, null, null, :'backoffice_id'::uuid, 'staff', 'Texas', 1, null, null, 'invoice', '7-ELEVEN: General Maintenance', 1),
  ('00000000-0000-4000-8000-00000000a109', 'E2E-APPROVED-CANCEL',     'E2E-APPROVED-CANCEL',  'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'approved', 270, 0, 270, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 2),
  ('00000000-0000-4000-8000-00000000a110', 'E2E-STAFF-DELETE',        'E2E-STAFF-DELETE',     'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'draft', 280, 0, 280, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a111', 'E2E-BATCH-APPROVE-A',    'E2E-BATCH-APPROVE-A', 'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 290, 0, 290, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a112', 'E2E-BATCH-APPROVE-B',    'E2E-BATCH-APPROVE-B', 'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 300, 0, 300, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a113', 'E2E-BATCH-REJECT-A',     'E2E-BATCH-REJECT-A',  'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 310, 0, 310, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a114', 'E2E-BATCH-REJECT-B',     'E2E-BATCH-REJECT-B',  'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic contractor bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 320, 0, 320, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a115', 'E2E-RETURN-ONE',          'E2E-COMPLETED-RETURN', 'E2E001', '100 Test Fixture Way', :'company_admin_id'::uuid, 'Synthetic first submitted bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 440, 0, 440, null, null, null, null, :'company_admin_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a116', 'E2E-RETURN-TWO',          'E2E-COMPLETED-RETURN', 'E2E001', '100 Test Fixture Way', :'company_admin_id'::uuid, 'Synthetic second submitted bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 1130, 0, 1130, null, null, null, null, :'company_admin_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a117', 'E2E-MOBILE-RETURN',       'E2E-COMPLETED-RETURN-MOBILE', 'E2E001', '100 Test Fixture Way', :'company_admin_id'::uuid, 'Synthetic mobile submitted bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 300, 0, 300, null, null, null, null, :'company_admin_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1),
  ('00000000-0000-4000-8000-00000000a118', 'E2E-STAFF-RETURN',        'E2E-COMPLETED-RETURN-STAFF', 'E2E001', '100 Test Fixture Way', :'direct_id'::uuid, 'Synthetic staff-path submitted bill', current_date, current_date, current_date + 30, 'Net 30', 'submitted', 500, 0, 500, null, null, null, null, :'direct_id'::uuid, 'contractor', null, 1, null, null, 'invoice', null, 1);

-- Establish the rejected snapshot using the same transaction marker enforced
-- for staff review transitions, while retaining owner-maintenance seeding.
select set_config('app.contractor_invoice_transition', 'review', true);
update public.invoices
set rejection_reason = 'Please clarify the labor description.',
    rejected_at = now() - interval '1 hour',
    rejected_by = :'manager_id'::uuid
where id = '00000000-0000-4000-8000-00000000a103';

insert into public.invoice_lines (
  invoice_id, position, type, description, qty, rate, is_taxable
)
select invoice.id, 1, invoice.line_type, invoice.description, 1, invoice.amount, false
from (values
  ('00000000-0000-4000-8000-00000000a101'::uuid, 'Labor', 'Synthetic approval labor', 200::numeric),
  ('00000000-0000-4000-8000-00000000a102'::uuid, 'Labor', 'Synthetic rejection labor', 210::numeric),
  ('00000000-0000-4000-8000-00000000a103'::uuid, 'Labor', 'Synthetic rejected labor', 220::numeric),
  ('00000000-0000-4000-8000-00000000a104'::uuid, 'Parts/Hardware', 'Synthetic draft part', 230::numeric),
  ('00000000-0000-4000-8000-00000000a105'::uuid, 'Labor', 'Synthetic approved labor', 240::numeric),
  ('00000000-0000-4000-8000-00000000a106'::uuid, 'Labor', 'Synthetic handoff labor', 250::numeric),
  ('00000000-0000-4000-8000-00000000a107'::uuid, 'Labor', 'Synthetic paid labor', 260::numeric),
  ('00000000-0000-4000-8000-00000000a108'::uuid, 'Labor', 'Synthetic staff labor', 300::numeric),
  ('00000000-0000-4000-8000-00000000a109'::uuid, 'Labor', 'Synthetic handoff cancellation labor', 270::numeric),
  ('00000000-0000-4000-8000-00000000a110'::uuid, 'Labor', 'Synthetic staff deletion labor', 280::numeric),
  ('00000000-0000-4000-8000-00000000a111'::uuid, 'Labor', 'Synthetic batch approval labor A', 290::numeric),
  ('00000000-0000-4000-8000-00000000a112'::uuid, 'Labor', 'Synthetic batch approval labor B', 300::numeric),
  ('00000000-0000-4000-8000-00000000a113'::uuid, 'Labor', 'Synthetic batch rejection labor A', 310::numeric),
  ('00000000-0000-4000-8000-00000000a114'::uuid, 'Labor', 'Synthetic batch rejection labor B', 320::numeric),
  ('00000000-0000-4000-8000-00000000a115'::uuid, 'Labor', 'Synthetic completed return labor one', 440::numeric),
  ('00000000-0000-4000-8000-00000000a116'::uuid, 'Parts/Hardware', 'Synthetic completed return parts two', 1130::numeric),
  ('00000000-0000-4000-8000-00000000a117'::uuid, 'Labor', 'Synthetic mobile return labor', 300::numeric),
  ('00000000-0000-4000-8000-00000000a118'::uuid, 'Labor', 'Synthetic staff return labor', 500::numeric)
) as invoice(id, line_type, description, amount);

insert into public.work_order_afm_contacts (work_order_id, afm_email)
select id, 'afm@synthetic.invalid'
from public.work_orders
where id like 'E2E-%';

commit;
