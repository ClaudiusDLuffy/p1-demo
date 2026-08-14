import assert from "node:assert/strict";
import test from "node:test";

import {
  hasStaffPermission,
  isInvoiceController,
  STAFF_PERMISSION,
} from "./staffPermissions";

test("staff capabilities are driven by grants, never an email", () => {
  const controller = { staffPermissions: [STAFF_PERMISSION.invoiceController] };
  const ordinaryStaff = { staffPermissions: [] };

  assert.equal(hasStaffPermission(controller, STAFF_PERMISSION.invoiceController), true);
  assert.equal(isInvoiceController(controller), true);
  assert.equal(isInvoiceController(ordinaryStaff), false);
  assert.equal(isInvoiceController(null), false);
});
