import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const billingList = read("src/features/billing/BillingInvoiceList.tsx");
const billingModal = read("src/features/billing/BillingInvoiceCreateModal.tsx");
const workOrderDetail = read("src/features/work-orders/WorkOrderDetail.tsx");
const workOrderHook = read("src/features/work-orders/useWorkOrders.ts");
const portalShell = read("src/components/PortalShell.tsx");
const db = read("src/lib/db.ts");

test("ready-to-bill rows are behind an accessible collapsed section", () => {
  assert.match(billingList, /useState\(false\)/);
  assert.match(billingList, /aria-expanded=\{readyToBillExpanded\}/);
  assert.match(billingList, /aria-controls="billing-ready-work-orders"/);
  assert.match(billingList, /readyToBillExpanded &&/);
});

test("staff can toggle every billing line taxable from the header", () => {
  assert.match(billingModal, /aria-label="Set all line items taxable"/);
  assert.match(billingModal, /fields\.forEach/);
  assert.match(billingModal, /selectAllTaxableRef\.current\.indeterminate/);
});

test("approve-and-bill waits for server approval before opening Billing", () => {
  assert.match(workOrderDetail, /Approve &amp; go to Billing/);
  assert.match(portalShell, /const approved = await doApproveInvoice\(invoice\.id\)/);
  assert.match(portalShell, /if \(!approved\) return false/);
  assert.match(portalShell, /setBillingSourceToStart\(invoice\.id\)/);
  assert.match(workOrderHook, /return Boolean\(ok\)/);
});

test("photo history is paged and successful uploads reconcile into the gallery", () => {
  assert.match(
    db,
    /collectSupabasePages<any>\(\(from, to\) => sb\.from\("photos"\)[\s\S]*?\.range\(from, to\)\)/,
  );
  assert.match(workOrderHook, /photos: \[\.\.\.\(w\.photos \|\| \[\]\), \.\.\.paths\]/);
  assert.match(workOrderHook, /invalidateBoth\(\)/);
});
