import assert from "node:assert/strict";
import test from "node:test";
import {
  MobileContractError, mapPublicError, parseActivityPage, parseMobileEnvironment,
  parseMobileProfile, parsePhotoPage,
  parseVisitPage, parseWorkOrderPage, workOrderReadArgs,
} from "./index";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const environment = {
  EXPO_PUBLIC_P1_APP_ENV: "preview",
  EXPO_PUBLIC_SUPABASE_URL: "https://project-one.supabase.co",
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_value",
  EXPO_PUBLIC_API_BASE_URL: "https://api.example.invalid",
  EXPO_PUBLIC_RELEASE_SHA: "abcdef1",
};

test("environment accepts only the five complete public values and binds the project", () => {
  const parsed = parseMobileEnvironment(environment);
  assert.equal(parsed.supabaseProjectRef, "project-one");
  assert.equal(Object.keys(parsed).length, 6);
});
test("environment rejects missing, malformed, partial, mismatched, and server-secret input", () => {
  for (const value of [
    { ...environment, EXPO_PUBLIC_API_BASE_URL: undefined },
    { ...environment, EXPO_PUBLIC_SUPABASE_URL: "http://project-one.supabase.co" },
    { ...environment, SUPABASE_SERVICE_ROLE_KEY: "synthetic" },
  ]) assert.throws(() => parseMobileEnvironment(value));
  assert.throws(() => parseMobileEnvironment(environment, "project-two"));
});
test("profile gates technician, company administrator, and unsupported roles", () => {
  const base = { id: id(1), role: "contractor", active: true, name: "Synthetic User", email: "user@example.invalid" };
  const scope = { contractorAccountId: id(2), organizationId: id(3), organizationName: "Synthetic Company",
    accessLevel: "report_only", canInvoice: false, canManageTeam: false };
  assert.equal(parseMobileProfile(base, scope, id(1)).capability, "technician");
  assert.equal(parseMobileProfile(base, { ...scope, accessLevel: "company_admin", canManageTeam: true }, id(1)).capability, "company_admin");
  assert.equal(parseMobileProfile({ ...base, role: "manager" }, {}, id(1)).capability, "unsupported");
});
test("profile fails closed for mismatch, inactive, malformed, and invoice-only scope", () => {
  const base = { id: id(1), role: "contractor", active: true, name: "Synthetic User", email: "user@example.invalid" };
  const scope = { contractorAccountId: id(2), organizationId: id(3), organizationName: "Synthetic Company",
    accessLevel: "invoice", canInvoice: true, canManageTeam: false };
  assert.throws(() => parseMobileProfile(base, scope, id(2)));
  assert.throws(() => parseMobileProfile({ ...base, active: false }, scope, id(1)));
  assert.equal(parseMobileProfile(base, scope, id(1)).capability, "unsupported");
});
test("work-order page retains internal identity, external WOT, bounds, cursor, and parts summary", () => {
  const page = parseWorkOrderPage({ items: [{ id: "WOT000001-2", duplicate_root_work_order_id: "WOT000001",
    status: "assigned", priority: "p2", parts_total: 3, parts_received: 1 }], nextCursor: "opaque",
    hasMore: true, totalCount: null });
  assert.equal(page.items[0]?.id, "WOT000001-2");
  assert.equal(page.items[0]?.externalWorkOrderId, "WOT000001");
  assert.equal(page.items[0]?.partsTotal, 3);
  assert.equal(workOrderReadArgs({ limit: 999, cursor: "opaque" }).p_limit, 100);
});
test("invalid cursor/result combinations fail closed", () => {
  assert.throws(() => parseWorkOrderPage({ items: [], nextCursor: null, hasMore: true }));
  assert.throws(() => parseWorkOrderPage({ items: [{ id: "x", status: "invented", priority: "p1" }], nextCursor: null, hasMore: false }));
});
const activity = (channel: "field_note" | "internal_note") => ({
  id: id(10), work_order_id: "WOT000001", author_id: id(1), author_name: "Synthetic",
  created_at: "2026-01-01T00:00:00Z", text: "Synthetic update", type: "note", activity_channel: channel,
  entered_by_role: "contractor", is_staff_override: false, is_staff_only: channel === "internal_note",
  override_for_contractor_id: null, event_key: "note", event_data: {}, requires_7eleven_sync: channel === "field_note",
  synced_to_7eleven_at: null, synced_to_7eleven_by: null, requires_contractor_attention: false,
  contractor_attention_acknowledged_at: null, contractor_attention_acknowledged_by: null,
  workflow_cycle: 1, contractor_assignment_version: 1, deleted_at: null,
});
test("activity validator preserves channels and exact parent", () => {
  assert.equal(parseActivityPage({ items: [activity("field_note")], nextCursor: null, hasMore: false }, "WOT000001").items[0]?.channel, "field_note");
  assert.throws(() => parseActivityPage({ items: [activity("internal_note")], nextCursor: null, hasMore: false }, "WOT000001"));
  assert.throws(() => parseActivityPage({ items: [activity("field_note")], nextCursor: null, hasMore: false }, "WOT000002"));
});
test("visit mapper validates exact parent and returns read-only timestamps", () => {
  const row = { id: id(20), work_order_id: "WOT000001", contractor_id: id(2), check_in_at: "2026-01-01T00:00:00Z",
    check_out_at: null, checked_in_by: id(1), checked_out_by: null, check_in_activity_id: id(21), check_out_activity_id: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closure_kind: null,
    duration_review_required: false, administrative_closed_at: null, administrative_closed_by: null,
    administrative_close_reason: null, administrative_transfer_operation_id: null };
  assert.equal(parseVisitPage({ items: [row], nextCursor: null, hasMore: false }, "WOT000001").items[0]?.checkOutAt, null);
  assert.throws(() => parseVisitPage({ items: [row], nextCursor: null, hasMore: false }, "WOT000002"));
});
test("photo metadata requires canonical work-order ownership", () => {
  const row = { id: id(30), work_order_id: "WOT000001", storage_path: "wo/WOT000001/photo.jpg",
    uploader_id: id(1), uploader_name: "Synthetic", caption: "Synthetic photo", created_at: "2026-01-01T00:00:00Z" };
  assert.equal(parsePhotoPage({ items: [row], nextCursor: null, hasMore: false }, "WOT000001").items[0]?.path, row.storage_path);
  assert.throws(() => parsePhotoPage({ items: [{ ...row, storage_path: "wo/WOT999999/photo.jpg" }],
    nextCursor: null, hasMore: false }, "WOT000001"));
});
test("public error mapping removes raw provider detail", () => {
  const error = mapPublicError({ code: "42501", message: "private SQL detail" });
  assert.equal(error.code, "forbidden");
  assert.doesNotMatch(error.message, /SQL/);
  assert.ok(error instanceof MobileContractError);
});
