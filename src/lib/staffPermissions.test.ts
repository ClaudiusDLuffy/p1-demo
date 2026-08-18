import assert from "node:assert/strict";
import test from "node:test";

import {
  canExportQuickBooks,
  hasStaffPermission,
  isInvoiceController,
  STAFF_PERMISSION,
} from "./staffPermissions";

test("QuickBooks export is additive and separate from controller-only scope", () => {
  const accountant = { staffPermissions: [STAFF_PERMISSION.quickBooksExport] };
  const restrictedController = {
    staffPermissions: [
      STAFF_PERMISSION.quickBooksExport,
      STAFF_PERMISSION.invoiceController,
    ],
  };
  const ordinaryStaff = { staffPermissions: [] };

  assert.equal(hasStaffPermission(accountant, STAFF_PERMISSION.quickBooksExport), true);
  assert.equal(canExportQuickBooks(accountant), true);
  assert.equal(isInvoiceController(accountant), false);
  assert.equal(canExportQuickBooks(restrictedController), true);
  assert.equal(isInvoiceController(restrictedController), true);
  assert.equal(canExportQuickBooks(ordinaryStaff), false);
  assert.equal(isInvoiceController(ordinaryStaff), false);
  assert.equal(canExportQuickBooks(null), false);
  assert.equal(isInvoiceController(null), false);
});
