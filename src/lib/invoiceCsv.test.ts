import assert from "node:assert/strict";
import test from "node:test";
import {
  generateStaffInvoiceBatchCsv,
  generateStaffInvoiceCsv,
  staffInvoiceCsvFilename,
  staffInvoiceCsvRows,
} from "./invoiceCsv";

const HEADER = "Invoice Number,*Customer,Sub Customer,Terms,*Invoice Date,*Service Date,Due Date,Location,Shipping To,Store Number,Memo,Message on Invoice,Work Order #,*Product/Service,Description,Quantity,Rate,*Amount,Tax Rate,Equipment Tag,Class";

test("matches the supplied SaasAnt layout with one row per line item", () => {
  const csv = generateStaffInvoiceCsv({
    num: "P1-00013",
    wot: "WOT0898256",
    store: "33662",
    terms: "Net 30",
    invoiceDateRaw: "2026-07-28",
    serviceDateRaw: "2026-07-27",
    territory: "Texas",
    equipmentTag: "7-ELEVEN: HVAC",
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
      "P1-00013,7-Eleven Inc,7-ELEVEN STORE - 33662,Net 30,07/28/2026,07/27/2026,,Texas,,33662,,,WOT0898256,Travel,,1,110,110,,7-ELEVEN: HVAC,",
      "P1-00013,,,,,,,,,,,,,Labor,\"Arrived onsite,\nreplaced transformer.\",3,110,330,,,",
    ].join("\r\n"),
  );
});

test("maps taxable receivable lines to the SaasAnt tax-rate column", () => {
  const csv = generateStaffInvoiceCsv({
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
      "4347,7-Eleven Inc,7-ELEVEN STORE - 23995,Net 30,07/30/2026,07/29/2026,,Virginia,,23995,,,WOT0909771,Parts/Hardware,Replacement board,2,50,100,6%,,",
    ].join("\r\n"),
  );
});

test("billing CSV preserves Net 60 and the saved due date without rewriting older terms", () => {
  for (const terms of ["Net 60", "Net 30", "Net 15", "Due on receipt"]) {
    const invoice = {
      num: "SYNTH-100",
      terms,
      invoiceDateRaw: "2026-09-09",
      // Intentionally manual: export must not recalculate this from the terms.
      dueDateRaw: "2026-11-15",
      lines: [{ type: "Labor", description: "Synthetic repair", qty: 1, rate: 100 }],
    };
    const [row] = staffInvoiceCsvRows(invoice);
    assert.equal(row.terms, terms);
    assert.equal(row.dueDate, "11/15/2026");
    const cells = generateStaffInvoiceCsv(invoice).split("\r\n")[1].split(",");
    assert.equal(cells[3], terms);
    assert.equal(cells[6], "11/15/2026");
  }
});

test("does not silently replace missing invoice items with one total row", () => {
  assert.throws(
    () => generateStaffInvoiceCsv({
      num: "6502",
      wot: "WOT0908035",
      lines: [],
    }),
    /No invoice line items are available to export/,
  );
});

test("protects receivable CSV text with control-obscured formula prefixes", () => {
  const csv = generateStaffInvoiceCsv({
    num: "\u0000=2+2",
    store: "100",
    lines: [{ type: "Labor", description: "\u0000@unsafe", qty: 1, rate: 1 }],
  });

  assert.match(csv, /'\u0000=2\+2/);
  assert.match(csv, /'\u0000@unsafe/);
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
  assert.equal(rows[0].shippingTo, "");
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

test("outbound invoice exports use the canonical WOT for a reassignment copy", () => {
  const input = {
    num: "P1-00077",
    wot: "WOT1215047-2",
    lines: [{ type: "Labor", description: "Repair", qty: 1, rate: 100 }],
  };
  const [row] = staffInvoiceCsvRows(input);
  assert.equal(row.workOrderNumber, "WOT1215047");
  assert.equal(
    staffInvoiceCsvFilename(input),
    "Invoice-P1-00077-WOT1215047.csv",
  );
});

test("stored duplicate provenance takes precedence in accounting exports", () => {
  const input = {
    num: "P1-00078",
    wot: "WOT1215047-2",
    externalWorkOrderId: "WOT1215047",
    lines: [{ type: "Labor", description: "Repair", qty: 1, rate: 100 }],
  };
  const [row] = staffInvoiceCsvRows(input);
  assert.equal(row.workOrderNumber, "WOT1215047");
  assert.equal(
    staffInvoiceCsvFilename(input),
    "Invoice-P1-00078-WOT1215047.csv",
  );
});

test("a zero-dollar Warranty row is exported first without losing its label, amounts or invoice metadata", () => {
  const invoice = {
    num: "SYNTH-WARRANTY-1", terms: "Net 60", wot: "WOT-SYNTH-1", store: "100",
    taxRate: 0.07,
    lines: [
      { type: "Warranty", description: "Synthetic warranty repair", qty: 1, rate: 0, amount: 0, isTaxable: false },
      { type: "Labor", description: "Separate billable work", qty: 2, rate: 110, amount: 220, isTaxable: false },
    ],
  };
  const rows = staffInvoiceCsvRows(invoice);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.productService, row.quantity, row.rate, row.amount, row.taxRate]), [
    ["Warranty", 1, 0, 0, ""], ["Labor", 2, 110, 220, ""],
  ]);
  assert.equal(rows[0].customer, "7-Eleven Inc"); assert.equal(rows[0].terms, "Net 60");
  assert.equal(rows[1].customer, "");
  const csv = generateStaffInvoiceCsv(invoice).split("\r\n");
  assert.equal(csv.length, 3);
  assert.deepEqual(csv[1].split(",").slice(13, 19), ["Warranty", "Synthetic warranty repair", "1", "0", "0", ""]);
});

test("all-zero Warranty invoices remain complete CSV documents in individual and batch exports", () => {
  const invoice = { num: "SYNTH-WARRANTY-0", terms: "Net 60",
    lines: [{ type: "Warranty", description: "Synthetic no-charge visit", qty: 1, rate: 0, amount: 0, isTaxable: false }] };
  const [row] = staffInvoiceCsvRows(invoice);
  assert.deepEqual([row.productService, row.quantity, row.rate, row.amount], ["Warranty", 1, 0, 0]);
  const individual = generateStaffInvoiceCsv(invoice).split("\r\n");
  assert.equal(individual.length, 2); assert.equal(individual[0], HEADER);
  assert.deepEqual(individual[1].split(",").slice(13, 19), ["Warranty", "Synthetic no-charge visit", "1", "0", "0", ""]);
  const batch = generateStaffInvoiceBatchCsv([invoice, { ...invoice, num: "SYNTH-WARRANTY-SECOND" }]).split("\r\n");
  assert.equal(batch.length, 3);
  assert.equal(batch[1].split(",")[0], invoice.num);
  assert.equal(batch[2].split(",")[0], "SYNTH-WARRANTY-SECOND");
  assert.ok(batch.slice(1).every(line => line.split(",")[17] === "0"));
});

test("Warranty export preserves an explicitly saved positive rate rather than applying the UI's zero default", () => {
  const [row] = staffInvoiceCsvRows({ num: "SYNTH-WARRANTY-PAID", taxRate: 0.07,
    lines: [{ type: "Warranty", description: "Synthetic explicitly priced warranty work", qty: 2, rate: 25, amount: 50, isTaxable: true }] });
  assert.deepEqual([row.productService, row.quantity, row.rate, row.amount, row.taxRate], ["Warranty", 2, 25, 50, "7%"]);
});
