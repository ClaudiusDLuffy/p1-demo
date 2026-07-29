import assert from "node:assert/strict";
import test from "node:test";
import {
  generateInvoiceCsv,
  generateStaffInvoiceCsv,
  staffInvoiceCsvFilename,
  staffInvoiceCsvRows,
} from "./invoiceCsv";

test("exports the requested columns and normalizes Truck Charge to Travel", () => {
  const csv = generateStaffInvoiceCsv({
    num: "P1-00042",
    wot: "WOT0909771",
    salesTax: 8.25,
    lines: [
      {
        type: "Truck Charge",
        description: "Trip, \"north\"",
        qty: 1,
        rate: 25,
        amount: 25,
        isTaxable: false,
      },
      {
        type: "Materials",
        description: "Replacement board",
        qty: 2,
        rate: 50,
        amount: 100,
        isTaxable: true,
      },
    ],
  });

  assert.equal(
    csv,
    [
      "line item,description,qty,rate,amount,taxable,tax,total",
      "Travel,\"Trip, \"\"north\"\"\",1,25.00,25.00,No,0.00,25.00",
      "Parts/Hardware,Replacement board,2,50.00,100.00,Yes,8.25,108.25",
    ].join("\r\n"),
  );
});

test("preserves contractor line-item names on regular invoice exports", () => {
  const csv = generateInvoiceCsv({
    num: "6501",
    wot: "WOT0909771",
    lines: [
      {
        type: "Truck Charge",
        description: "Service travel",
        qty: 1,
        rate: 25,
      },
    ],
  });

  assert.equal(
    csv,
    [
      "line item,description,qty,rate,amount,taxable,tax,total",
      "Truck Charge,Service travel,1,25.00,25.00,No,0.00,25.00",
    ].join("\r\n"),
  );
});

test("does not silently replace missing invoice items with one total row", () => {
  assert.throws(
    () => generateInvoiceCsv({
      num: "6502",
      wot: "WOT0908035",
      salesTax: 12,
      lines: [],
    }),
    /No invoice line items are available to export/,
  );
});

test("does not silently replace missing Billing items with one total row", () => {
  assert.throws(
    () => generateStaffInvoiceCsv({
      num: "P1-00043",
      workOrderId: "WOT0908035",
      salesTax: 9,
      lines: [],
    }),
    /No invoice line items are available to export/,
  );
});

test("allocates invoice tax across taxable lines without changing the total", () => {
  const rows = staffInvoiceCsvRows({
    salesTax: 1,
    lines: [
      { type: "Parts", qty: 1, rate: 10, isTaxable: true },
      { type: "Parts", qty: 1, rate: 20, isTaxable: true },
      { type: "Labor", qty: 1, rate: 30, isTaxable: false },
    ],
  });

  assert.equal(
    rows.reduce((sum, row) => sum + row.tax, 0),
    1,
  );
  assert.equal(
    rows.reduce((sum, row) => sum + row.total, 0),
    61,
  );
});

test("keeps a manual invoice tax visible when no line is taxable", () => {
  const rows = staffInvoiceCsvRows({
    salesTax: 3.5,
    lines: [
      { type: "Labor", qty: 1, rate: 100, isTaxable: false },
    ],
  });

  assert.deepEqual(rows[1], {
    lineItem: "Sales Tax",
    description: "Invoice-level sales tax",
    qty: 1,
    rate: 0,
    amount: 0,
    taxable: false,
    tax: 3.5,
    total: 3.5,
  });
});

test("builds a stable CSV filename", () => {
  assert.equal(
    staffInvoiceCsvFilename({
      num: "P1/00042",
      workOrderId: "WOT 0909771",
    }),
    "Invoice-P1-00042-WOT-0909771.csv",
  );
});
