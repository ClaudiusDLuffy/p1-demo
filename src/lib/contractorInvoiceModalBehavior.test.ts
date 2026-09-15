import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { CreateInvoiceLineSchema } from "./schemas";
import { createUnsavedChangesHarness } from "./forms/test-support/unsavedChangesHarness";

const filename = resolve("src/features/invoices/InvoiceCreateModal.tsx");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const requireHere = createRequire(import.meta.url);
type Element = { type: unknown; props: Record<string, unknown> };
function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!isElement(value)) return [];
  return [value, ...elements(value.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (isElement(value)) return text(value.props.children);
  return typeof value === "string" ? value : "";
}

function harness(submit: (...args: unknown[]) => Promise<boolean>, rejected = false, draftOverride: Record<string, unknown> | null = null) {
  const dismissal = createUnsavedChangesHarness();
  const states: { index: number; value: unknown }[] = [];
  const calls: { name: string; args: unknown[] }[] = [];
  const data = { num: "TEST-1", invoiceDate: "2026-09-08", serviceDate: "2026-09-08", terms: "Net 30",
    tax: "", cme: "", uploadOnly: false, uploadedTotal: "", lines: [] };
  let stateIndex = 0;
  const exports: { default?: (props: Record<string, unknown>) => unknown } = {};
  runInNewContext(compiled, { exports, Date, Promise, crypto: globalThis.crypto, console,
    require: (name: string): unknown => {
      if (name.endsWith("/forms/useUnsavedChangesGuard")) return { useUnsavedChangesGuard: dismissal.useGuard };
      if (name === "react/jsx-runtime") return {
        jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
        jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
      };
      if (name === "react") return {
        useId: () => "synthetic-invoice-form",
        useMemo: (fn: () => unknown) => fn(), useEffect: (fn: () => unknown) => { fn(); },
        useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => { const index = stateIndex++; return [initial, (value: unknown) => states.push({ index, value })]; },
      };
      if (name === "react-hook-form") return {
        useForm: () => ({ register: (field: string) => ({ name: field }),
          handleSubmit: (fn: (form: typeof data) => unknown) => () => fn(data), control: {},
          watch: (field: keyof typeof data) => data[field], reset: (value: unknown) => calls.push({ name: "reset", args: [value] }),
          setValue: () => undefined, formState: { errors: {} },
        }),
        useFieldArray: () => ({ fields: [], append: () => undefined, remove: () => undefined, replace: () => undefined }),
      };
      if (name === "@hookform/resolvers/zod") return { zodResolver: () => undefined };
      if (name.endsWith("/queries")) return { useWorkOrderPartsQuery: () => ({ data: [] }) };
      if (name.includes("/components/ui/")) return new Proxy({}, { get: (_target, key) => key });
      if (name.endsWith("/invoicePdfParserClient")) return { parseInvoicePdf: () => { throw new Error("PDF parsing is not called by these form controls"); } };
      return requireHere(resolve(filename, "..", name));
    },
  }, { filename });
  assert.ok(exports.default);
  const tree = exports.default({ modal: "createInvoice", woData: { id: "WOTTEST001", store: "100",
    contractorAssignmentVersion: 2, workflowCycle: 1 }, currentUser: { name: "Synthetic Contractor" }, fmt: String,
    resetNewInv: () => undefined, setModal: (value: unknown) => calls.push({ name: "setModal", args: [value] }),
    doSubmitInvoice: (...args: unknown[]) => { calls.push({ name: "submit", args }); return submit(...args); },
    doSaveDraftInvoice: (...args: unknown[]) => { calls.push({ name: "save", args }); return Promise.resolve(true); },
    doDownloadInvoice: (...args: unknown[]) => { calls.push({ name: "download", args }); },
    resumeDraft: draftOverride ?? (rejected ? { id: "74000000-0000-4000-8000-000000000001", state: "rejected", num: "TEST-1", invoiceVersion: 3 } : null),
  });
  return { tree, states, calls, nodes: elements(tree) };
}

test("invoice modal keeps outside-click dismissal disabled and submitting spinner lifecycle", async () => {
  const h = harness(async () => true);
  assert.ok(isElement(h.tree));
  assert.equal(h.tree.props.closeOnBackdrop, false);
  const form = h.nodes.find(node => node.type === "form");
  assert.ok(form && typeof form.props.onSubmit === "function");
  await form.props.onSubmit();
  assert.deepEqual(h.states.filter(state => state.index === 0).map(state => state.value), [false, true, false]);
  assert.equal(h.calls.filter(call => call.name === "submit").length, 1);
});
test("invoice editor rejects a compact summary rather than treating its missing lines as an empty draft", () => {
  const h = harness(async () => true, false, { id: "synthetic-invoice", projection: "summary", state: "draft", invoiceVersion: 0, lineCount: 1000 });
  assert.ok(h.nodes.some(node => node.props.role === "alert"));
  assert.ok(!h.nodes.some(node => node.type === "form"));
  assert.equal(h.calls.some(call => call.name === "submit" || call.name === "save"), false);
});

test("invoice modal prevents simultaneous submits and retains its operation key", async () => {
  let finish: (value: boolean) => void = () => undefined;
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  const h = harness(() => pending);
  const form = h.nodes.find(node => node.type === "form");
  assert.ok(form && typeof form.props.onSubmit === "function");
  const first = form.props.onSubmit();
  await form.props.onSubmit();
  assert.equal(h.calls.filter(call => call.name === "submit").length, 1);
  finish(false); await first;
  await form.props.onSubmit();
  const submitted = h.calls.filter(call => call.name === "submit");
  assert.equal(submitted.length, 2);
  const firstPayload = submitted[0].args[1] as Record<string, unknown>;
  const secondPayload = submitted[1].args[1] as Record<string, unknown>;
  assert.equal(firstPayload.submissionKey, secondPayload.submissionKey);
});

test("draft save bypasses full form validation and closes only after success", async () => {
  const h = harness(async () => true);
  const save = h.nodes.find(node => node.type === "button" && text(node).includes("Save as draft"));
  assert.ok(save && typeof save.props.onClick === "function");
  await save.props.onClick();
  assert.deepEqual(h.states.filter(state => state.index === 1).map(state => state.value), [false, true, false]);
  assert.equal(h.calls.filter(call => call.name === "save").length, 1);
  assert.deepEqual(h.calls.at(-1), { name: "setModal", args: [null] });
});

test("rejected correction retains its invoice number and offers safe correction recovery", () => {
  const h = harness(async () => true, true);
  assert.equal(h.nodes.find(node => node.type === "input" && node.props.name === "num")?.props.readOnly, true);
  assert.equal(h.nodes.some(node => node.type === "button" && text(node) === "Save correction draft"), true);
  assert.equal(h.nodes.some(node => node.type === "button" && /Save (?:as )?draft/.test(text(node))), false);
});

test("rejected correction exposes its current PDF without requiring resubmission", () => {
  const h = harness(async () => true, false, {
    id: "74000000-0000-4000-8000-000000000001", state: "rejected", num: "TEST-1", invoiceVersion: 3,
    pdfStoragePath: "synthetic/current.pdf", pdfIsOriginal: true,
  });
  const download = h.nodes.find(node => node.type === "button" && text(node) === "Download current PDF");
  assert.ok(download && typeof download.props.onClick === "function");
  download.props.onClick();
  assert.equal(h.calls.filter(call => call.name === "download").length, 1);
});

test("resuming a partial draft retains an explicit zero quantity and rate", () => {
  const h = harness(async () => true, false, {
    id: "74000000-0000-4000-8000-000000000001", state: "draft", num: "TEST-1", invoiceVersion: 3,
    lines: [{ type: "Labor", desc: "", qty: 0, rate: 0 }],
  });
  const reset = h.calls.find(call => call.name === "reset");
  assert.ok(reset);
  const hydrated = reset.args[0] as { lines: { qty: number; rate: number; desc: string }[] };
  assert.equal(hydrated.lines[0].qty, 0);
  assert.equal(hydrated.lines[0].rate, 0);
  assert.equal(hydrated.lines[0].desc, "");
});

test("blank rate remains invalid on submit while an explicit zero rate remains supported", () => {
  const line = { type: "Labor", desc: "Synthetic work", qty: 1 };
  const blank = CreateInvoiceLineSchema.safeParse({ ...line, rate: undefined });
  assert.equal(blank.success, false);
  if (!blank.success) assert.equal(blank.error.issues[0].message, "Enter a rate");
  assert.equal(CreateInvoiceLineSchema.safeParse({ ...line, rate: 0 }).success, true);
  assert.equal(CreateInvoiceLineSchema.safeParse({ ...line, rate: -1 }).success, false);
  assert.equal(CreateInvoiceLineSchema.safeParse({ ...line, rate: Number.NaN }).success, false);
});
