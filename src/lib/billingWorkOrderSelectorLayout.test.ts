import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const modal = readFileSync(
  resolve(process.cwd(), "src/features/billing/BillingInvoiceCreateModal.tsx"),
  "utf8",
);
const shell = readFileSync(
  resolve(process.cwd(), "src/components/PortalShell.tsx"),
  "utf8",
);

test("long work-order labels cannot collapse store and territory fields", () => {
  assert.match(modal, /billing-form-grid billing-work-order-grid/);
  assert.match(
    modal,
    /minmax\(0, 1fr\) minmax\(120px, 150px\) minmax\(160px, 190px\)/,
  );
  assert.match(modal, /className="billing-work-order-search" style=\{\{ minWidth: 0 \}\}/);
  assert.match(modal, /overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"/);
});

test("responsive billing layout gives work-order search its own full row", () => {
  assert.match(shell, /\.billing-work-order-grid > \* \{[\s\S]*?min-width: 0 !important;/);
  assert.match(shell, /\.billing-work-order-search \{[\s\S]*?grid-column: 1 \/ -1;/);
});
