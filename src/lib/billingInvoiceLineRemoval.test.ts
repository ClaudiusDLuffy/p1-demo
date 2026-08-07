import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const modal = readFileSync(
  resolve(process.cwd(), "src/features/billing/BillingInvoiceCreateModal.tsx"),
  "utf8",
);

test("staff billing lines keep an accessible delete action pinned inside the visible row", () => {
  assert.match(modal, /className="billing-line-remove"/);
  assert.match(modal, /onClick=\{\(\) => remove\(i\)\}/);
  assert.match(modal, /aria-label=\{`Delete line \$\{i \+ 1\}`\}/);
  assert.match(
    modal,
    /position: "absolute", top: 10, right: 10, width: 30, height: 34/,
  );
});

test("staff billing rows use flexible tracks and reserve room for the delete action", () => {
  assert.match(modal, /minmax\(86px, 110px\) minmax\(120px, 1fr\)/);
  assert.match(modal, /padding: "10px 48px 10px 12px"/);
});
