import assert from "node:assert/strict";
import test from "node:test";
import {
  generateInvoiceCsv,
  generateStaffInvoiceCsv,
  staffInvoiceCsvFilename,
  staffInvoiceCsvRows,
} from "./invoiceCsv";

const HEADER = "Invoice Number,*Customer,Sub Customer,Terms,*Invoice Date,*Service Date,Due Date,Location,Shipping To,Store Number,Memo,Message on Invoice,Work Order #,*Product/Service,Description,Quantity,Rate,*Amount,Tax Rate,Class";

test("matches the supplied SaasAnt layout with one row per line item", () => {
  const csv = generateStaffInvoiceCsv({
    num: "P1-00013",
    wot: "WOT0898256",
    store: "33662",
    terms: "Net 30",
    invoiceDateRaw: "2026-07-28",
    serviceDateRaw: "2026-07-27",
    territory: "Texas",
    lines: [
      {
        type: "Truck Charge",
        description: "",
        qty: 1,
        rate: 110,
      },
      {
        type: "Labor",
        description: "Arrived onsite,\nreplaced transformer.",
        qty: 3,
        rate: 110,
      },
    ],
  });

  assert.equal(
    csv,
    [
      HEADER,
      "P1-00013,7-Eleven Inc,7-ELEVEN STORE - 33662,Net 30,7/28/2026,7/27/2026,,Texas,7-ELEVEN STORE - 33662,33662,,,WOT0898256,Travel,,1,110,110,,",
      "P1-00013,,,,,,,,,,,,,Labor,\"Arrived onsite,\nreplaced transformer.\",3,110,330,,",
    ].join("\r\n"),
  );
});

test("uses the same SaasAnt format for contractor invoice downloads", () => {
  const csv = generateInvoiceCsv({
    num: "4347",
    wot: "WOT0909771",
    store: "23995",
    invoiceDate: "07/30/2026",
    serviceDate: "07/29/2026",
    taxState: "VA",
    taxRate: 0.06,
    lines: [
      {
        type: "Parts",
        description: "Replacement board",
        qty: 2,
        rate: 50,
        isTaxable: true,
      },
    ],
  });

  assert.equal(
    csv,
    [
      HEADER,
      "4347,7-Eleven Inc,7-ELEVEN STORE - 23995,Net 30,7/30/2026,7/29/2026,,Virginia,7-ELEVEN STORE - 23995,23995,,,WOT0909771,Parts/Hardware,Replacement board,2,50,100,6%,",
    ].join("\r\n"),
  );
});

test("does not silently replace missing invoice items with one total row", () => {
  assert.throws(
    () => generateInvoiceCsv({
      num: "6502",
      wot: "WOT0908035",
      lines: [],
    }),
    /No invoice line items are available to export/,
  );
});

test("exposes first-row metadata and normalized product names", () => {
  const rows = staffInvoiceCsvRows({
    num: "P1-L-1000",
    storeNumber: "100",
    lines: [
      { type: "Truck Charge", qty: 1, rate: 110 },
      { type: "OT Labor", qty: 0.5, rate: 165 },
    ],
  });

  assert.equal(rows[0].customer, "7-Eleven Inc");
  assert.equal(rows[0].productService, "Travel");
  assert.equal(rows[1].customer, "");
  assert.equal(rows[1].productService, "OT Labor");
  assert.equal(rows[1].quantity, 0.5);
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
