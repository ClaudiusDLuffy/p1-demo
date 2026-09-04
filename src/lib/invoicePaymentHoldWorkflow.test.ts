import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/0100_contractor_invoice_payment_holds.sql");
const route = read("src/app/api/contractor-invoice-holds/route.ts");
const invoiceDetail = read("src/features/invoices/InvoiceDetail.tsx");
const controllerPanel = read("src/features/invoices/ControllerExportPanel.tsx");
const exportRoute = read("src/app/api/controller-exports/route.ts");

test("payment holds are complete, audited, and staff-only", () => {
  assert.match(migration, /create table if not exists public\.contractor_invoice_payment_holds/);
  assert.match(migration, /contractor_invoice_payment_hold_events/);
  assert.match(migration, /for select using \(public\.is_staff\(\)\)/);
  assert.match(migration, /revoke all on public\.contractor_invoice_payment_holds[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /revoke all on public\.contractor_invoice_payment_hold_events[\s\S]*from public, anon, authenticated/);
  assert.doesNotMatch(migration, /add column if not exists payment_hold_reason/);
  assert.match(migration, /drop column if exists payment_hold_reason/);
  assert.match(migration, /invoice_payment_hold_placed/);
  assert.match(migration, /invoice_payment_hold_released/);
});

test("any active staff member can place a reasoned hold but only accounting can release it", () => {
  const place = migration.match(/create or replace function public\.place_contractor_invoice_payment_hold[\s\S]*?\nend;\n\$\$;/)?.[0] || "";
  const release = migration.match(/create or replace function public\.release_contractor_invoice_payment_hold[\s\S]*?\nend;\n\$\$;/)?.[0] || "";
  assert.match(place, /profile\.role in \('manager', 'dispatcher', 'back_office'\)/);
  assert.match(place, /Only an approved invoice awaiting QuickBooks/);
  assert.match(place, /Automatically cancelled because invoice/);
  assert.match(release, /profile_has_staff_permission\(p_actor_id, 'quickbooks_handoff'\)/);
  assert.match(route, /requireStaffRequest\(request, \{ allowInvoiceController: true \}\)/);
  assert.match(route, /action === "release" && !canHandoffQuickBooksProfile/);
});

test("held invoices cannot be exported or confirmed", () => {
  assert.match(migration, /reject_ineligible_quickbooks_handoff_item/);
  assert.match(migration, /from public\.contractor_invoice_payment_holds hold/);
  assert.match(migration, /where hold\.invoice_id = invoice\.id/);
  assert.match(exportRoute, /async function heldInvoiceIds/);
  assert.match(exportRoute, /selected invoices are on payment hold/);
  assert.match(exportRoute, /Cancelled handoff archives cannot be re-downloaded/);
});

test("QuickBooks confirmation records sync without claiming contractor payment", () => {
  const confirm = migration.match(/create or replace function public\.confirm_controller_invoice_export[\s\S]*?\nend;\n\$\$;/)?.[0] || "";
  assert.match(confirm, /qbo_synced_at = now\(\)/);
  assert.match(confirm, /paid_at = null/);
  assert.doesNotMatch(confirm, /paid_at = now\(\)/);
});

test("the portal exposes an unmistakable hold action and accounting queue", () => {
  assert.match(invoiceDetail, /Hold \/ Do not pay/);
  assert.match(invoiceDetail, /Payment hold — do not export or pay/);
  assert.match(invoiceDetail, /canHandoffQuickBooks\(currentUser\)/);
  assert.match(controllerPanel, /Held — do not pay or include/);
  assert.match(controllerPanel, /contractor-invoice-holds/);
  assert.match(route, /sendInvoicePaymentHoldNotification/);
});
