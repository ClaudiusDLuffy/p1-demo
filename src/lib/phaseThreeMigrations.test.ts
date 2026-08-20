import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const pagination = read(
  "supabase/migrations/0076_cursor_pagination_and_portal_indexes.sql",
);
const visitCorrections = read(
  "supabase/migrations/0077_audited_work_order_visit_corrections.sql",
);

test("interactive datasets use bounded RLS-aware keyset pages", () => {
  for (const functionName of [
    "list_work_orders_page",
    "list_work_order_activities_page",
    "list_work_order_photos_page",
    "list_work_order_visits_page",
    "list_contractor_invoices_page",
    "list_staff_invoices_page",
  ]) {
    const start = pagination.indexOf(`function public.${functionName}`);
    assert.ok(start >= 0, `${functionName} should exist`);
    const body = pagination.slice(start, pagination.indexOf("$$;", start) + 3);
    assert.match(body, /security invoker/i);
    assert.match(body, /least\(coalesce\(p_limit,[\s\S]*?100\)/i);
    assert.doesNotMatch(body, /\boffset\b/i);
    assert.match(body, /portal_decode_cursor/);
    assert.match(body, /portal_encode_cursor/);
  }
});

test("pagination keeps detail reads scoped and supports operational queues", () => {
  assert.match(pagination, /candidate_work_orders as materialized/i);
  for (const scope of [
    "staff_work",
    "staff_work_unread",
    "staff_work_todo",
    "staff_work_ready",
    "dashboard_unassigned",
    "dashboard_pending_submission",
    "dashboard_pending_approval",
    "dashboard_awaiting_parts",
    "dashboard_seven_eleven_updates",
    "dashboard_p1_parts_to_order",
    "dashboard_pending_capital_completion",
  ]) assert.match(pagination, new RegExp(`when '${scope}'`));
  assert.match(pagination, /join candidate_work_orders candidate/);
  assert.match(pagination, /where activity\.work_order_id = p_work_order_id/);
  assert.match(pagination, /where photo\.work_order_id = p_work_order_id/);
  assert.match(pagination, /where visit\.work_order_id = p_work_order_id/);
  assert.match(pagination, /p_store_number text default null/);
  assert.match(pagination, /p_contractor_ids uuid\[\] default null/);
  assert.match(pagination, /'staff_todo', staff_todo\.row_data/);
  assert.match(pagination, /'staff_read_through_at', staff_read\.read_through_at/);
});

test("shell summaries stay compact and RLS-aware", () => {
  for (const functionName of [
    "get_portal_navigation_summary",
    "get_contractor_workload_summary",
  ]) {
    const start = pagination.indexOf(`function public.${functionName}`);
    assert.ok(start >= 0, `${functionName} should exist`);
    const body = pagination.slice(start, pagination.indexOf("$$;", start) + 3);
    assert.match(body, /security invoker/i);
  }
  assert.match(pagination, /'staffUnreadCount'/);
  assert.match(pagination, /'readyToBillCount'/);
  assert.match(pagination, /'contractorInvoiceCount'/);
});

test("Phase 3 adds indexes for page cursors and database-side search", () => {
  for (const indexName of [
    "work_orders_active_created_cursor_idx",
    "work_orders_status_created_cursor_idx",
    "work_orders_contractor_created_cursor_idx",
    "activities_work_order_created_cursor_idx",
    "photos_work_order_created_cursor_idx",
    "work_order_visits_work_order_check_in_cursor_idx",
    "invoices_contractor_state_created_cursor_idx",
    "invoices_portal_search_trgm_idx",
    "invoice_lines_description_trgm_idx",
  ]) assert.match(pagination, new RegExp(`index if not exists ${indexName}`));
  assert.match(pagination, /create extension if not exists pg_trgm/);
  assert.match(pagination, /grant execute[\s\S]*?to authenticated, service_role/);
});

test("visit corrections are validated, audited, and cannot be written directly", () => {
  assert.match(visitCorrections, /create table if not exists public\.work_order_visit_corrections/);
  assert.match(visitCorrections, /revoke all on public\.work_order_visit_corrections from public, anon, authenticated/);
  assert.match(visitCorrections, /security definer[\s\S]*?function public\.correct_work_order_visit|function public\.correct_work_order_visit[\s\S]*?security definer/i);
  assert.match(visitCorrections, /correction reason of at least 5 characters/i);
  assert.match(visitCorrections, /corrections are limited to 24 hours/i);
  assert.match(visitCorrections, /locked after the P1 invoice is approved/i);
  assert.match(visitCorrections, /document_kind::text <> 'capital_quote'/i);
  assert.match(visitCorrections, /overlaps another visit for this technician/i);
  assert.match(visitCorrections, /event_key[\s\S]*?'visit_time_corrected'/i);
  assert.match(visitCorrections, /work_order_visit_correction_context/);
  assert.match(visitCorrections, /transaction_id = txid_current\(\)/);
  assert.doesNotMatch(visitCorrections, /set_config\('app\.visit_time_correction'/);
  assert.match(visitCorrections, /grant execute[\s\S]*?to authenticated, service_role/i);
});
