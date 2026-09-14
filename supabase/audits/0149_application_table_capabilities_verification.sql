-- Read-only final ACL verifier. An exception is a failing gate, not a repair.
begin;
set transaction read only;
do $p1_application_acl_audit$
declare
  v_expected jsonb := $p1_expected${"activities":{"anon":["SELECT"],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","SELECT","UPDATE"]},"afms":{"anon":["SELECT"],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"billing_tax_rule_audit":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"billing_tax_rules":{"anon":[],"authenticated":["INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"client_diagnostic_rate_limit_buckets":{"anon":[],"authenticated":[],"service_role":[]},"client_diagnostic_rate_limit_guards":{"anon":[],"authenticated":[],"service_role":[]},"contractor_activity_alert_deliveries":{"anon":[],"authenticated":[],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"contractor_assignment_transition_deliveries":{"anon":[],"authenticated":[],"service_role":["SELECT"]},"contractor_estimate_attachments":{"anon":[],"authenticated":["SELECT"],"service_role":["SELECT"]},"contractor_estimate_lines":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"contractor_estimate_templates":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"contractor_estimates":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"contractor_invoice_payment_hold_events":{"anon":[],"authenticated":["SELECT"],"service_role":["MAINTAIN","REFERENCES","SELECT","TRIGGER"]},"contractor_invoice_payment_holds":{"anon":[],"authenticated":["SELECT"],"service_role":["MAINTAIN","REFERENCES","SELECT","TRIGGER"]},"contractor_receiving_dispatch_deliveries":{"anon":[],"authenticated":[],"service_role":[]},"contractor_technician_admin_events":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"contractor_technicians":{"anon":["SELECT"],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"controller_invoice_export_batches":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"controller_invoice_export_items":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"email_intake_log":{"anon":[],"authenticated":["SELECT"],"service_role":["SELECT"]},"email_intake_log_write_guards":{"anon":[],"authenticated":[],"service_role":[]},"email_priority_escalation_events":{"anon":[],"authenticated":[],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"financial_notification_attempt_events":{"anon":[],"authenticated":[],"service_role":[]},"financial_notification_control":{"anon":[],"authenticated":[],"service_role":[]},"financial_notification_deliveries":{"anon":[],"authenticated":[],"service_role":[]},"financial_notification_events":{"anon":[],"authenticated":[],"service_role":[]},"financial_notification_hold_heads":{"anon":[],"authenticated":[],"service_role":[]},"financial_notification_hold_supersessions":{"anon":[],"authenticated":[],"service_role":[]},"financial_notification_mutation_operations":{"anon":[],"authenticated":[],"service_role":[]},"financial_notification_operations":{"anon":[],"authenticated":[],"service_role":[]},"financial_notification_record_guards":{"anon":[],"authenticated":[],"service_role":[]},"financial_notification_source_guards":{"anon":[],"authenticated":[],"service_role":[]},"financial_operation_claims":{"anon":[],"authenticated":[],"service_role":[]},"invoice_financial_control":{"anon":[],"authenticated":[],"service_role":[]},"invoice_financial_operations":{"anon":[],"authenticated":[],"service_role":[]},"invoice_financial_transition_guards":{"anon":[],"authenticated":[],"service_role":[]},"invoice_lines":{"anon":["SELECT"],"authenticated":["SELECT"],"service_role":["MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE"]},"invoices":{"anon":["SELECT"],"authenticated":["SELECT"],"service_role":["MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE"]},"organizations":{"anon":[],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"p1_part_cost_audit":{"anon":[],"authenticated":[],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"p1_part_costs":{"anon":[],"authenticated":[],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"p1_part_procurement_transition_guards":{"anon":[],"authenticated":[],"service_role":[]},"p1_parts_alert_deliveries":{"anon":[],"authenticated":[],"service_role":[]},"p1_parts_alert_recipients":{"anon":[],"authenticated":[],"service_role":["SELECT"]},"p1_parts_alert_settings":{"anon":[],"authenticated":[],"service_role":["SELECT"]},"p1_parts_sms_attempt_events":{"anon":[],"authenticated":[],"service_role":[]},"p1_parts_sms_guards":{"anon":[],"authenticated":[],"service_role":[]},"p1_parts_sms_operations":{"anon":[],"authenticated":[],"service_role":[]},"p1_parts_sms_runs":{"anon":[],"authenticated":[],"service_role":[]},"p1_parts_sms_source_generations":{"anon":[],"authenticated":[],"service_role":[]},"photos":{"anon":[],"authenticated":["SELECT"],"service_role":["SELECT"]},"private_object_bindings":{"anon":[],"authenticated":[],"service_role":[]},"private_object_control":{"anon":[],"authenticated":[],"service_role":[]},"private_object_deletions":{"anon":[],"authenticated":[],"service_role":[]},"private_object_photo_batches":{"anon":[],"authenticated":[],"service_role":[]},"private_object_transition_guards":{"anon":[],"authenticated":[],"service_role":[]},"private_object_uploads":{"anon":[],"authenticated":[],"service_role":[]},"profiles":{"anon":["SELECT"],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"qbo_tokens":{"anon":[],"authenticated":[],"service_role":["SELECT"]},"quickbooks_connection_events":{"anon":[],"authenticated":[],"service_role":["SELECT"]},"quickbooks_connections":{"anon":[],"authenticated":[],"service_role":["SELECT"]},"quickbooks_oauth_states":{"anon":[],"authenticated":[],"service_role":["SELECT","UPDATE"]},"receiving_dispatch_attempt_events":{"anon":[],"authenticated":[],"service_role":[]},"receiving_dispatch_control":{"anon":[],"authenticated":[],"service_role":[]},"receiving_dispatch_operations":{"anon":[],"authenticated":[],"service_role":[]},"receiving_dispatch_transition_guards":{"anon":[],"authenticated":[],"service_role":[]},"sales_tax_location_rates":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"service_notes":{"anon":["SELECT"],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"staff_invoice_default_series":{"anon":[],"authenticated":[],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"staff_invoice_number_series":{"anon":[],"authenticated":[],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"staff_invoice_sources":{"anon":["SELECT"],"authenticated":["SELECT"],"service_role":["MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE"]},"staff_permission_grants":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"staff_work_order_notification_reads":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"staff_work_order_todos":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"state_sales_tax_rates":{"anon":[],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"stores":{"anon":[],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"tax_rate_import_batches":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"wo_parts":{"anon":["SELECT"],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"work_order_afm_contacts":{"anon":[],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"work_order_assignment_command_guards":{"anon":[],"authenticated":[],"service_role":[]},"work_order_assignment_control":{"anon":[],"authenticated":[],"service_role":[]},"work_order_assignment_history":{"anon":[],"authenticated":["SELECT"],"service_role":["SELECT"]},"work_order_assignment_operations":{"anon":[],"authenticated":[],"service_role":[]},"work_order_assignment_transition_guards":{"anon":[],"authenticated":[],"service_role":[]},"work_order_billing_operations":{"anon":[],"authenticated":[],"service_role":[]},"work_order_close_transition_guards":{"anon":[],"authenticated":[],"service_role":[]},"work_order_financials":{"anon":[],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"work_order_lifecycle_control":{"anon":[],"authenticated":[],"service_role":[]},"work_order_lifecycle_operations":{"anon":[],"authenticated":[],"service_role":[]},"work_order_lifecycle_transition_guards":{"anon":[],"authenticated":[],"service_role":[]},"work_order_priority_family_transition_guards":{"anon":[],"authenticated":[],"service_role":[]},"work_order_reopen_transition_guards":{"anon":[],"authenticated":[],"service_role":[]},"work_order_technician_assignments":{"anon":[],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"work_order_visit_correction_context":{"anon":[],"authenticated":[],"service_role":[]},"work_order_visit_corrections":{"anon":[],"authenticated":["SELECT"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"work_order_visits":{"anon":[],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]},"work_orders":{"anon":["SELECT"],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","UPDATE"]},"work_reports":{"anon":["SELECT"],"authenticated":["DELETE","INSERT","SELECT","UPDATE"],"service_role":["DELETE","INSERT","MAINTAIN","REFERENCES","SELECT","TRIGGER","TRUNCATE","UPDATE"]}}$p1_expected$::jsonb;
  v_functions jsonb := $p1_functions$["public.acknowledge_contractor_attention(uuid)","public.add_work_order_to_my_todos(text,text)","public.apply_email_work_order_priority_escalation(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone)","public.archive_assignment_financials()","public.assert_active_staff_profile(uuid)","public.assign_contractor_technician(text,uuid)","public.attach_contractor_estimate_file(uuid,text,text,text,bigint)","public.attach_contractor_invoice_pdf_company_scope_legacy(uuid,text)","public.attach_contractor_invoice_pdf(uuid,text)","public.audit_billing_tax_rule()","public.begin_quickbooks_oauth_authorization(uuid,text,text,text)","public.can_access_contractor_account(uuid)","public.can_access_contractor_work_order(text)","public.can_invoice_for_contractor(uuid)","public.can_manage_contractor_company()","public.can_manage_work_order_technician(text)","public.can_read_contractor_profile(uuid)","public.cancel_controller_invoice_export(uuid,uuid,text)","public.capture_work_order_financials()","public.claim_contractor_activity_alert_delivery(uuid,text,uuid)","public.claim_contractor_assignment_transition_delivery(uuid,uuid)","public.claim_email_assignment_removal_delivery(uuid)","public.claim_email_priority_escalation_delivery(uuid)","public.claim_financial_notification_deliveries_v1(integer,integer,uuid)","public.claim_p1_parts_alert_delivery(uuid,date,text)","public.claim_parts_sms_delivery_v1(uuid,boolean)","public.claim_parts_sms_status_v1(uuid)","public.claim_private_object_deletion_v1(uuid)","public.claim_private_object_upload_cleanup_v1(uuid)","public.claim_quickbooks_connection_disconnect(uuid,uuid,timestamp with time zone,uuid)","public.claim_receiving_dispatch_deliveries_v1(integer,integer,uuid)","public.classify_staff_billing_document()","public.clear_technician_on_contractor_change()","public.close_reopened_work_order_without_additional_billing(text,integer,integer,timestamp with time zone,text)","public.close_staff_todos_with_work_order()","public.close_work_order_without_invoice(text,integer,integer,timestamp with time zone)","public.complete_capital_work(text)","public.complete_contractor_activity_alert_delivery(uuid,text,text)","public.complete_contractor_assignment_transition_delivery(uuid,text,text)","public.complete_controller_invoice_export(uuid,uuid,text,uuid[])","public.complete_email_priority_escalation_delivery(uuid,text,text)","public.complete_financial_notification_delivery_v1(uuid,uuid,text,text,integer,text,integer)","public.complete_my_work_order_todo(text)","public.complete_p1_parts_alert_delivery(uuid,text,text,text)","public.complete_parts_sms_delivery_v1(uuid,uuid,text,text,text,text,integer)","public.complete_parts_sms_status_v1(uuid,uuid,text,text,text)","public.complete_private_object_deletion_v1(uuid,uuid,text)","public.complete_private_object_upload_cleanup_v1(uuid,uuid,text)","public.complete_receiving_dispatch_delivery_v1(uuid,uuid,text,text,integer,text)","public.configure_contractor_technician(uuid,uuid,uuid,text,text,text)","public.configure_p1_parts_alerts(uuid,boolean,text,time without time zone,jsonb)","public.confirm_controller_invoice_export(uuid,uuid)","public.consume_client_diagnostic_rate_limit_v1(uuid)","public.contractor_account_id_for_profile(uuid)","public.contractor_invoice_work_order_status(text)","public.contractor_invoicing_is_complete(text)","public.convert_contractor_estimate_to_invoice(uuid)","public.correct_contractor_invoice_total(uuid,numeric,text)","public.correct_work_order_visit(uuid,timestamp with time zone,timestamp with time zone,text)","public.count_contractor_invoices_v1(text,text,text)","public.count_staff_invoices_v1(text,text,text)","public.count_work_order_activities_v1(text)","public.count_work_order_photos_v1(text)","public.count_work_order_visits_v1(text)","public.count_work_orders_table_v1(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,text,uuid[],text,text,text,text,text,text,text,date,date,text)","public.count_work_orders_table_v2(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,text,uuid[],text,text,text,text,text,text,text,date,date,text)","public.count_work_orders_v1(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,text,uuid[])","public.create_email_work_order_with_assignment_v1(uuid,jsonb)","public.current_contractor_account_id()","public.deactivate_contractor_technician(uuid,uuid)","public.decline_capital_work_order(text,integer)","public.delete_invoice_admin_v1(uuid,uuid,text,bigint,uuid,integer,integer,text)","public.enforce_activity_channel_update()","public.enforce_contractor_invoice_identity()","public.enforce_controller_invoice_handoff()","public.enqueue_parts_sms_deliveries_v1(boolean)","public.evaluate_work_order_sla_v1(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)","public.fail_private_object_upload_v1(uuid,uuid,text)","public.finalize_private_object_upload_v1(uuid,uuid,jsonb)","public.finalize_quickbooks_connection_disconnect(uuid,uuid,uuid,text)","public.finish_contractor_invoicing(text)","public.finish_parts_sms_run_v1(uuid,jsonb,text)","public.get_contractor_workload_summary()","public.get_incident_reuse_warnings()","public.get_invoice_source_summaries_v1(uuid[])","public.get_invoice_summary_v1(uuid)","public.get_my_contractor_scope()","public.get_my_role()","public.get_portal_navigation_summary_v1()","public.get_portal_navigation_summary_v2()","public.get_portal_navigation_summary()","public.get_portal_work_order(text)","public.get_receiving_dispatch_message_v1(uuid,uuid)","public.get_verified_invoice_object_v1(uuid)","public.get_work_order_activity_summaries()","public.get_work_order_invoice_part_hints_v1(text,uuid[])","public.guard_contractor_bill_handoff_batch()","public.guard_contractor_bill_handoff_item()","public.guard_invoice_active_work_order()","public.guard_pending_contractor_bill_invoice()","public.guard_pending_contractor_bill_lines()","public.guard_terminal_work_order_activity_mutation()","public.guard_terminal_work_order_visit_mutation()","public.guard_work_order_archive_mutations()","public.handle_new_user()","public.has_staff_permission(text)","public.is_invoice_controller()","public.is_linked_contractor_technician(uuid,uuid)","public.is_staff()","public.list_billable_p1_parts(text,uuid)","public.list_contractor_invoices_page_pre_financial_version(text,text,text,text,integer,text,text)","public.list_contractor_invoices_page(text,text,text,text,integer,text,text)","public.list_contractor_invoices_rows_v1(text,text,text,text,integer,text,text)","public.list_contractor_invoices_rows_v2(text,text,text,text,integer,text,text)","public.list_invoice_lines_page_v1(uuid,integer,text,bigint)","public.list_p1_part_costs_for_work_order(text)","public.list_private_object_reconciliation_v1(integer,boolean)","public.list_staff_contractor_preview_invoices(uuid,text,text,integer,timestamp with time zone,uuid)","public.list_staff_contractor_preview_work_orders(uuid,text,text,integer,timestamp with time zone,text)","public.list_staff_invoices_page(text,text,text,text,integer,text,text)","public.list_staff_invoices_rows_v1(text,text,text,text,integer,text,text)","public.list_staff_invoices_rows_v2(text,text,text,text,integer,text,text)","public.list_work_order_activities_page(text,integer,text)","public.list_work_order_activities_rows_v1(text,integer,text)","public.list_work_order_photos_page(text,integer,text)","public.list_work_order_photos_rows_v1(text,integer,text)","public.list_work_order_visits_page(text,integer,text)","public.list_work_order_visits_rows_v1(text,integer,text)","public.list_work_orders_page(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[])","public.list_work_orders_rows_v1(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[])","public.list_work_orders_table_page(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[],text,text,text,text,text,text,text,date,date,text)","public.list_work_orders_table_rows_v1(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[],text,text,text,text,text,text,text,date,date,text)","public.list_work_orders_table_rows_v2(text,text,uuid,text,text,text,text,date,date,boolean,text,boolean,integer,text,text,uuid[],text,text,text,text,text,text,text,date,date,text)","public.mark_staff_invoice_billed(uuid,uuid)","public.mark_staff_invoice_ready(uuid,uuid)","public.mark_staff_work_order_read(text,timestamp with time zone)","public.move_work_order_straight_to_billing(text)","public.next_contractor_invoice_num()","public.next_staff_invoice_num(uuid)","public.normalize_billing_tax_rule()","public.normalize_sales_tax_location_rate()","public.peek_staff_invoice_num(uuid)","public.place_contractor_invoice_payment_hold(uuid,uuid,text)","public.portal_decode_cursor(text)","public.portal_encode_cursor(jsonb)","public.prepare_financial_notification_send_v1(uuid,uuid)","public.prepare_parts_sms_send_v1(uuid,uuid,boolean)","public.prepare_receiving_dispatch_send_v1(uuid,uuid)","public.preserve_operational_work_order_status()","public.prevent_direct_work_order_close()","public.prevent_direct_work_order_reopen()","public.prevent_invoice_on_closed_work_order()","public.profile_has_staff_permission(uuid,text)","public.protect_activity_7eleven_sync()","public.protect_activity_assignment_version()","public.protect_activity_contractor_attention()","public.protect_activity_staff_only()","public.protect_activity_workflow_cycle()","public.protect_authoritative_close_activity()","public.protect_contractor_invoice_review_lifecycle()","public.protect_contractor_invoice_soft_delete()","public.protect_invoice_line_billing_metadata()","public.protect_p1_part_procurement_fields()","public.protect_profile_security_fields()","public.protect_quickbooks_handoff_transition()","public.protect_staff_note_read_state()","public.protect_work_order_assignment_boundary()","public.protect_work_order_duplicate_provenance()","public.protect_work_order_priority_email_provenance()","public.protect_work_order_priority_escalation_activity()","public.protect_work_order_technician_assignment()","public.protect_work_order_visit()","public.protect_work_report_identity()","public.queue_contractor_assignment_transition_delivery()","public.queue_duplicate_reassignment_transition_delivery()","public.record_email_capital_pending_v1(text)","public.record_email_intake_result_v1(uuid,text,jsonb)","public.record_work_order_technician_assignment()","public.refresh_email_work_order_dispatch(text,text,text,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,jsonb,text)","public.reject_ineligible_quickbooks_handoff_item()","public.release_contractor_invoice_payment_hold(uuid,uuid,text)","public.release_quickbooks_connection_disconnect(uuid,uuid,uuid,text)","public.remove_contractor_estimate_file(uuid)","public.reopen_work_order(text,text,text)","public.request_p1_part_order(uuid)","public.reset_contractor_invoicing_on_invoice_change()","public.resolve_location_sales_tax_rate(text,text,text,text,text,date)","public.resume_capital_work(text)","public.retract_contractor_invoice_rejection(uuid)","public.retry_email_priority_escalation_delivery(uuid,text,integer)","public.review_contractor_invoice(uuid,text,text)","public.review_contractor_invoices(uuid[],text,text)","public.save_contractor_estimate(uuid,text,date,date,text,text,numeric,jsonb,boolean,timestamp with time zone)","public.save_quickbooks_connection(uuid,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,integer,text,text,timestamp with time zone)","public.save_staff_billing_invoice_v4(uuid,text,integer,integer,uuid,bigint,uuid,jsonb)","public.set_activity_contractor_attention(uuid,boolean)","public.set_p1_part_order_status_with_cost(uuid,text,numeric)","public.set_p1_part_order_status(uuid,text)","public.stage_contractor_bill_handoff(uuid,uuid,text,jsonb,text,bigint,text)","public.stage_controller_invoice_export(uuid,uuid,text,uuid[])","public.stamp_activity_actor_audit()","public.stamp_staff_invoice_tax_provenance()","public.start_parts_sms_run_v1(uuid,text)","public.start_receiving_dispatch_delivery_v1(uuid,uuid)","public.submit_contractor_invoice_once_company_scope_legacy(uuid,text,text,boolean,text,text,date,date,date,text,numeric,numeric,jsonb)","public.touch_invoice_after_line_change()","public.touch_updated_at()","public.transfer_work_order_todo(text,uuid)","public.validate_contractor_organization()","public.validate_contractor_technician_profile()","public.validate_staff_invoice_source()","public.validate_state_sales_tax_rate()","public.work_order_accepts_email_priority_escalation(wo_status,fsm_functional_status)","public.work_order_priority_rank(wo_priority)"]$p1_functions$::jsonb;
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
  v_role text;
  v_privilege text;
  v_name text;
  v_signature text;
  v_allowed boolean;
begin
  if current_setting('server_version_num')::integer<170000 then raise exception 'ACL audit requires PostgreSQL 17 or later'; end if;
  select array_agg(c.relname order by c.relname) into v_actual from (select c.oid,c.relowner,c.relname from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
      and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')) c;
  if v_actual is distinct from v_tables then raise exception 'ACL audit: unreviewed application table inventory'; end if;
  select relowner into strict v_owner from pg_catalog.pg_class where oid='public.work_orders'::regclass;
  if exists(select 1 from (select c.oid,c.relowner,c.relname from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
      and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')) c where c.relowner<>v_owner) then raise exception 'ACL audit: unreviewed application owner'; end if;
  foreach v_name in array v_tables loop
    foreach v_role in array array['anon','authenticated','service_role'] loop
      foreach v_privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
        v_allowed := (v_expected->v_name->v_role) ? v_privilege;
        if pg_catalog.has_table_privilege(v_role,format('public.%I',v_name),v_privilege) is distinct from v_allowed then
          raise exception 'ACL audit: unexpected table capability %.% % (expected %)',v_name,v_role,v_privilege,v_allowed;
        end if;
      end loop;
    end loop;
  end loop;
  -- PUBLIC is grantee OID 0; has_table_privilege('PUBLIC', ...) is not valid.
  if exists(select 1 from (select c.oid,c.relowner,c.relname from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
      and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')) c cross join lateral pg_catalog.aclexplode(coalesce(
    (select relacl from pg_catalog.pg_class where oid=c.oid),pg_catalog.acldefault('r',c.relowner))) a
    where a.grantee=0 and a.privilege_type in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN','INSERT','UPDATE','DELETE')) then
    raise exception 'ACL audit: PUBLIC restores a prohibited table capability';
  end if;
  foreach v_role in array array['anon','authenticated'] loop
    if pg_catalog.has_schema_privilege(v_role,'public','CREATE') or
      exists(select 1 from pg_catalog.pg_roles r where r.rolname=v_role and
        (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls)) or
      exists(select 1 from pg_catalog.pg_roles r where r.rolname<>v_role and
        (pg_catalog.pg_has_role(v_role,r.oid,'USAGE') or pg_catalog.pg_has_role(v_role,r.oid,'SET'))) then
      raise exception 'ACL audit: unexpected client schema/role authority %',v_role;
    end if;
  end loop;
  if exists(select 1 from pg_catalog.pg_namespace n cross join lateral pg_catalog.aclexplode(
    coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a where n.nspname='public' and a.grantee=0 and a.privilege_type='CREATE') then
    raise exception 'ACL audit: PUBLIC can create application schema objects';
  end if;
  if exists(select 1 from pg_catalog.pg_default_acl d
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    where d.defaclrole=v_owner and d.defaclobjtype='r'
      and d.defaclnamespace in (0,'public'::regnamespace::oid)
      and (a.grantee=0 or a.grantee in (select oid from pg_catalog.pg_roles where rolname in ('anon','authenticated')))
      and (a.privilege_type in ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
        or a.grantee=(select oid from pg_catalog.pg_roles where rolname='anon') and a.privilege_type in ('INSERT','UPDATE','DELETE'))) then
    raise exception 'ACL audit: prohibited future-table defaults remain';
  end if;
  for v_signature in select jsonb_array_elements_text(v_functions) loop
    if pg_catalog.to_regprocedure(v_signature) is null or not pg_catalog.has_function_privilege('service_role',pg_catalog.to_regprocedure(v_signature),'EXECUTE') then
      raise exception 'ACL audit: required authoritative/worker function access missing %',v_signature;
    end if;
  end loop;
end;
$p1_application_acl_audit$;
select 'PASS' as application_acl_0149;
rollback;
