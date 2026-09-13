import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the actual hook with controlled React/query/database ports. These
// are behavior characterizations, not a browser or database security test.
const filename = resolve("src/features/invoices/useInvoices.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requireHere = createRequire(import.meta.url);
type Action = (...args: unknown[]) => Promise<unknown>;
const invoiceId = "74000000-0000-4000-8000-000000000001";
const operationId = "74000000-0000-4000-8000-000000000002";
const workOrder = { id: "WOTTEST001", store: "100", addr: "Synthetic address", city: "Synthetic city",
  contractor: "74000000-0000-4000-8000-000000000003", contractorAssignmentVersion: 2, workflowCycle: 1 };
const draft = { num: "TEST-1", invoiceDate: "2026-09-08", serviceDate: "2026-09-08", terms: "Net 30",
  tax: "1.25", cme: "", hasExistingPdf: true, submissionKey: operationId, operationId,
  expectedAssignmentVersion: 2, expectedWorkflowCycle: 1, expectedInvoiceVersion: 3,
  commandContext: { workOrderId: workOrder.id, expectedAssignmentVersion: 2, expectedWorkflowCycle: 1,
    invoiceId: null, expectedInvoiceVersion: null, operationId },
  lines: [{ type: "Labor", desc: "Synthetic work", qty: 1.25, rate: 4.286 }] };
const forExisting = (existing: boolean) => ({ ...draft, commandContext: { ...draft.commandContext,
  invoiceId: existing ? invoiceId : null, expectedInvoiceVersion: existing ? 3 : null } });

function harness(failingName?: string, pdf?: { generate: (...args: unknown[]) => Blob }, directory?: {
  actor: Record<string, unknown>;
  selection: Record<string, unknown> | null;
}, documents?: {
  summary: Record<string, unknown>;
  complete?: Record<string, unknown>;
}, beforeResult?: () => void) {
  const messages: string[] = [];
  const invalidations: string[] = [];
  const stateChanges: unknown[] = [];
  const calls: { name: string; args: unknown[] }[] = [];
  const exactReads: unknown[][] = [];
  const documentReads: string[] = [];
  const keys = Object.fromEntries([
    "WORK_ORDERS_KEY", "WORK_ORDER_PAGES_KEY", "WORK_ORDER_BY_ID_KEY", "WORK_ORDER_DETAILS_KEY",
    "PORTAL_NAVIGATION_SUMMARY_KEY", "CONTRACTOR_WORKLOAD_SUMMARY_KEY", "INVOICES_KEY",
    "INVOICE_PAGES_KEY", "INVOICE_BY_ID_KEY", "CONTROLLER_INVOICE_HOLDS_KEY",
  ].map(key => [key, [key]]));
  const db = new Proxy({}, { get: (_target, name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    beforeResult?.();
    if (name === failingName) throw new Error("Synthetic failure");
    if (name === "loadInvoicesPage") return { items: [], hasMore: false, nextCursor: null };
    if (name === "uploadInvoicePdfObject") return `${invoiceId}/synthetic.pdf`;
    if (name === "downloadInvoicePdfBlob") return new Blob(["synthetic original"]);
    return { id: invoiceId, invoiceId, num: "TEST-1", invoiceNum: "TEST-1", subtotal: 5.36,
      salesTax: 1.25, total: 6.61, invoiceVersion: 4, applied: true, reason: "applied" };
  } });
  const exports: { default?: (props: Record<string, unknown>) => Record<string, Action> } = {};
  runInNewContext(compiled, { exports, console, Date, Promise, Map, Set, crypto: globalThis.crypto,
    require: (name: string): unknown => {
      if (name === "react") return {
        useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial,
          (next: unknown) => stateChanges.push(next)],
      };
      if (name === "@tanstack/react-query") return { useQueryClient: () => ({
        getQueryData: () => [], invalidateQueries: ({ queryKey }: { queryKey: string[] }) => {
          invalidations.push(queryKey[0]); return Promise.resolve();
        },
      }) };
      if (name.endsWith("/queries")) return keys;
      if (name.endsWith("/useInvoiceDocumentAction")) return { useInvoiceDocumentAction: () => Object.assign(async () => {
        documentReads.push("complete");
        if (documents?.complete) return documents.complete;
        throw new Error("Unexpected document hydration in legacy complete fixture");
      }, { assertCurrent: () => undefined, summary: async () => {
        documentReads.push("summary");
        if (documents) return documents.summary;
        throw new Error("Unexpected summary hydration in legacy complete fixture");
      } }) };
      if (name.endsWith("/db")) return db;
      if (name.endsWith("/directory/api")) return { loadDirectorySelection: async (...args: unknown[]) => {
        exactReads.push(args); return directory?.selection ?? null;
      } };
      if (name.endsWith("/invoicePdf") && pdf) return { generateInvoicePDFBlob: pdf.generate,
        invoiceFilename: () => "synthetic.pdf", triggerBlobDownload: () => undefined };
      if (name.endsWith("/supabase/client")) return { supabase: () => { throw new Error("Network forbidden"); } };
      return requireHere(resolve(filename, "..", name));
    },
  }, { filename });
  assert.ok(exports.default);
  const hook = exports.default({ currentUser: directory?.actor ?? { id: workOrder.contractor, name: "Synthetic Contractor", role: "contractor" },
    fire: (message: string) => messages.push(message) });
  return { hook, messages, invalidations, stateChanges, calls, exactReads, documentReads };
}

for (const existing of [false, true]) {
  test(`contractor draft ${existing ? "edit" : "creation"} preserves partial input and success feedback`, async () => {
    const h = harness();
    assert.equal(await h.hook.doSaveDraftInvoice(workOrder, { ...forExisting(existing), lines: [] }, existing ? invoiceId : null), true);
    assert.ok(h.messages.includes("Invoice #TEST-1 draft saved"));
    assert.ok(h.invalidations.includes("WORK_ORDER_DETAILS_KEY"));
    assert.ok(h.invalidations.includes("INVOICE_BY_ID_KEY"));
    assert.ok(h.calls.some(call => call.name === (existing ? "updateInvoiceWithLines" : "insertInvoice")));
    assert.equal(h.calls.length, 1, "The owning command creates draft activity atomically");
  });
  test(`contractor ${existing ? "existing draft" : "new"} submission preserves confirmation and refresh`, async () => {
    const h = harness();
    assert.equal(await h.hook.doSubmitInvoice(workOrder, forExisting(existing), existing ? invoiceId : null), true);
    assert.ok(h.stateChanges.includes("TEST-1"));
    assert.ok(h.invalidations.includes("WORK_ORDER_DETAILS_KEY"));
    assert.ok(h.invalidations.includes("INVOICE_BY_ID_KEY"));
    assert.equal(h.calls.length, 1, "No separate header, lines, parent status or activity mutation");
    const forwarded = h.calls[0].args[existing ? 1 : 0] as Record<string, unknown>;
    assert.deepEqual(forwarded.commandContext, forExisting(existing).commandContext);
    const lines = h.calls[0].args[existing ? 2 : 1] as { qty: number; rate: number }[];
    assert.equal(lines[0].qty, 1.25); assert.equal(lines[0].rate, 4.29);
  });
}

for (const action of ["doSaveDraftInvoice", "doSubmitInvoice"]) {
  test(`${action} preserves accepted command but suppresses old-scope UI, PDF and cache handoff`, async () => {
    let current = true;
    const h = harness(undefined, undefined, undefined, undefined, () => { current = false; });
    assert.equal(await h.hook[action](workOrder, { ...draft, pdfFile: { name: "synthetic.pdf", size: 20 } }, null, () => current), true);
    assert.equal(h.calls.length, 1, "no follow-up upload under a replacement identity");
    assert.equal(h.stateChanges.length, 0); assert.equal(h.invalidations.length, 0); assert.equal(h.messages.length, 0);
  });
  test(`${action} refuses an obsolete form callback before issuing a command`, async () => {
    const h = harness();
    assert.equal(await h.hook[action](workOrder, draft, null, () => false), false);
    assert.equal(h.calls.length, 0); assert.equal(h.stateChanges.length, 0);
  });
  test(`${action} does not report an old identity's command failure in the new session`, async () => {
    let current = true;
    const h = harness("insertInvoice", undefined, undefined, undefined, () => { current = false; });
    assert.equal(await h.hook[action](workOrder, draft, null, () => current), false);
    assert.equal(h.stateChanges.length, 0); assert.equal(h.invalidations.length, 0); assert.equal(h.messages.length, 0);
  });
}

test("manual PDF total remains valid without extracted line items or tax", async () => {
  const h = harness();
  assert.equal(await h.hook.doSubmitInvoice(workOrder, { ...draft, uploadOnly: true, uploadedTotal: "123.45", lines: [] }), true);
  const save = h.calls.find(call => call.name === "insertInvoice");
  assert.ok(save);
  assert.equal((save.args[0] as Record<string, unknown>).totalOverride, 123.45);
  assert.equal((save.args[0] as Record<string, unknown>).salesTax, 0);
  assert.equal((save.args[1] as unknown[]).length, 0);
});

test("manual PDF upload failure remains visible after committed invoice save", async () => {
  const h = harness("uploadInvoicePdf");
  assert.equal(await h.hook.doSubmitInvoice(workOrder, { ...draft, uploadOnly: true, uploadedTotal: "123.45",
    lines: [], pdfFile: { name: "synthetic.pdf", size: 20 } }), true);
  assert.ok(h.messages.some(message => message.startsWith("Invoice saved, but PDF upload failed:")));
});

test("rejected invoice correction preserves its record and uses the owning resubmission command", async () => {
  const h = harness();
  assert.equal(await h.hook.doSubmitInvoice(workOrder, { ...forExisting(true), resubmittingRejected: true, hasExistingOriginalPdf: true }, invoiceId), true);
  const resubmit = h.calls.find(call => call.name === "resubmitRejectedContractorInvoice");
  assert.equal(resubmit?.args[0], invoiceId);
  assert.ok(!h.calls.some(call => call.name === "insertInvoice"));
});

test("failed draft persistence reports failure and refreshes without claiming saved", async () => {
  const h = harness("updateInvoiceWithLines");
  assert.equal(await h.hook.doSaveDraftInvoice(workOrder, forExisting(true), invoiceId), false);
  assert.ok(h.messages.some(message => message.startsWith("Draft save failed:")));
  assert.ok(!h.messages.includes("Invoice #TEST-1 draft saved"));
  assert.ok(h.invalidations.includes("INVOICE_BY_ID_KEY"));
});

test("missing invoice number and missing PDF prevent writes", async () => {
  for (const value of [{ ...draft, num: "" }, { ...draft, uploadOnly: true, hasExistingPdf: false, uploadedTotal: "100" }]) {
    const h = harness();
    assert.equal(await h.hook.doSubmitInvoice(workOrder, value), false);
    assert.equal(h.calls.length, 0);
  }
});

test("own deletion preserves its guarded command and final-live-invoice warning", async () => {
  const h = harness();
  assert.equal(await h.hook.doDeleteInvoice({ id: invoiceId, num: "TEST-1", wot: workOrder.id, invoiceVersion: 3,
    contractorAssignmentVersion: 2, workflowCycle: 1 }), true);
  assert.equal(h.calls[0].name, "deleteOwnContractorInvoice");
  assert.ok(h.messages.some(message => message.includes("no live invoices left")));
});

test("unknown deletion result retains the original captured versions and operation for retry", async () => {
  const h = harness("deleteOwnContractorInvoice");
  const selected = { id: invoiceId, num: "TEST-1", wot: workOrder.id, invoiceVersion: 3,
    contractorAssignmentVersion: 2, workflowCycle: 1 };
  assert.equal(await h.hook.doDeleteInvoice(selected), false);
  assert.equal(await h.hook.doDeleteInvoice({ ...selected, invoiceVersion: 4 }), false);
  assert.deepEqual(h.calls[0].args, h.calls[1].args);
});

test("malformed tax and any malformed submitted row fail instead of silently dropping input", async () => {
  for (const input of [{ ...draft, tax: "5oops" }, { ...draft, lines: [...draft.lines, { type: "Labor", desc: "Invalid line", qty: -1, rate: 10 }] }]) {
    const h = harness();
    assert.equal(await h.hook.doSubmitInvoice(workOrder, input), false);
    assert.equal(h.calls.length, 0);
  }
});

test("generated download retries preserve the Blob, contractor branding and invoice version boundary", async () => {
  const generated: unknown[][] = [];
  const h = harness("uploadInvoicePdf", { generate: (...args) => {
    generated.push(args); return new Blob(["synthetic PDF"]);
  } });
  const invoice = { id: invoiceId, invoiceVersion: 4, num: "TEST-1", wot: workOrder.id, store: "100",
    invoiceDate: "2026-09-08", lines: [{ type: "Labor", desc: "Synthetic", qty: 1, rate: 10, amount: 10 }],
    subtotal: 10, salesTax: 1, total: 11, contractor: workOrder.contractor };
  await h.hook.doDownloadInvoice(invoice);
  await h.hook.doDownloadInvoice({ ...invoice });
  const uploads = h.calls.filter(call => call.name === "uploadInvoicePdf");
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].args[2], uploads[1].args[2]);
  assert.equal(generated.length, 1);
  assert.equal(generated[0][1], null);
  assert.deepEqual({ ...(generated[0][2] as Record<string, unknown>) }, {
    perspective: "contractor", fromName: "Synthetic Contractor", fromEmail: "", fromPhone: "",
  });
  await h.hook.doDownloadInvoice({ ...invoice, invoiceVersion: 5 });
  assert.equal(generated.length, 2);
  assert.notEqual(h.calls[2].args[2], uploads[0].args[2]);
  assert.ok(h.calls.every(call => call.name === "uploadInvoicePdf"));
});

test("rejected revision retries retain generated bytes under the same financial operation", async () => {
  let generations = 0;
  const h = harness("uploadInvoicePdfObject", { generate: () => new Blob([`synthetic-${++generations}`]) });
  const input = { ...forExisting(true), resubmittingRejected: true, hasExistingOriginalPdf: false };
  await h.hook.doSubmitInvoice(workOrder, input, invoiceId);
  await h.hook.doSubmitInvoice(workOrder, { ...input }, invoiceId);
  const uploads = h.calls.filter(call => call.name === "uploadInvoicePdfObject");
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].args[2], uploads[1].args[2]);
  assert.equal(generations, 1);
  assert.ok(h.calls.filter(call => call.name === "resubmitRejectedContractorInvoice")
    .every(call => (call.args[1] as Record<string, unknown>).commandContext === input.commandContext));
});

test("post-submit generated PDF retries retain bytes without changing invoice save arguments", async () => {
  let generations = 0;
  const h = harness("uploadInvoicePdf", { generate: () => new Blob([`synthetic-${++generations}`]) });
  const input = { ...forExisting(false), hasExistingPdf: false };
  await h.hook.doSubmitInvoice(workOrder, input);
  await h.hook.doSubmitInvoice(workOrder, { ...input });
  const uploads = h.calls.filter(call => call.name === "uploadInvoicePdf");
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].args[2], uploads[1].args[2]);
  assert.equal(generations, 1);
  const saves = h.calls.filter(call => call.name === "insertInvoice");
  assert.deepEqual(saves[0].args, saves[1].args);
});

test("staff generated invoice branding exact-loads its owner outside all directory pages", async () => {
  const generated: unknown[][] = [];
  const owner = { id: workOrder.contractor, name: "Synthetic owner", company: "Synthetic company",
    email: "owner@example.invalid", phone: "" };
  const h = harness(undefined, { generate: (...args) => {
    generated.push(args); return new Blob(["synthetic PDF"]);
  } }, { actor: { id: operationId, role: "manager", name: "Synthetic staff" }, selection: owner });
  await h.hook.doDownloadInvoice({ id: invoiceId, contractor: owner.id, invoiceVersion: 1, num: "TEST-1",
    lines: [{ type: "Labor", qty: 1, rate: 1, amount: 1 }], subtotal: 1, total: 1, salesTax: 0 });
  assert.deepEqual(h.exactReads, [["contact_detail", owner.id]]);
  assert.deepEqual({ ...(generated[0][2] as Record<string, unknown>) }, {
    perspective: "contractor", fromName: owner.company, fromEmail: owner.email, fromPhone: "",
  });
});

test("unavailable unrelated invoice owner never uses the viewer's company branding", async () => {
  const generated: unknown[][] = [];
  const h = harness(undefined, { generate: (...args) => {
    generated.push(args); return new Blob(["synthetic PDF"]);
  } }, { actor: { id: operationId, role: "contractor", contractorAccountId: operationId,
    company: "Unrelated synthetic viewer" }, selection: null });
  await h.hook.doDownloadInvoice({ id: invoiceId, contractor: workOrder.contractor, invoiceVersion: 1, num: "TEST-1",
    lines: [{ type: "Labor", qty: 1, rate: 1, amount: 1 }], subtotal: 1, total: 1, salesTax: 0 });
  assert.equal((generated[0][2] as Record<string, unknown>).fromName, "Contractor");
  assert.equal(h.exactReads.length, 1);
});

test("original uploaded invoice download does not load any directory or regenerate content", async () => {
  let generated = 0;
  const h = harness(undefined, { generate: () => { generated++; return new Blob(); } }, {
    actor: { id: operationId, role: "manager" }, selection: null,
  });
  await h.hook.doDownloadInvoice({ id: invoiceId, contractor: workOrder.contractor, num: "TEST-1",
    pdfStoragePath: `${invoiceId}/synthetic.pdf`, pdfIsOriginal: true, lines: [] });
  assert.equal(h.exactReads.length, 0);
  assert.equal(generated, 0);
  assert.equal(h.calls[0].name, "downloadInvoicePdfBlob");
  assert.ok(h.messages.includes("Invoice TEST-1 downloaded"));
});

test("a compact historical original PDF needs an exact header but no full line collection", async () => {
  let generated = 0;
  const summary = { projection: "summary", id: invoiceId, contractor: workOrder.contractor,
    num: "TEST-1", invoiceVersion: 0, lineCount: 1001, pdfIsOriginal: true,
    pdfStoragePath: `${invoiceId}/synthetic.pdf` };
  const h = harness(undefined, { generate: () => { generated++; return new Blob(); } }, undefined, { summary });
  await h.hook.doDownloadInvoice({ projection: "summary", id: invoiceId });
  assert.deepEqual(h.documentReads, ["summary"]);
  assert.equal(h.exactReads.length, 0);
  assert.equal(generated, 0);
  assert.equal(h.calls[0]?.name, "downloadInvoicePdfBlob");
  assert.ok(h.messages.includes("Invoice TEST-1 downloaded"));
});

test("a compact generated PDF hydrates the complete document instead of using visible lines", async () => {
  const summary = { projection: "summary", id: invoiceId, contractor: workOrder.contractor,
    num: "TEST-1", invoiceVersion: 1, lineCount: 2 };
  const lines = [{ type: "Labor", desc: "Synthetic A", qty: 1, rate: 1, amount: 1 },
    { type: "Labor", desc: "Synthetic B", qty: 1, rate: 1, amount: 1 }];
  let rendered: unknown;
  const h = harness(undefined, { generate: invoice => { rendered = invoice; return new Blob(); } }, undefined,
    { summary, complete: { ...summary, projection: "complete_document", lines, subtotal: 2, salesTax: 0, total: 2 } });
  await h.hook.doDownloadInvoice({ projection: "summary", id: invoiceId, lines: [lines[0]] });
  assert.deepEqual(h.documentReads, ["summary", "complete"]);
  assert.deepEqual((rendered as { lines: unknown[] }).lines, lines);
  assert.ok(h.messages.includes("Invoice TEST-1 downloaded"));
});
