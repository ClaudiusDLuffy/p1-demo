import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createDraftSession, type DraftStorage } from "./draftSession";
import { createUnsavedChangesHarness } from "../forms/test-support/unsavedChangesHarness";
type Element = { type: unknown; props: Record<string, unknown> };
const nodes = (value: unknown): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value && typeof value === "object" && "props" in value && "type" in value ? [value as Element, ...nodes((value as Element).props.children)] : [];
const file = resolve("src/features/work-orders/QuoteCalculatorWorkspace.tsx");
const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const requireHere = createRequire(import.meta.url);
const user = "00000000-0000-4000-8000-000000000001";
function harness(seed?: ReadonlyMap<string, string>, assignmentVersion = 2,
  onConvert?: (payload: Record<string, unknown>, isCurrent?: () => boolean, onAccepted?: () => void) => Promise<unknown>) {
  const values = new Map<string, string>(seed); let serial = 0, fail = false;
  const storage: DraftStorage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (fail) throw new Error("synthetic"); values.set(key, value); },
    removeItem: key => { if (fail) throw new Error("synthetic"); values.delete(key); } };
  const session = createDraftSession({ storage, environment: "test", project: "synthetic", random: () => `id-${++serial}` }); session.activate(user, true);
  const states: unknown[] = [], refs: { current: unknown }[] = [];
  const effects: { dependencies?: readonly unknown[]; cleanup?: () => void }[] = [];
  const memos: { value: unknown; dependencies?: readonly unknown[] }[] = [];
  let si = 0, ri = 0, ei = 0, mi = 0, gi = 0, changed = false;
  const queue: (() => void)[] = [], guards = [createUnsavedChangesHarness(), createUnsavedChangesHarness()];
  const different = (a?: readonly unknown[], b?: readonly unknown[]) => !a || !b || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));
  const memo = (fn: () => unknown, dependencies?: readonly unknown[]) => {
    const index = mi++, previous = memos[index];
    if (!previous || different(previous.dependencies, dependencies)) memos[index] = { value: fn(), dependencies };
    return memos[index].value;
  };
  const exports: { default?: (props: unknown) => unknown } = {};
  const messages: string[] = [];
  runInNewContext(compiled, { exports, crypto: globalThis.crypto, Date, console, window: {
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; }, cancelAnimationFrame: () => undefined,
    matchMedia: () => ({ matches: false }),
  }, require: (name: string): unknown => {
    if (name === "react/jsx-runtime") return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) };
    if (name === "react") return {
      useState: (initial: unknown) => { const index = si++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (next: unknown) => { const value = typeof next === "function" ? next(states[index]) : next;
          if (!Object.is(value, states[index])) { states[index] = value; changed = true; } }]; },
      useRef: (current: unknown) => refs[ri++] ??= { current }, useMemo: memo,
      useCallback: (fn: unknown, deps: readonly unknown[]) => memo(() => fn, deps),
      useEffect: (fn: () => void | (() => void), dependencies?: readonly unknown[]) => { const index = ei++, previous = effects[index];
        if (!previous || different(previous.dependencies, dependencies)) queue.push(() => { previous?.cleanup?.(); const cleanup = fn();
          effects[index] = { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined }; }); },
    };
    if (name.endsWith("/forms/useUnsavedChangesGuard")) return { useUnsavedChangesGuard: (options: Parameters<typeof guards[0]["useGuard"]>[0]) => guards[gi++].useGuard(options) };
    if (name.endsWith("/drafts/browserDraftSession")) return { browserDraftSession: () => session };
    if (name.endsWith("/directory/queries")) return { useDirectoryActor: () => ({ id: user, role: "manager", active: true }) };
    if (name.endsWith("/useInvoiceDocumentAction")) return { useInvoiceDocumentAction: () => async () => { throw new Error("Synthetic source not used"); } };
    if (name.includes("/components/ui/")) return new Proxy({}, { get: (_target, key) => key });
    return requireHere(resolve(file, "..", name));
  } });
  assert.ok(exports.default); const component = exports.default;
  const props = { userId: user, workOrder: { id: "WOT100", contractorAssignmentVersion: assignmentVersion, workflowCycle: 3, storeState: "TX", store: "123", addr: "Synthetic address" },
    contractorInvoices: [], billingInvoices: [], fmt: String, fire: (value: string) => messages.push(value), onConvert };
  let tree: unknown;
  const render = () => {
    for (let attempts = 0; attempts < 20; attempts++) {
      si = ri = ei = mi = gi = 0; changed = false; tree = component(props); while (queue.length) queue.shift()?.();
      if (!changed) return nodes(tree);
    }
    throw new Error("Synthetic render did not settle");
  };
  const find = (predicate: (node: Element) => boolean) => { const node = render().find(predicate); assert.ok(node); return node; };
  const invoke = async (node: Element, property: string, argument?: unknown) => { const callback = node.props[property]; assert.equal(typeof callback, "function");
    await (callback as (value?: unknown) => unknown)(argument); await Promise.resolve(); return render(); };
  return { render, find, invoke, values, session, messages, failStorage: () => { fail = true; }, allowStorage: () => { fail = false; },
    changeParent: (id: string) => { props.workOrder = { ...props.workOrder, id }; return render(); } };
}
test("actual quote workspace clean close uses shared Modal without a discard prompt", async () => {
  const h = harness(); await h.invoke(h.find(node => node.props["aria-label"] === "Open quote calculator"), "onClick");
  await h.invoke(h.find(node => node.type === "Modal"), "onRequestClose", "escape");
  assert.equal(h.render().some(node => node.type === "Modal" || node.type === "DiscardChangesDialog"), false);
});
test("accepted quote purges its exact lease before parent handoff without closing the generation early", async () => {
  let calls = 0;
  const h = harness(undefined, 2, async (_payload, isCurrent, onAccepted) => {
    calls++; assert.equal(isCurrent?.(), true); assert.equal(h.session.hasDrafts(), true);
    onAccepted?.(); assert.equal(h.session.hasDrafts(), false); assert.equal(isCurrent?.(), true);
    h.changeParent("WOT200"); return { id: "synthetic-accepted" };
  });
  await h.invoke(h.find(node => node.props["aria-label"] === "Open quote calculator"), "onClick");
  await h.invoke(h.find(node => node.type === "textarea"), "onChange", { target: { value: "Synthetic accepted line" } });
  await h.invoke(h.find(node => node.props.className === "btn-primary quote-convert-button"), "onClick");
  assert.equal(calls, 1); assert.equal(h.messages.some(message => message.includes("conversion failed")), false);
});
test("late accepted quote cannot discard a newly opened work-order draft", async () => {
  let finish: () => void = () => undefined; const waiting = new Promise<void>(resolve => { finish = resolve; });
  let currentAtAcceptance: boolean | undefined;
  const h = harness(undefined, 2, async (_payload, isCurrent, onAccepted) => {
    await waiting; currentAtAcceptance = isCurrent?.(); onAccepted?.(); return { id: "synthetic-accepted" };
  });
  await h.invoke(h.find(node => node.props["aria-label"] === "Open quote calculator"), "onClick");
  await h.invoke(h.find(node => node.type === "textarea"), "onChange", { target: { value: "Synthetic first line" } });
  const pending = h.invoke(h.find(node => node.props.className === "btn-primary quote-convert-button"), "onClick");
  await new Promise(resolve => setImmediate(resolve)); h.changeParent("WOT200");
  await h.invoke(h.find(node => node.props["aria-label"] === "Open quote calculator"), "onClick");
  await h.invoke(h.find(node => node.type === "textarea"), "onChange", { target: { value: "Synthetic next line" } });
  const nextKey = [...h.values.keys()].find(key => key.endsWith(":quote-calculator:WOT200")); assert.ok(nextKey);
  const before = h.values.get(nextKey); finish(); await pending;
  assert.equal(currentAtAcceptance, false); assert.equal(h.values.get(nextKey), before);
  assert.ok(h.render().some(node => node.type === "Modal"));
});
test("accepted quote remains accepted when exact draft cleanup fails", async () => {
  let accepted = false;
  const h = harness(undefined, 2, async (_payload, isCurrent, onAccepted) => {
    assert.equal(isCurrent?.(), true); onAccepted?.(); accepted = true; return { id: "synthetic-accepted" };
  });
  await h.invoke(h.find(node => node.props["aria-label"] === "Open quote calculator"), "onClick");
  await h.invoke(h.find(node => node.type === "textarea"), "onChange", { target: { value: "Synthetic accepted line" } });
  h.failStorage(); await h.invoke(h.find(node => node.props.className === "btn-primary quote-convert-button"), "onClick");
  assert.equal(accepted, true); assert.equal(h.messages.some(message => message.includes("conversion failed")), false);
  assert.ok(h.messages.some(message => message.includes("cleanup could not be confirmed")));
});
test("actual quote persisted draft offers guarded keep recovery and restores unchanged expected versions", async () => {
  const h = harness(); await h.invoke(h.find(node => node.props["aria-label"] === "Open quote calculator"), "onClick");
  await h.invoke(h.find(node => node.type === "textarea"), "onChange", { target: { value: "Synthetic partial line" } });
  assert.equal(h.session.hasDrafts(), true);
  await h.invoke(h.find(node => node.type === "Modal"), "onRequestClose", "close_button");
  const dialog = h.find(node => node.type === "DiscardChangesDialog"); assert.equal(dialog.props.persistence, "dirty_persisted");
  await h.invoke(dialog, "onKeepDraft"); assert.equal(h.render().some(node => node.type === "Modal"), false);
  const raw = [...h.values.entries()].find(([key]) => key.includes(`:draft:${user}:`))?.[1]; assert.ok(raw);
  const envelope = JSON.parse(raw) as { payload: { financialSnapshot: { expectedAssignmentVersion: number } } };
  assert.equal(envelope.payload.financialSnapshot.expectedAssignmentVersion, 2);
  const restored = harness(h.values, 9);
  await restored.invoke(restored.find(node => node.props["aria-label"] === "Open quote calculator"), "onClick");
  const restoredRaw = [...restored.values.entries()].find(([key]) => key.includes(`:draft:${user}:`))?.[1]; assert.ok(restoredRaw);
  const recovered = JSON.parse(restoredRaw) as { payload: { financialSnapshot: { expectedAssignmentVersion: number } } };
  assert.equal(recovered.payload.financialSnapshot.expectedAssignmentVersion, 2);
});
test("actual quote failed persistence cannot promise recovery and failed discard retains the workspace", async () => {
  const h = harness(); await h.invoke(h.find(node => node.props["aria-label"] === "Open quote calculator"), "onClick");
  await h.invoke(h.find(node => node.type === "textarea"), "onChange", { target: { value: "Synthetic saved line" } }); h.failStorage();
  await h.invoke(h.find(node => node.type === "textarea"), "onChange", { target: { value: "Synthetic partial line" } });
  await h.invoke(h.find(node => node.type === "Modal"), "onRequestClose", "backdrop");
  const dialog = h.find(node => node.type === "DiscardChangesDialog"); assert.equal(dialog.props.persistence, "persist_failed");
  await h.invoke(dialog, "onKeepDraft"); assert.ok(h.render().some(node => node.type === "Modal"));
  await h.invoke(h.find(node => node.type === "DiscardChangesDialog"), "onDiscard"); assert.ok(h.render().some(node => node.type === "Modal"));
});
