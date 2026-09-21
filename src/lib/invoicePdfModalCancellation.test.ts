import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { InvoicePdfError } from "./pdf/invoicePdfBudget";
import type { ParsedInvoicePdf } from "./invoicePdfParserClient";
import { createUnsavedChangesHarness } from "./forms/test-support/unsavedChangesHarness";
import type { DiscardChangesDialogProps } from "../components/ui/DiscardChangesDialog";

type Element = { type: unknown; props: Record<string, unknown> };
function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return isElement(value) ? [value, ...elements(value.props.children)] : [];
}
function label(value: unknown): string {
  if (Array.isArray(value)) return value.map(label).join("");
  return isElement(value) ? label(value.props.children) : typeof value === "string" ? value : "";
}
const parsed: ParsedInvoicePdf = { total: 12, confidence: "high", matchedLabel: "total", invoiceNumber: "SYNTH-12",
  invoiceNumberConfidence: "high", matchedNumberLabel: "invoice", lines: [], lineConfidence: "none" };
function harness(draft: Record<string, unknown> | null = null) {
  const dismissal = createUnsavedChangesHarness();
  const filename = resolve("src/features/invoices/InvoiceCreateModal.tsx");
  const requireHere = createRequire(import.meta.url);
  const states: unknown[] = [], refs: { current: unknown }[] = [];
  const effects: { dependencies: readonly unknown[]; cleanup?: () => void }[] = [];
  const queuedEffects: (() => void)[] = [];
  const form: Record<string, unknown> = { lines: [], num: "", uploadOnly: false, uploadedTotal: "" };
  const formCalls: { field: string; value: unknown }[] = [];
  const resets: unknown[] = [];
  const parseCalls: { file: File; signal: AbortSignal; resolve(value: ParsedInvoicePdf): void; reject(error: unknown): void }[] = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, submitCount = 0, saveCount = 0;
  const reset = (value: unknown) => { resets.push(value); if (typeof value === "object" && value !== null) Object.assign(form, value); };
  const props: Record<string, unknown> = { modal: "createInvoice", woData: { id: "WOTSYNTH1", store: "100", contractorAssignmentVersion: 1, workflowCycle: 1 },
    currentUser: { id: "synthetic-user", name: "Synthetic" }, fmt: String, resumeDraft: draft, resetNewInv: () => undefined,
    setModal: (value: unknown) => { props.modal = value; },
    doSubmitInvoice: async () => { submitCount += 1; return false; }, doSaveDraftInvoice: async () => { saveCount += 1; return false; },
  };
  const exports: { default?: (props: Record<string, unknown>) => unknown } = {};
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, AbortController, crypto: globalThis.crypto, Date,
    require: (name: string): unknown => {
      if (name.endsWith("/forms/useUnsavedChangesGuard")) return { useUnsavedChangesGuard: dismissal.useGuard };
      if (name === "react/jsx-runtime") return { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
        jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }) };
      if (name === "react") return {
        useId: () => "synthetic-invoice-form",
        useMemo: (fn: () => unknown) => fn(),
        useState: (initial: unknown) => { const index = stateIndex++; if (!(index in states)) states[index] = initial;
          return [states[index], (value: unknown) => { states[index] = value; }]; },
        useRef: (initial: unknown) => { const index = refIndex++; return refs[index] ??= { current: initial }; },
        useEffect: (fn: () => void | (() => void), dependencies: readonly unknown[]) => {
          const index = effectIndex++; const old = effects[index];
          if (!old || old.dependencies.some((value, i) => !Object.is(value, dependencies[i]))) queuedEffects.push(() => {
            old?.cleanup?.(); const cleanup = fn(); effects[index] = { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined };
          });
        },
      };
      if (name === "react-hook-form") return {
        useForm: () => ({ control: {}, register: (field: string, options?: { onChange?: (event: unknown) => void }) => ({ name: field, onChange: options?.onChange }), formState: { errors: {} },
          watch: (field: string) => form[field], reset,
          setValue: (field: string, value: unknown) => { form[field] = value; formCalls.push({ field, value }); },
          handleSubmit: (fn: (data: unknown) => unknown) => () => fn(form),
        }),
        useFieldArray: () => ({ fields: Array.isArray(form.lines) ? form.lines : [], append: () => undefined, remove: () => undefined,
          replace: (lines: unknown) => { form.lines = lines; } }),
      };
      if (name === "@hookform/resolvers/zod") return { zodResolver: () => undefined };
      if (name.endsWith("/queries")) return { useWorkOrderPartsQuery: () => ({ data: [] }) };
      if (name.includes("/components/ui/")) return new Proxy({}, { get: (_target, key) => key });
      if (name.endsWith("/invoicePdfParserClient")) return { parseInvoicePdf: (file: File, options: { signal: AbortSignal }) =>
        new Promise<ParsedInvoicePdf>((resolve, reject) => { parseCalls.push({ file, signal: options.signal, resolve, reject }); }) };
      return requireHere(resolve(filename, "..", name));
    },
  }, { filename });
  assert.ok(exports.default); const component = exports.default;
  const render = () => { stateIndex = 0; refIndex = 0; effectIndex = 0; const tree = component(props);
    while (queuedEffects.length) queuedEffects.shift()?.(); return elements(tree); };
  const input = () => { const node = render().find(node => node.type === "input" && node.props.type === "file");
    assert.ok(node && typeof node.props.onChange === "function"); return node.props.onChange; };
  const click = (name: string) => { const node = render().find(node => node.type === "button" && label(node) === name);
    assert.ok(node && typeof node.props.onClick === "function"); return node.props.onClick(); };
  render();
  return { props, form, formCalls, resets, parseCalls, render, states, click,
    select: (file: File) => input()({ target: { files: [file], value: "synthetic" } }),
    discard: async () => {
      const dialog = render().find(node => node.type === "DiscardChangesDialog");
      assert.ok(dialog, "dirty close must ask before aborting or discarding");
      (dialog.props as DiscardChangesDialogProps).onDiscard();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    },
    unmount: () => { effects.forEach(effect => effect.cleanup?.()); dismissal.unmount(); },
    submitCount: () => submitCount, saveCount: () => saveCount,
  };
}
const file = (name: string) => new File(["%PDF-1.7\nsynthetic"], name, { type: "application/pdf" });

for (const save of [false, true]) {
  test(`${save ? "save" : "submit"} accepted after a same-invoice reopen cannot reset or close the new form`, async () => {
    const h = harness(); let finish: (value: boolean) => void = () => undefined;
    const promise = new Promise<boolean>(resolve => { finish = resolve; });
    h.props[save ? "doSaveDraftInvoice" : "doSubmitInvoice"] = () => promise;
    const form = h.render().find(node => node.type === "form"); assert.ok(form && typeof form.props.onSubmit === "function");
    const pending = save ? h.click("Save as draft") : form.props.onSubmit();
    h.props.modal = null; h.render();
    h.props.modal = "createInvoice"; h.render();
    h.form.num = "NEW-SYNTHETIC";
    const resets = h.resets.length;
    finish(true); await pending;
    assert.equal(h.props.modal, "createInvoice"); assert.equal(h.form.num, "NEW-SYNTHETIC");
    assert.equal(h.resets.length, resets);
    assert.equal(h.states[0], false); assert.equal(h.states[1], false);
    h.unmount();
  });
}
test("late number suggestion from the same invoice's previous open cannot populate its new form", async () => {
  const h = harness(); const finish: ((value: string) => void)[] = [];
  h.props.nextInvNumFromDb = () => new Promise<string>(resolve => finish.push(resolve));
  h.props.modal = null; h.render(); h.props.modal = "createInvoice"; h.render();
  h.props.modal = null; h.render(); h.props.modal = "createInvoice"; h.render();
  assert.equal(finish.length, 2);
  finish[0]("OLD"); await Promise.resolve(); await Promise.resolve(); assert.equal(h.form.num, "");
  finish[1]("CURRENT"); await Promise.resolve(); await Promise.resolve(); assert.equal(h.form.num, "CURRENT");
  h.unmount();
});

test("automatic focus does not suppress a late invoice number suggestion", async () => {
  const h = harness();
  let finish: (value: string) => void = () => undefined;
  h.props.nextInvNumFromDb = () => new Promise<string>(resolve => { finish = resolve; });
  h.props.modal = null;
  h.render();
  h.props.modal = "createInvoice";
  const input = h.render().find(node => node.type === "input" && node.props.placeholder === "e.g. 6557");
  assert.ok(input);
  assert.equal(input.props.onFocus, undefined);
  finish("6501");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.form.num, "6501");
  h.unmount();
});

test("editing the invoice number protects authored input from a late suggestion", async () => {
  const h = harness();
  let finish: (value: string) => void = () => undefined;
  h.props.nextInvNumFromDb = () => new Promise<string>(resolve => { finish = resolve; });
  h.props.modal = null;
  h.render();
  h.props.modal = "createInvoice";
  const input = h.render().find(node => node.type === "input" && node.props.placeholder === "e.g. 6557");
  assert.ok(input && typeof input.props.onChange === "function");
  input.props.onChange({ target: { value: "AUTHORED-1042" } });
  h.form.num = "AUTHORED-1042";
  finish("6501");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.form.num, "AUTHORED-1042");
  assert.equal(h.formCalls.some(call => call.field === "num" && call.value === "6501"), false);
  h.unmount();
});

test("invoice PDF modal cancels an earlier file and ignores its late extracted values", async () => {
  const h = harness(); const first = h.select(file("first.pdf")); const second = h.select(file("second.pdf"));
  assert.equal(h.parseCalls[0].signal.aborted, true); assert.equal(h.parseCalls[1].signal.aborted, false);
  h.parseCalls[0].resolve({ ...parsed, total: 99, invoiceNumber: "STALE" }); await first;
  assert.equal(h.form.uploadedTotal, "");
  h.parseCalls[1].resolve(parsed); await second;
  assert.equal(h.form.uploadedTotal, "12.00"); assert.equal(h.form.num, "SYNTH-12");
});

test("invoice PDF modal deduplicates an active selection and lets the contractor continue while reading", async () => {
  const h = harness(); const selected = file("same.pdf"); const first = h.select(selected); await h.select(selected);
  assert.equal(h.parseCalls.length, 1);
  const save = h.render().find(node => node.type === "button" && label(node) === "Save as draft");
  assert.ok(save && save.props.disabled === false && typeof save.props.onClick === "function");
  assert.ok(h.render().some(node => node.type === "button" && label(node) === "Stop reading and enter total manually"));
  await save.props.onClick();
  assert.equal(h.parseCalls[0].signal.aborted, true);
  assert.equal(h.saveCount(), 1);
  h.parseCalls[0].resolve(parsed); await first;

  const submitting = harness(); const submitRead = submitting.select(file("submit.pdf"));
  const form = submitting.render().find(node => node.type === "form");
  assert.ok(form && typeof form.props.onSubmit === "function");
  const submit = submitting.render().find(node => node.type === "button" && label(node) === "Submit");
  assert.ok(submit && submit.props.disabled === false);
  await form.props.onSubmit();
  assert.equal(submitting.parseCalls[0].signal.aborted, true);
  assert.equal(submitting.submitCount(), 1);
  submitting.parseCalls[0].resolve(parsed); await submitRead;
});

test("removal, close, unmount and actor/work-order changes abort pending parsing without stale updates", async () => {
  for (const action of ["remove", "close", "unmount", "actor", "work-order", "hidden"]) {
    const h = harness(); const pending = h.select(file("synthetic.pdf"));
    if (action === "remove") h.click("Remove attachment");
    else if (action === "close") {
      h.click("Cancel");
      assert.equal(h.parseCalls[0].signal.aborted, false, "request alone must preserve pending input");
      await h.discard();
    }
    else if (action === "unmount") h.unmount();
    else if (action === "actor") { h.props.currentUser = { id: "different-user" }; h.render(); }
    else if (action === "work-order") { h.props.woData = { id: "OTHERWO", store: "101" }; h.render(); }
    else { h.props.modal = null; h.render(); }
    assert.equal(h.parseCalls[0].signal.aborted, true, action);
    const count = h.formCalls.length; h.parseCalls[0].resolve(parsed); await pending;
    assert.equal(h.formCalls.length, count, action);
  }
});

test("PDF extraction limits, encryption and availability errors retain explicit manual-entry fallback", async () => {
  for (const code of ["PDF_PARSE_TIMEOUT", "PDF_TEXT_LIMIT", "PDF_ENCRYPTED_UNSUPPORTED", "PDF_PARSE_FAILED"] as const) {
    const h = harness(); const pending = h.select(file("synthetic.pdf"));
    h.parseCalls[0].reject(new InvoicePdfError(code)); await pending;
    assert.equal(h.form.uploadOnly, true); assert.equal(h.form.uploadedTotal, "");
    assert.ok(h.render().some(node => node.type === "button" && label(node) === "Remove attachment"));
    assert.match(h.render().map(label).join(" "), /Enter the invoice total manually/);
  }
});

test("invalid signature/malformed selection is not retained as a successful pending attachment", async () => {
  for (const code of ["PDF_INVALID_SIGNATURE", "PDF_MALFORMED"] as const) {
    const h = harness(); const pending = h.select(file("invalid.pdf"));
    h.parseCalls[0].reject(new InvoicePdfError(code)); await pending;
    assert.equal(h.form.uploadOnly, false);
    assert.equal(h.render().some(node => node.type === "button" && label(node) === "Remove attachment"), false);
    assert.match(h.render().map(label).join(" "), /Choose a valid PDF or enter the invoice manually/);
  }
});

test("invalid replacement preserves the existing draft's bound PDF and manual total", async () => {
  const h = harness({ id: "00000000-0000-4000-8000-000000000001", num: "OLD", state: "draft", invoiceVersion: 1,
    pdfStoragePath: "existing/bound.pdf", pdfIsOriginal: true, total: 45, lines: [] });
  const pending = h.select(file("invalid.pdf")); h.parseCalls[0].reject(new InvoicePdfError("PDF_INVALID_SIGNATURE")); await pending;
  assert.equal(h.form.uploadOnly, true); assert.equal(h.form.uploadedTotal, "45");
  assert.match(h.render().map(label).join(" "), /A PDF is already attached/);
});

test("the modal delegates content validation despite advisory non-PDF filename or MIME", async () => {
  const h = harness(); const selected = new File(["%PDF-1.7\nsynthetic"], "synthetic.txt", { type: "text/plain" });
  const pending = h.select(selected); assert.equal(h.parseCalls.length, 1);
  assert.equal(h.parseCalls[0].file, selected); h.parseCalls[0].resolve(parsed); await pending;
  assert.equal(h.form.uploadedTotal, "12.00");
});
