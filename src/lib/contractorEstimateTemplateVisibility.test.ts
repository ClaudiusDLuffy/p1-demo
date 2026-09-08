import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { isValidElement, type ComponentProps, type ReactElement } from "react";
import ts from "typescript";
import type ContractorEstimatePanel from "../features/estimates/ContractorEstimatePanel";
import type { ContractorEstimate, ContractorEstimateTemplate } from "./contractorEstimate";

type Props = ComponentProps<typeof ContractorEstimatePanel>;
type Element = ReactElement<Record<string, unknown>>;
type Query<T> = { data: T[]; isLoading: boolean; isError: boolean };

const template: ContractorEstimateTemplate = {
  id: "10000000-0000-4000-8000-000000000001", templateKey: "heatcraft",
  displayName: "Heatcraft form", description: "Synthetic approved template",
  versionLabel: "test-v1", originalName: "synthetic.xlsx",
  storagePath: "synthetic/heatcraft.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sizeBytes: 1024, sha256: "0".repeat(64), publishedAt: "2026-09-09T00:00:00Z",
};
const estimate: ContractorEstimate = {
  id: "10000000-0000-4000-8000-000000000002", quoteNum: "TEST-1",
  workOrderId: "WOT-TEST", contractorId: "10000000-0000-4000-8000-000000000003",
  contractorAssignmentVersion: 1, quoteDate: "2026-09-09", validUntil: null,
  terms: "Net 30", notes: null, state: "draft", subtotal: 0, salesTax: 0, total: 0,
  submittedAt: null, submittedBy: null, convertedAt: null, convertedBy: null,
  convertedInvoiceId: null, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
  lines: [], attachments: [],
};

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...elements(value.props.children)];
}
function visibleText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(visibleText).join("");
  return isValidElement<Record<string, unknown>>(value) ? visibleText(value.props.children) : "";
}

// Execute the real panel and its event handlers, replacing only hooks and IO.
// This covers conditional rendering, not deployed browser/RLS certification.
function harness() {
  const filename = resolve("src/features/estimates/ContractorEstimatePanel.tsx");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const requireHere = createRequire(import.meta.url);
  const estimates: Query<ContractorEstimate> = { data: [], isLoading: false, isError: false };
  const templates: Query<ContractorEstimateTemplate> = { data: [template], isLoading: false, isError: false };
  const downloads: ContractorEstimateTemplate[] = [];
  const messages: string[] = [];
  const enabled: boolean[] = [];
  const state: unknown[] = [];
  let cursor = 0;
  let downloadError: Error | null = null;
  const exports: { default?: (props: Props) => unknown } = {};
  const denyMutation = () => { throw new Error("Unexpected database mutation in template view"); };
  runInNewContext(compiled, { exports, Error, require: (name: string) => {
    if (name === "react") return {
      useMemo: (factory: () => unknown) => factory(),
      useRef: (initial: unknown) => {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = { current: initial };
        return state[slot];
      },
      useState: (initial: unknown) => {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = initial;
        return [state[slot], (next: unknown) => {
          state[slot] = typeof next === "function" ? next(state[slot]) : next;
        }];
      },
    };
    if (name === "@tanstack/react-query") return { useQueryClient: () => ({ invalidateQueries: denyMutation }) };
    if (name === "./queries") return {
      CONTRACTOR_ESTIMATES_KEY: ["contractor-estimates"],
      useContractorEstimatesQuery: (_id: string, active: boolean) => { enabled.push(active); return estimates; },
      useContractorEstimateTemplatesQuery: (active: boolean) => { enabled.push(active); return templates; },
    };
    if (name === "../invoices/queries" || name === "../work-orders/queries") return {};
    if (name === "../../lib/db") return {
      downloadContractorEstimateTemplate: async (value: ContractorEstimateTemplate) => {
        downloads.push(value);
        if (downloadError) throw downloadError;
      },
      convertContractorEstimateToInvoice: denyMutation, saveContractorEstimate: denyMutation,
      removeContractorEstimateAttachment: denyMutation, uploadContractorEstimateAttachment: denyMutation,
      loadInvoiceById: denyMutation, downloadContractorEstimateAttachment: denyMutation,
    };
    return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
  } }, { filename });
  assert.ok(exports.default);
  const component = exports.default;
  const render = (props: Partial<Props> = {}) => {
    cursor = 0;
    return component({ workOrder: { id: "WOT-TEST", status: "assigned" },
      currentUser: { name: "Synthetic staff", canInvoice: false }, isManager: true,
      fire: message => messages.push(message), ...props });
  };
  const buttons = (tree: unknown) => elements(tree).filter(element => element.type === "button");
  const click = (button: Element) => {
    assert.equal(typeof button.props.onClick, "function");
    if (typeof button.props.onClick === "function") button.props.onClick();
  };
  return { estimates, templates, downloads, messages, enabled, render, buttons, click,
    failDownload: () => { downloadError = new Error("Synthetic download unavailable"); } };
}

test("staff with zero estimates can see and download published forms without estimate editing controls", async () => {
  const h = harness();
  const tree = h.render();
  assert.match(visibleText(tree), /Approved equipment form templates/);
  assert.match(visibleText(tree), /No estimates on this work order/);
  const download = h.buttons(tree).find(button => visibleText(button).startsWith("Download Heatcraft form"));
  assert.ok(download, "Published form download must not depend on an existing estimate");
  assert.equal(h.buttons(tree).some(button => /New estimate|Edit|Convert|Attach forms/.test(visibleText(button))), false);
  h.click(download);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.downloads, [template]);
});

test("forms do not disappear when the staff estimate query finishes with no results", () => {
  const h = harness();
  h.estimates.isLoading = true;
  assert.match(visibleText(h.render()), /Download Heatcraft form/);
  h.estimates.isLoading = false;
  assert.match(visibleText(h.render()), /Download Heatcraft form/);
  h.estimates.isError = true;
  assert.match(visibleText(h.render()), /Download Heatcraft form/);
});

test("staff without estimates see explicit template loading, error and unpublished states", () => {
  const h = harness();
  h.templates.data = [];
  h.templates.isLoading = true;
  assert.match(visibleText(h.render()), /Loading approved templates/);
  h.templates.isLoading = false;
  h.templates.isError = true;
  assert.match(visibleText(h.render()), /Approved templates could not be loaded/);
  h.templates.isError = false;
  assert.match(visibleText(h.render()), /No approved templates are published yet/);
  assert.equal(h.buttons(h.render()).length, 0);
});

test("staff with an existing estimate retain view-only estimate controls and form downloads", () => {
  const h = harness();
  h.estimates.data = [estimate];
  const labels = h.buttons(h.render()).map(visibleText);
  assert.ok(labels.some(label => label.startsWith("Download Heatcraft form")));
  assert.ok(labels.includes("View"));
  assert.equal(labels.some(label => /New estimate|Edit|Convert|Attach forms/.test(label)), false);
});

test("invoice-capable contractors retain forms and creation; report-only users remain hidden with disabled queries", () => {
  const contractor = harness();
  const tree = contractor.render({ isManager: false, currentUser: { canInvoice: true } });
  assert.match(visibleText(tree), /Download Heatcraft form/);
  assert.match(visibleText(tree), /New estimate/);
  const reportOnly = harness();
  assert.equal(reportOnly.render({ isManager: false, currentUser: { canInvoice: false } }), null);
  assert.deepEqual(reportOnly.enabled, [false, false]);
  assert.equal(reportOnly.render({ isManager: false, currentUser: null }), null);
});

test("template download failures remain visible to staff even without estimates", async () => {
  const h = harness();
  h.failDownload();
  const download = h.buttons(h.render()).find(button => visibleText(button).startsWith("Download Heatcraft form"));
  assert.ok(download);
  h.click(download);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(visibleText(h.render()), /Synthetic download unavailable/);
  assert.deepEqual(h.messages, ["Could not download Heatcraft form: Synthetic download unavailable"]);
});
