import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sel } from "../components/ui/Sel";
import { T } from "./constants";
import { initialStaffBillingTerms, nextStaffBillingDueDate, STAFF_BILLING_TERMS_OPTIONS } from "./staffBillingTerms";

const filename = resolve("src/features/billing/BillingInvoiceCreateModal.tsx");
const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes: ts.Node[] = [];
const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); };
visit(source);
const containsIdentifier = (node: ts.Node, name: string): boolean => {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return ts.forEachChild(node, child => containsIdentifier(child, name) || undefined) === true;
};
const dateEffect = nodes.find(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
  && node.expression.text === "useEffect" && node.arguments[0]
  && containsIdentifier(node.arguments[0], "previousInvoiceDate")
  && containsIdentifier(node.arguments[0], "setValue"));
assert.ok(dateEffect && ts.isCallExpression(dateEffect));
const defaultsCall = nodes.find(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
  && node.expression.text === "useForm");
assert.ok(defaultsCall && ts.isCallExpression(defaultsCall));
const defaultsObject = defaultsCall.arguments[0];
assert.ok(defaultsObject && ts.isObjectLiteralExpression(defaultsObject));
const defaults = defaultsObject.properties.find(property => ts.isPropertyAssignment(property)
  && ts.isIdentifier(property.name) && property.name.text === "defaultValues");
assert.ok(defaults && ts.isPropertyAssignment(defaults));
const termsControl = nodes.find(node => ts.isJsxElement(node)
  && ts.isIdentifier(node.openingElement.tagName) && node.openingElement.tagName.text === "Sel"
  && node.openingElement.attributes.properties.some(attribute => ts.isJsxSpreadAttribute(attribute)
    && ts.isCallExpression(attribute.expression) && ts.isIdentifier(attribute.expression.expression)
    && attribute.expression.expression.text === "register"
    && attribute.expression.arguments.some(argument => ts.isStringLiteral(argument) && argument.text === "terms")));
assert.ok(termsControl);

// Execute the real form's defaults/effect, not a second handwritten UI model.
// Hooks/DOM are out of scope here; the effect receives RHF's current snapshot.
// Legacy date helpers are included when present so pre-fix behavior reproduces.
const legacyHelpers = nodes.filter(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
  && ["dateInputValue", "addDays"].includes(node.name.text))
  .map(node => `const ${node.getText(source)};`).join("\n");
const compiled = ts.transpileModule(`${legacyHelpers}\nexport const effect = ${dateEffect.arguments[0].getText(source)};
  export const defaults = ${defaults.initializer.getText(source)};
  export const termsControl = ${termsControl.getText(source)};`, {
  fileName: "billing-terms-fixture.tsx",
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const requireHere = createRequire(import.meta.url);

type Form = { invoiceDate: string; terms: string; dueDate: string };
function harness(input: {
  form: Form;
  previous: { invoiceDate: string; terms: string };
  rendered?: { invoiceDate: string; terms: string };
  modal?: string;
  hydrated?: boolean;
}) {
  const form = { ...input.form };
  const writes: Array<{ field: string; value: string }> = [];
  const exports: { effect?: () => void; defaults?: Form; termsControl?: ReactElement } = {};
  runInNewContext(compiled, {
    exports, initialToday: "2026-09-09", todayIso: () => "2026-09-09",
    require: requireHere, Sel, T, STAFF_BILLING_TERMS_OPTIONS,
    register: (name: string) => ({ name, onChange: () => undefined }),
    initialStaffBillingTerms, nextStaffBillingDueDate,
    modal: input.modal ?? "createBillingInvoice",
    draftHydrated: { current: input.hydrated ?? true },
    invoiceDate: input.rendered?.invoiceDate ?? input.form.invoiceDate,
    terms: input.rendered?.terms ?? input.form.terms,
    previousInvoiceDate: { current: input.previous.invoiceDate },
    previousTerms: { current: input.previous.terms },
    getValues: (field: keyof Form) => form[field],
    setValue: (field: keyof Form, value: string) => { writes.push({ field, value }); form[field] = value; },
  }, { filename });
  assert.ok(exports.effect && exports.defaults && exports.termsControl);
  return { form, writes, effect: exports.effect, defaults: exports.defaults, termsControl: exports.termsControl };
}

test("the actual custom Terms selector displays the loaded value, not its first option", () => {
  for (const terms of ["Net 60", "Net 30", "Net 15", "Due on receipt", "Net 45"]) {
    const view = harness({ form: { invoiceDate: "2026-09-09", terms, dueDate: "2027-01-31" },
      previous: { invoiceDate: "2026-09-09", terms } });
    const markup = renderToStaticMarkup(view.termsControl);
    assert.match(markup, new RegExp(`name="terms"[^>]*value="${terms}"`));
    assert.ok(markup.includes(`>${terms}</span>`));
  }
});

test("actual new P1 modal defaults contain Net 60 and its matching due date", () => {
  const view = harness({ form: { invoiceDate: "2026-09-09", terms: "Net 60", dueDate: "2026-11-08" },
    previous: { invoiceDate: "2026-09-09", terms: "Net 60" } });
  assert.equal(view.defaults.terms, "Net 60");
  assert.equal(view.defaults.dueDate, "2026-11-08");
});

test("actual terms effect applies explicit term changes without requiring a date edit", () => {
  const view = harness({ form: { invoiceDate: "2026-09-09", terms: "Net 60", dueDate: "2026-10-09" },
    previous: { invoiceDate: "2026-09-09", terms: "Net 30" } });
  view.effect();
  assert.equal(view.form.dueDate, "2026-11-08");
  assert.equal(view.writes.length, 1);
});

test("actual date effect moves automatic Net 60 dates but retains legacy Net 30", () => {
  for (const [terms, oldDue, newDue] of [["Net 60", "2026-11-08", "2026-11-09"], ["Net 30", "2026-10-09", "2026-10-10"]]) {
    const view = harness({ form: { invoiceDate: "2026-09-10", terms, dueDate: oldDue },
      previous: { invoiceDate: "2026-09-09", terms } });
    view.effect();
    assert.equal(view.form.dueDate, newDue);
  }
});

test("actual date effect preserves a manually selected due date", () => {
  const view = harness({ form: { invoiceDate: "2026-09-10", terms: "Net 60", dueDate: "2027-01-31" },
    previous: { invoiceDate: "2026-09-09", terms: "Net 60" } });
  view.effect();
  assert.equal(view.form.dueDate, "2027-01-31");
  assert.deepEqual(view.writes, []);
});

test("same-render hydration reads the loaded form, not pre-reset watched defaults", () => {
  for (const terms of ["Net 30", "Net 45", "Net 60"]) {
    const view = harness({ form: { invoiceDate: "2026-08-01", terms, dueDate: "2027-01-31" },
      previous: { invoiceDate: "2026-08-01", terms }, rendered: { invoiceDate: "2026-09-09", terms: "Net 60" } });
    view.effect();
    assert.equal(view.form.dueDate, "2027-01-31");
    assert.deepEqual(view.writes, []);
  }
});

test("closed and not-yet-hydrated forms do not recalculate due dates", () => {
  for (const settings of [{ modal: "" }, { hydrated: false }]) {
    const view = harness({ form: { invoiceDate: "2026-09-10", terms: "Net 60", dueDate: "2026-11-08" },
      previous: { invoiceDate: "2026-09-09", terms: "Net 60" }, ...settings });
    view.effect();
    assert.deepEqual(view.writes, []);
  }
});
