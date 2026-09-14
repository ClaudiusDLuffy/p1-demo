import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import * as billing from "./staffBilling";
import { QUICKBOOKS_EQUIPMENT_TAGS } from "./quickBooksEquipmentTags";

const filename = resolve("src/features/billing/BillingInvoiceCreateModal.tsx");
const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes: ts.Node[] = [];
const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); };
visit(source);
const schemaNames = new Set(["BillingLineSchema", "OptionalTaxAmountSchema", "OptionalTaxRateSchema", "BillingInvoiceSchema"]);
const declarations = nodes.filter(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
  && schemaNames.has(node.name.text)).map(node => `const ${node.getText(source)};`).join("\n");
const exports: { line?: z.ZodType; invoice?: z.ZodType } = {};
runInNewContext(ts.transpileModule(`${declarations}\nexports.line = BillingLineSchema; exports.invoice = BillingInvoiceSchema;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, z, QUICKBOOKS_EQUIPMENT_TAGS, ...billing });
assert.ok(exports.line && exports.invoice);
const lineSchema = exports.line;
const invoiceSchema = exports.invoice;
const warranty = { type: "Warranty", desc: "Warranty repair — no charge", qty: 1, rate: 0, isTaxable: false };

test("only an explicit Warranty category retains the no-charge classification", () => {
  assert.ok(billing.STAFF_BILLING_LINE_TYPES.includes("Warranty"));
  assert.equal(billing.normalizeStaffBillingLineType(" warranty "), "Warranty");
  assert.equal(billing.normalizeImportedStaffBillingLineType("Warranty", "Labor to replace a compressor"), "Warranty");
  assert.equal(billing.normalizeImportedStaffBillingLineType("Labor", "Warranty repair"), "Labor");
  assert.notEqual(billing.normalizeStaffBillingLineType("Warranty credit"), "Warranty");
  assert.equal(billing.importedStaffBillingRate("Warranty", 150), 0);
});

test("the actual billing form accepts zero Warranty, positive quantity and a meaningful description", () => {
  assert.equal(lineSchema.safeParse(warranty).success, true);
  assert.equal(lineSchema.safeParse({ ...warranty, rate: 25 }).success, true);
  for (const input of [
    { ...warranty, desc: " " }, { ...warranty, qty: 0 }, { ...warranty, qty: -1 },
    { ...warranty, rate: -1 }, { ...warranty, rate: Number.NaN }, { ...warranty, rate: Infinity },
    { ...warranty, rate: null }, { ...warranty, rate: "0" }, { ...warranty, rate: undefined },
  ]) assert.equal(lineSchema.safeParse(input).success, false);
});

test("ordinary billing types cannot use a zero rate or opt in through description text", () => {
  for (const type of ["Labor", "OT Labor", "Travel", "Parts/Hardware", "Shipping", "Other", "Warranty credit"]) {
    assert.equal(lineSchema.safeParse({ ...warranty, type }).success, false, type);
    assert.equal(lineSchema.safeParse({ ...warranty, type, rate: 10 }).success, true, type);
  }
});

test("a complete warranty-only billing form can save with zero subtotal and total", () => {
  const form = { num: "SYNTH-WARRANTY-1", invoiceDate: "2026-09-09", dueDate: "2026-11-08",
    territory: "Texas", equipmentTag: QUICKBOOKS_EQUIPMENT_TAGS[0], storeNumber: "SYNTH",
    terms: "Net 60", state: "draft", lines: [warranty] };
  assert.equal(invoiceSchema.safeParse(form).success, true);
  assert.equal(invoiceSchema.safeParse({ ...form, state: "submitted" }).success, true);
  assert.equal(invoiceSchema.safeParse({ ...form, lines: [warranty, { ...warranty, type: "Labor", rate: 110 }] }).success, true);
  assert.equal(invoiceSchema.safeParse({ ...form, lines: [warranty, { ...warranty, type: "Labor" }] }).success, false);
});

test("Warranty quick-add creates a described zero-rate line", () => {
  const quickAdd = nodes.find(node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.name.text === "QUICK_ADD_LINES");
  assert.ok(quickAdd && ts.isVariableDeclaration(quickAdd) && quickAdd.initializer);
  const values: { items?: Array<Record<string, unknown>> } = {};
  runInNewContext(ts.transpileModule(`exports.items = ${quickAdd.initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: values });
  const item = values.items?.find(value => value.type === "Warranty");
  assert.ok(item);
  assert.equal(item.rate, 0);
  assert.ok(typeof item.desc === "string" && item.desc.trim().length > 0);
});

test("changing an editable line to Warranty clears markup and defaults its rate to zero", () => {
  const selector = nodes.find(node => ts.isJsxElement(node)
    && node.openingElement.attributes.properties.some(attribute => ts.isJsxSpreadAttribute(attribute)
      && ts.isIdentifier(attribute.expression) && attribute.expression.text === "typeRegistration"));
  assert.ok(selector && ts.isJsxElement(selector));
  const change = selector.openingElement.attributes.properties.find(attribute => ts.isJsxAttribute(attribute)
    && attribute.name.getText(source) === "onChange");
  assert.ok(change && ts.isJsxAttribute(change) && change.initializer && ts.isJsxExpression(change.initializer)
    && change.initializer.expression);
  const output: { change?: (event: { target: { value: string } }) => void } = {};
  const values: Record<string, unknown> = {};
  let registered = 0;
  const context = { exports: output, ...billing, isP1PurchasedPart: false, i: 0, line: { desc: "Synthetic repair" },
    sourceUnitCost: 150, partsMarkup: "25", typeRegistration: { onChange: () => { registered += 1; } },
    taxabilityForLine: () => ({ taxable: false }),
    setValue: (field: string, value: unknown) => { values[field] = value; } };
  runInNewContext(ts.transpileModule(`exports.change = ${change.initializer.expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  assert.ok(output.change);
  output.change({ target: { value: "Warranty" } });
  assert.equal(registered, 1);
  assert.equal(values["lines.0.rate"], 0);
  assert.equal(values["lines.0.markupPercent"], null);
  // Required P1-purchased parts cannot be reclassified as a no-charge line.
  context.isP1PurchasedPart = true;
  output.change({ target: { value: "Warranty" } });
  assert.equal(registered, 1);
});
