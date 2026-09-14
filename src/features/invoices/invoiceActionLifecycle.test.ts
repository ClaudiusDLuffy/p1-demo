import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { DirectoryActor } from "../directory/contracts";
import type { CompleteInvoiceDocument } from "./invoiceReadContracts";
import type { useInvoiceDocumentAction } from "./useInvoiceDocumentAction";

const filename = resolve("src/features/invoices/useInvoiceDocumentAction.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requireHere = createRequire(import.meta.url);
const actor: DirectoryActor = { id: "synthetic-actor", role: "manager", active: true };
const document: CompleteInvoiceDocument = { projection: "complete_document", id: "synthetic-invoice", num: "TEST", state: "draft",
  subtotal: 1, salesTax: 0, total: 1, lineCount: 0, sourceCount: 0, invoiceVersion: 1, reviewRevision: 1,
  contractorAssignmentVersion: null, workflowCycle: null, lines: [] };
function harness() {
  const refs: { current: unknown }[] = [];
  let refIndex = 0;
  let effectIdentity: unknown;
  let cleanup: (() => void) | undefined;
  const pending: { signal: AbortSignal; finish(): void }[] = [];
  const read = (_id: string, _purpose: string, signal: AbortSignal) => new Promise<CompleteInvoiceDocument>(resolve => {
    pending.push({ signal, finish: () => resolve(document) });
  });
  const exports: { useInvoiceDocumentAction?: typeof useInvoiceDocumentAction } = {};
  runInNewContext(compiled, { exports, AbortController, Set, JSON, require: (name: string) => {
    if (name === "react") return { useRef: (initial: unknown) => {
      const index = refIndex++; return refs[index] ?? (refs[index] = { current: initial });
    }, useEffect: (effect: () => () => void, dependencies: unknown[]) => {
      if (effectIdentity !== dependencies[0]) { cleanup?.(); effectIdentity = dependencies[0]; cleanup = effect(); }
    } };
    if (name === "./invoiceReads") return { readInvoiceDocument: read,
      readInvoiceSummary: (id: string, signal: AbortSignal) => read(id, "summary", signal) };
    if (name === "../billing/billingReads") return { readBillingDocument: read,
      readBillingSourceSummaries: (_ids: readonly string[], signal: AbortSignal) => read("source", "source_import", signal) };
    return requireHere(resolve(filename, "..", name));
  } });
  assert.ok(exports.useInvoiceDocumentAction);
  return { pending, render: (value: DirectoryActor = actor, lifetime = "") => {
    refIndex = 0; return exports.useInvoiceDocumentAction!(value, lifetime);
  }, cleanup: () => cleanup?.() };
}
test("explicit financial hydration aborts old actor and rejects its late result", async () => {
  const h = harness(); const old = h.render(); const request = old(document.id, "edit");
  h.render({ ...actor, id: "other-actor" });
  assert.equal(h.pending[0].signal.aborted, true);
  h.pending[0].finish(); await assert.rejects(request);
  await assert.rejects(old(document.id, "edit"));
  assert.equal(h.pending.length, 1);
});
test("work-order/modal lifetime changes cancel explicit document hydration", async () => {
  const h = harness(); const request = h.render(actor, "WO-A:open")(document.id, "edit");
  h.render(actor, "WO-B:closed"); h.pending[0].finish(); await assert.rejects(request);
});
test("source-summary preflight shares modal lifetime and rejects late data after close", async () => {
  const h = harness(); const request = h.render(actor, "open").sourceSummaries([document.id]);
  h.render(actor, "closed"); assert.equal(h.pending[0].signal.aborted, true);
  h.pending[0].finish(); await assert.rejects(request);
});
test("original-PDF exact header action rejects a late response after an account switch", async () => {
  const h = harness(); const request = h.render().summary(document.id);
  h.render({ ...actor, id: "other-actor" });
  assert.equal(h.pending[0].signal.aborted, true);
  h.pending[0].finish(); await assert.rejects(request);
});
test("cleanup cancels in-flight hydration and blocks callbacks after unmount", async () => {
  const h = harness(); const read = h.render(); const request = read(document.id, "edit");
  h.cleanup(); h.pending[0].finish(); await assert.rejects(request);
  await assert.rejects(read(document.id, "edit")); assert.equal(h.pending.length, 1);
});
test("explicit document action has a four-request maximum", async () => {
  const h = harness(); const read = h.render(); const requests = Array.from({ length: 4 }, () => read(document.id, "edit"));
  await assert.rejects(read(document.id, "edit")); assert.equal(h.pending.length, 4);
  h.pending.forEach(request => request.finish()); await Promise.all(requests);
});
