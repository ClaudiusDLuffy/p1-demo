import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const shell = read("src/components/PortalShell.tsx");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const sourceDrawer = read("src/features/billing/SourceContractorInvoiceDrawer.tsx");
const nextConfig = read("next.config.ts");
const queueMigration = read("supabase/migrations/0093_work_order_queue_pinning.sql");
const billingMigration = read("supabase/migrations/0094_staff_billing_sorting.sql");

test("invoice and billing detours return to the originating work order", () => {
  assert.match(shell, /const rememberWorkOrderReturn = useCallback/);
  assert.match(shell, /const returnToWorkflowWorkOrder = useCallback/);
  assert.match(shell, /const openContractorInvoiceFromWorkOrder = useCallback/);
  assert.match(shell, /onClose=\{closeBillingInvoiceEditor\}/);
  assert.match(detail, /Back to previous view/);
  assert.match(detail, /Back to all work orders/);
});

test("source invoice drawer renders the authenticated original PDF and keeps structured data as fallback", () => {
  assert.match(sourceDrawer, /downloadInvoicePdfBlob\(storagePath\)/);
  assert.match(sourceDrawer, /URL\.createObjectURL/);
  assert.match(sourceDrawer, /Original contractor PDF/);
  assert.match(sourceDrawer, /<iframe/);
  assert.match(sourceDrawer, /No original PDF was attached/);
  assert.match(sourceDrawer, /pointerEvents: "none"/);
  assert.match(sourceDrawer, /role="complementary"/);
  assert.match(nextConfig, /frame-src 'self' blob:/);
  assert.match(nextConfig, /object-src 'none'/);
});

test("pending 7-Eleven work stays pinned across cursor pages and capital jobs leave P1 parts ordering", () => {
  assert.match(queueMigration, /_pending_rank/);
  assert.match(queueMigration, /'pendingRank', last_row\._pending_rank/);
  assert.match(queueMigration, /after_cursor\._pending_rank asc/);
  assert.match(
    queueMigration,
    /when 'dashboard_p1_parts_to_order'[\s\S]*'closed', 'capital', 'pending_capital_completion'/,
  );
  assert.match(queueMigration, /queued_part\.p1_order_status = 'requested'/);
});

test("global sorting covers work-order card pages, team dispatch, invoices, and billing", () => {
  assert.match(queueMigration, /when 'technician' then 'technician'/);
  assert.match(queueMigration, /when 'closed' then 'closed'/);
  assert.match(billingMigration, /when 'work_order' then 'work_order'/);
  assert.match(billingMigration, /when 'store' then 'store'/);
  assert.match(billingMigration, /when 'territory' then 'territory'/);
  assert.match(billingMigration, /when 'total' then 'total'/);
  for (const path of [
    "src/features/work-orders/MyJobs.tsx",
    "src/features/work-orders/HistoryView.tsx",
    "src/features/work-orders/CapitalProjects.tsx",
  ]) {
    assert.match(read(path), /WorkOrderSortControls/);
  }
  assert.match(read("src/features/contractors/SubDispatchView.tsx"), /aria-sort=/);
  assert.match(read("src/features/billing/BillingInvoiceList.tsx"), /aria-sort=/);
});
