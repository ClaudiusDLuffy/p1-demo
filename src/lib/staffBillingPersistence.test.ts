import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { generateStaffInvoicePDFBlob } from "./invoicePdf";
import { extractInvoiceDataFromPdf } from "./invoicePdfParser";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const migration = read(
  "supabase/migrations/0063_atomic_staff_billing_invoice_save.sql",
);
const route = read("src/app/api/billing-invoices/route.ts");
const shell = read("src/components/PortalShell.tsx");
const pdf = read("src/lib/invoicePdf.ts");

test("P1 invoice saves are one service-only database transaction", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.match(
    migration,
    /create or replace function public\.save_staff_billing_invoice/,
  );
  assert.match(migration, /language plpgsql\s+security definer/);
  assert.match(
    migration,
    /revoke all on function public\.save_staff_billing_invoice\([\s\S]+?from public, anon, authenticated;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.save_staff_billing_invoice\([\s\S]+?to service_role;/,
  );
});

test("the transaction reconciles persisted lines before replacing source links", () => {
  const headerInsert = migration.indexOf("insert into public.invoices");
  const lineDelete = migration.indexOf("delete from public.invoice_lines");
  const lineInsert = migration.indexOf("insert into public.invoice_lines");
  const lineReconciliation = migration.indexOf(
    "Saved invoice lines did not reconcile to the invoice subtotal",
  );
  const sourceDelete = migration.indexOf(
    "delete from public.staff_invoice_sources",
  );
  const auditInsert = migration.indexOf("insert into public.activities");

  assert.ok(headerInsert >= 0);
  assert.ok(lineDelete > headerInsert);
  assert.ok(lineInsert > lineDelete);
  assert.ok(lineReconciliation > lineInsert);
  assert.ok(sourceDelete > lineReconciliation);
  assert.ok(auditInsert > sourceDelete);
  assert.match(migration, /for update;/);
  assert.match(migration, /invoice_type = 'staff'/);
  assert.match(migration, /v_existing\.state not in \('draft', 'submitted'\)/);
});

test("the API delegates both creates and edits to the atomic save function", () => {
  assert.match(route, /async function saveStaffBillingInvoice/);
  assert.match(route, /\.rpc\(\s*"save_staff_billing_invoice"/);
  assert.equal(
    route.match(/await saveStaffBillingInvoice\(auth\.sb,/g)?.length,
    2,
  );
  assert.doesNotMatch(
    route,
    /\.from\("invoice_lines"\)\s*\.delete\(\)\s*\.eq\("invoice_id", id\)/,
  );
});

test("all global billing joins are explicitly paged past the PostgREST cap", () => {
  assert.match(route, /collectSupabasePages<any>[\s\S]+?\.from\("invoices"\)/);
  assert.match(route, /collectSupabasePages<any>[\s\S]+?\.from\("invoice_lines"\)/);
  assert.match(route, /collectSupabasePages<any>[\s\S]+?\.from\("staff_invoice_sources"\)/);
  assert.match(route, /\.order\("invoice_id", \{ ascending: true \}\)/);
  assert.match(route, /\.order\("position", \{ ascending: true \}\)/);
  assert.match(route, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(route, /\.range\(from, to\)/);
});

test("PDF and CSV exports reload and reconcile the exact invoice first", () => {
  assert.match(
    shell,
    /\/api\/billing-invoices\?invoiceId=\$\{encodeURIComponent\(invoice\.id\)\}/,
  );
  assert.match(shell, /assertStaffInvoiceIntegrity\(exportInvoice\)/);
  assert.equal(
    shell.match(/await loadBillingInvoiceForExport\(invoice\)/g)?.length,
    2,
  );
  assert.match(pdf, /body: inv\.lines\.map\(/);
});

test("the generated P1 PDF retains a persisted parts line", async () => {
  const blob = generateStaffInvoicePDFBlob({
    num: "P1-PARTS-TEST",
    wot: "WOT-PARTS-TEST",
    store: "12345",
    storeAddr: "1 Main St, Dallas, TX",
    invoiceDate: "08/14/2026",
    serviceDate: "08/14/2026",
    terms: "Net 30",
    cme: "",
    lines: [
      {
        type: "Labor",
        desc: "Completed repair",
        qty: 1,
        rate: 110,
        amount: 110,
      },
      {
        type: "Parts/Hardware",
        desc: "Replacement board",
        qty: 1,
        rate: 50,
        amount: 50,
      },
    ],
    subtotal: 160,
    salesTax: 0,
    total: 160,
  });
  const parsed = await extractInvoiceDataFromPdf(
    new Uint8Array(await blob.arrayBuffer()),
  );

  assert.equal(parsed.total, 160);
  assert.ok(
    parsed.lines.some(line =>
      line.type === "Parts/Hardware"
      && line.desc.includes("Replacement board")
      && line.amount === 50
    ),
  );
});
