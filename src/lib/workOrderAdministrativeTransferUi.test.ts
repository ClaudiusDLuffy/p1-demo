import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the real component with deterministic hook state. This is behavior
// characterization, not a browser accessibility or authentication certificate.
type Element = { type: unknown; props: Record<string, unknown> };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value) || !("type" in value)
      || !value.props || typeof value.props !== "object") return [];
  const element = { type: value.type, props: value.props as Record<string, unknown> };
  return [element, ...elements(element.props.children)];
}
function harness(onTransfer: (reason: string, confirmed: boolean) => Promise<boolean>) {
  const filename = resolve("src/features/work-orders/AdministrativeTransferAction.tsx");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const requireHere = createRequire(import.meta.url);
  const state: unknown[] = [];
  let cursor = 0;
  const exports: { default?: (props: { contractorId: string | null; disabled: boolean; onTransfer: typeof onTransfer }) => unknown } = {};
  runInNewContext(compiled, { exports, require: (name: string) => {
    if (name === "react") return {
      useId: () => "synthetic-transfer",
      useState: (initial: unknown) => {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = initial;
        return [state[slot], (next: unknown) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }];
      },
    };
    return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
  } }, { filename });
  assert.ok(exports.default);
  const component = exports.default;
  const render = (disabled = false) => { cursor = 0; return elements(component({ contractorId: null, disabled, onTransfer })); };
  const click = (element: Element) => { assert.ok(typeof element.props.onClick === "function"); element.props.onClick(); };
  const change = (element: Element, target: { value?: string; checked?: boolean }) => {
    assert.ok(typeof element.props.onChange === "function"); element.props.onChange({ target });
  };
  const find = (tree: Element[], type: string) => { const found = tree.find(item => item.type === type); assert.ok(found); return found; };
  const submit = (tree: Element[]) => { const found = tree.filter(item => item.type === "button").at(-1); assert.ok(found); return found; };
  return { render, click, change, find, submit };
}

test("emergency UI is separate, requires a reason and explicit reconfirmation after reason edits", () => {
  const h = harness(async () => true);
  assert.equal(h.render().filter(item => item.type === "textarea").length, 0);
  h.click(h.find(h.render(), "button"));
  assert.equal(h.submit(h.render()).props.disabled, true);
  h.change(h.find(h.render(), "textarea"), { value: "Emergency transfer" });
  assert.equal(h.submit(h.render()).props.disabled, true);
  h.change(h.find(h.render(), "input"), { checked: true });
  assert.equal(h.submit(h.render()).props.disabled, false);
  h.change(h.find(h.render(), "textarea"), { value: "Changed reason" });
  assert.equal(h.submit(h.render()).props.disabled, true);
  assert.equal(h.find(h.render(), "input").props.type, "checkbox");
  assert.equal(h.find(h.render(), "textarea").props.maxLength, 500);
});

test("emergency UI disables in-flight submission and preserves reason/confirmation after a failed outcome", async () => {
  let finish: (result: boolean) => void = () => undefined;
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  const calls: unknown[] = [];
  const h = harness(async (reason, confirmed) => { calls.push({ reason, confirmed }); return pending; });
  h.click(h.find(h.render(), "button"));
  h.change(h.find(h.render(), "textarea"), { value: "  Emergency transfer  " });
  h.change(h.find(h.render(), "input"), { checked: true });
  h.click(h.submit(h.render()));
  assert.equal(h.submit(h.render()).props.disabled, true);
  assert.deepEqual(calls, [{ reason: "Emergency transfer", confirmed: true }]);
  finish(false);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.find(h.render(), "textarea").props.value, "  Emergency transfer  ");
  assert.equal(h.find(h.render(), "input").props.checked, true);
  assert.ok(h.render().some(element => element.props.role === "alert"));
  assert.equal(h.submit(h.render(true)).props.disabled, true);
});
