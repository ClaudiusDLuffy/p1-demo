import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { jsPDF } from "jspdf";
import { buildInvoicePdfRuntime } from "./invoice-pdf-runtime-build.mjs";
import { InvoicePdfError } from "../src/lib/pdf/invoicePdfBudget";
import { invoicePdfProcessState, runInvoicePdfProcess } from "../src/lib/pdf/invoicePdfProcess";

// Synthetic measurements only. No environment, disk PDF, server or customer
// content is read. Child peak RSS includes its own decoder, not tsx/jsPDF here.
buildInvoicePdfRuntime();

function invoice(pages: number, entries = 4, textLength = 20): Uint8Array {
  const document = new jsPDF({ compress: true });
  for (let page = 0; page < pages; page += 1) {
    if (page > 0) document.addPage();
    document.setFontSize(textLength > 100 ? 0.01 : 1);
    for (let entry = 0; entry < entries; entry += 1) {
      document.text("x".repeat(textLength), 20 + Math.floor(entry / 1_000) * 20,
        20 + (entry % 1_000) * 0.2);
    }
  }
  return new Uint8Array(document.output("arraybuffer"));
}

function typicalInvoice(pages: number): Uint8Array {
  const document = new jsPDF({ compress: true });
  for (let page = 0; page < pages; page += 1) {
    if (page > 0) document.addPage();
    document.text("Invoice Number SYNTH-MEASURE-1", 20, 20);
    for (const [text, x] of [["Description", 20], ["Qty", 100], ["Rate", 125], ["Amount", 160]] as const) document.text(text, x, 40);
    for (let line = 0; line < 8; line += 1) {
      const y = 50 + line * 10;
      for (const [text, x] of [["Labor service", 20], ["2", 100], ["80.00", 125], ["160.00", 160]] as const) document.text(text, x, y);
    }
    if (page === pages - 1) {
      document.text(`Subtotal ${(pages * 1280).toFixed(2)}`, 125, 145);
      document.text("Sales Tax 10.50", 125, 155);
      document.text(`Total Due ${(pages * 1280 + 10.5).toFixed(2)}`, 125, 165);
    }
  }
  return new Uint8Array(document.output("arraybuffer"));
}

async function verify(): Promise<void> {
  const samples: unknown[] = [];
  for (const [category, bytes] of [
    ["typical_one_page", typicalInvoice(1)],
    ["typical_five_pages", typicalInvoice(5)],
    ["maximum_25_pages", typicalInvoice(25)],
    ["near_items_per_page", invoice(1, 9_900, 1)],
    ["near_total_items", invoice(25, 1_990, 1)],
    ["near_total_text", invoice(25, 10, 970)],
  ] as const) {
    const started = performance.now();
    const result = await runInvoicePdfProcess(bytes);
    samples.push({ category, fileBytes: bytes.byteLength, wallMs: Math.round(performance.now() - started), ...result.metrics });
    assert.equal(invoicePdfProcessState().active, 0);
  }
  for (let index = 0; index < 8; index += 1) {
    const bytes = typicalInvoice(1);
    const started = performance.now();
    const result = await runInvoicePdfProcess(bytes);
    samples.push({ category: `sequential_${index + 1}`, fileBytes: bytes.byteLength,
      wallMs: Math.round(performance.now() - started), ...result.metrics });
  }
  const encrypted = new jsPDF({ encryption: { userPassword: "synthetic", ownerPassword: "synthetic-owner" } });
  encrypted.text("Synthetic protected document", 20, 20);
  for (const [category, bytes, expected] of [
    ["page_limit", invoice(26, 1), "PDF_PAGE_LIMIT"],
    ["text_limit", invoice(25, 10, 1_100), "PDF_TEXT_LIMIT"],
    ["malformed", new TextEncoder().encode("%PDF-1.7\ninvalid structure\n"), "PDF_MALFORMED"],
    ["encrypted", new Uint8Array(encrypted.output("arraybuffer")), "PDF_ENCRYPTED_UNSUPPORTED"],
  ] as const) {
    const started = performance.now();
    await assert.rejects(runInvoicePdfProcess(bytes), (error: unknown) => error instanceof InvoicePdfError && error.code === expected);
    samples.push({ category, fileBytes: bytes.byteLength, wallMs: Math.round(performance.now() - started), code: expected,
      cleanup: "process_closed" });
  }
  const slowBytes = typicalInvoice(1);
  const slowStarted = performance.now();
  await assert.rejects(runInvoicePdfProcess(slowBytes, { timeoutMs: 500,
    spawnChild: () => spawn(process.execPath, ["-e", "process.stdin.resume(); while (true) {}"], {
      stdio: ["pipe", "pipe", "pipe"], env: { NODE_ENV: "test" },
    }),
  }), (error: unknown) => error instanceof InvoicePdfError && error.code === "PDF_PARSE_TIMEOUT");
  samples.push({ category: "nonpreemptible_fake_provider", fileBytes: slowBytes.byteLength,
    wallMs: Math.round(performance.now() - slowStarted), code: "PDF_PARSE_TIMEOUT", cleanup: "process_closed" });
  const pending = runInvoicePdfProcess(invoice(25, 40));
  await assert.rejects(runInvoicePdfProcess(invoice(1)), (error: unknown) => error instanceof InvoicePdfError && error.code === "PDF_PARSE_BUSY");
  await pending;
  assert.equal(invoicePdfProcessState().active, 0);
  assert.equal(invoicePdfProcessState().started, invoicePdfProcessState().closed);
  console.log(JSON.stringify({ samples, processState: invoicePdfProcessState(),
    interpretation: "Local synthetic samples, not hosted latency or memory guarantees. One admitted process; parallel excess rejected without a queue." }, null, 2));
}

void verify().catch(error => {
  console.error(error instanceof InvoicePdfError ? error.code : "PDF_SECURITY_VERIFICATION_FAILED");
  process.exitCode = 1;
});
