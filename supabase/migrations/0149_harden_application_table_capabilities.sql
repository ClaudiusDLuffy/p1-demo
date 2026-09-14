-- Forward-only ACL correction derived from the executable native chain through 0148.
-- No rows, RPC behavior, RLS, ownership, sequences, or platform-managed schemas change.
-- Resolve the actual application owner; do not assume the session's role name.
-- Abort on an unreviewed table set, ambiguous owner, inherited client authority,
-- or global defaults which cannot be corrected with a public-only REVOKE.
begin;
do $p1_application_acl$
declare
  v_tables text[] := array[
    'activities',
    'afms',
    'billing_tax_rule_audit',
    'billing_tax_rules',
    'client_diagnostic_rate_limit_buckets',
    'client_diagnostic_rate_limit_guards',
    'contractor_activity_alert_deliveries',
    'contractor_assignment_transition_deliveries',
    'contractor_estimate_attachments',
    'contractor_estimate_lines',
    'contractor_estimate_templates',
    'contractor_estimates',
    'contractor_invoice_payment_hold_events',
    'contractor_invoice_payment_holds',
    'contractor_receiving_dispatch_deliveries',
    'contractor_technician_admin_events',
    'contractor_technicians',
    'controller_invoice_export_batches',
    'controller_invoice_export_items',
    'email_intake_log',
    'email_intake_log_write_guards',
    'email_priority_escalation_events',
    'financial_notification_attempt_events',
    'financial_notification_control',
    'financial_notification_deliveries',
    'financial_notification_events',
    'financial_notification_hold_heads',
    'financial_notification_hold_supersessions',
    'financial_notification_mutation_operations',
    'financial_notification_operations',
    'financial_notification_record_guards',
    'financial_notification_source_guards',
    'financial_operation_claims',
    'invoice_financial_control',
    'invoice_financial_operations',
    'invoice_financial_transition_guards',
    'invoice_lines',
    'invoices',
    'organizations',
    'p1_part_cost_audit',
    'p1_part_costs',
    'p1_part_procurement_transition_guards',
    'p1_parts_alert_deliveries',
    'p1_parts_alert_recipients',
    'p1_parts_alert_settings',
    'p1_parts_sms_attempt_events',
    'p1_parts_sms_guards',
    'p1_parts_sms_operations',
    'p1_parts_sms_runs',
    'p1_parts_sms_source_generations',
    'photos',
    'private_object_bindings',
    'private_object_control',
    'private_object_deletions',
    'private_object_photo_batches',
    'private_object_transition_guards',
    'private_object_uploads',
    'profiles',
    'qbo_tokens',
    'quickbooks_connection_events',
    'quickbooks_connections',
    'quickbooks_oauth_states',
    'receiving_dispatch_attempt_events',
    'receiving_dispatch_control',
    'receiving_dispatch_operations',
    'receiving_dispatch_transition_guards',
    'sales_tax_location_rates',
    'service_notes',
    'staff_invoice_default_series',
    'staff_invoice_number_series',
    'staff_invoice_sources',
    'staff_permission_grants',
    'staff_work_order_notification_reads',
    'staff_work_order_todos',
    'state_sales_tax_rates',
    'stores',
    'tax_rate_import_batches',
    'wo_parts',
    'work_order_afm_contacts',
    'work_order_assignment_command_guards',
    'work_order_assignment_control',
    'work_order_assignment_history',
    'work_order_assignment_operations',
    'work_order_assignment_transition_guards',
    'work_order_billing_operations',
    'work_order_close_transition_guards',
    'work_order_financials',
    'work_order_lifecycle_control',
    'work_order_lifecycle_operations',
    'work_order_lifecycle_transition_guards',
    'work_order_priority_family_transition_guards',
    'work_order_reopen_transition_guards',
    'work_order_technician_assignments',
    'work_order_visit_correction_context',
    'work_order_visit_corrections',
    'work_order_visits',
    'work_orders',
    'work_reports'
  ]::text[];
  v_actual text[];
  v_owner oid;
  v_owner_name text;
  v_relation record;
  v_role text;
  v_preserved jsonb;
  v_after jsonb;
begin
  if current_setting('server_version_num')::integer < 170000 then
    raise exception 'P1 ACL 0149 requires PostgreSQL 17 or later for MAINTAIN verification';
  end if;
  select array_agg(c.relname order by c.relname) into v_actual from (select c.oid,c.relowner,c.relname from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
      and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')) c;
  if v_actual is distinct from v_tables then
    raise exception 'P1 ACL 0149 application table inventory differs; owner review required';
  end if;
  select relowner into strict v_owner from pg_catalog.pg_class where oid='public.work_orders'::regclass;
  if exists(select 1 from (select c.oid,c.relowner,c.relname from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
      and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')) c where c.relowner<>v_owner) then
    raise exception 'P1 ACL 0149 found an unexpected application object owner';
  end if;
  select rolname into strict v_owner_name from pg_catalog.pg_roles where oid=v_owner;
  for v_role in select unnest(array['anon','authenticated']) loop
    if exists(select 1 from pg_catalog.pg_roles r where r.rolname=v_role and
      (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls))
      or exists(select 1 from pg_catalog.pg_roles r where r.rolname<>v_role and
        (pg_catalog.pg_has_role(v_role,r.oid,'USAGE') or pg_catalog.pg_has_role(v_role,r.oid,'SET'))) then
      raise exception 'P1 ACL 0149 client role has unexpected inherited or administrative authority: %',v_role;
    end if;
  end loop;
  if exists(select 1 from pg_catalog.pg_default_acl d
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where d.defaclrole=v_owner and d.defaclnamespace=0 and d.defaclobjtype='r'
      and (a.grantee=0 or a.grantee in (select oid from pg_catalog.pg_roles where rolname in ('anon','authenticated')))
      and (a.privilege_type in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
        or a.grantee=(select oid from pg_catalog.pg_roles where rolname='anon') and a.privilege_type in ('INSERT','UPDATE','DELETE'))) then
    raise exception 'P1 ACL 0149 global owner defaults exceed public-only repair authority';
  end if;
  select jsonb_agg(jsonb_build_array(c.relname,r.rolname,p.privilege,
      pg_catalog.has_table_privilege(r.oid,c.oid,p.privilege)) order by c.relname,r.rolname,p.privilege) into v_preserved
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    cross join pg_catalog.pg_roles r cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(privilege)
    where n.nspname='public' and c.relname=any(v_tables)
      and r.rolname in ('anon','authenticated','service_role')
      and not (r.rolname in ('anon','authenticated') and p.privilege in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'))
      and not (r.rolname='anon' and p.privilege in ('INSERT','UPDATE','DELETE'));
  -- Narrow capability revocation; never REVOKE ALL then guessed regrant.
  for v_relation in select c.relname from (select c.oid,c.relowner,c.relname from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
      and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')) c loop
    execute format('revoke truncate,references,trigger,maintain on table public.%I from anon,authenticated,public',v_relation.relname);
    -- 0024 and later application grants provide anon reads, never direct writes.
    execute format('revoke insert,update,delete on table public.%I from anon',v_relation.relname);
  end loop;
  revoke create on schema public from anon,authenticated,public;
  execute format('alter default privileges for role %I in schema public revoke truncate,references,trigger,maintain on tables from anon,authenticated,public',v_owner_name);
  execute format('alter default privileges for role %I in schema public revoke insert,update,delete on tables from anon',v_owner_name);
  select jsonb_agg(jsonb_build_array(c.relname,r.rolname,p.privilege,
      pg_catalog.has_table_privilege(r.oid,c.oid,p.privilege)) order by c.relname,r.rolname,p.privilege) into v_after
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    cross join pg_catalog.pg_roles r cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(privilege)
    where n.nspname='public' and c.relname=any(v_tables)
      and r.rolname in ('anon','authenticated','service_role')
      and not (r.rolname in ('anon','authenticated') and p.privilege in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'))
      and not (r.rolname='anon' and p.privilege in ('INSERT','UPDATE','DELETE'));
  if v_after is distinct from v_preserved then
    raise exception 'P1 ACL 0149 changed intended DML or service-owned capabilities';
  end if;
  if exists(select 1 from (select c.oid,c.relowner,c.relname from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
      and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')) c cross join pg_catalog.pg_roles r
    cross join unnest(array['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(privilege)
    where r.rolname in ('anon','authenticated') and pg_catalog.has_table_privilege(r.oid,c.oid,p.privilege)) then
    raise exception 'P1 ACL 0149 prohibited effective table authority remains';
  end if;
end;
$p1_application_acl$;
commit;
