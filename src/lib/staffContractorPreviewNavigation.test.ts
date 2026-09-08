import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { isValidElement, type ComponentProps, type ReactElement } from "react";
import ts from "typescript";
import type StaffContractorPreview from "../features/contractor-preview/StaffContractorPreview";
import type { StaffContractorPreviewWorkOrder } from "../features/contractor-preview/queries";

type Element = ReactElement<Record<string, unknown>>;
type Props = ComponentProps<typeof StaffContractorPreview> & {
  onOpenWorkOrder: (id: string) => void;
};
const workOrder: StaffContractorPreviewWorkOrder = {
  id: "WOT-SYNTHETIC-123-A", status: "assigned", functionalStatus: null,
  priority: "P2", store: "TEST", city: null, address: null, state: null,
  summary: "Synthetic repair", description: null, category: null, subCategory: null,
  businessService: null, isCapital: false, technicianName: null,
  invoicingCompletedAt: null, createdAt: null, updatedAt: null, closedAt: null,
};

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...elements(value.props.children)];
}
function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return isValidElement<Record<string, unknown>>(value) ? text(value.props.children) : "";
}
function invoke(element: Element, handler: string, event?: unknown): unknown {
  const callback = element.props[handler];
  assert.equal(typeof callback, "function", `${String(element.type)} must have ${handler}`);
  if (typeof callback === "function") return callback(event);
}
function compile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}

// Execute the real component and handlers, replacing hooks and query IO only.
// This is local navigation coverage, not a browser or deployed authorization test.
function harness() {
  const filename = resolve("src/features/contractor-preview/StaffContractorPreview.tsx");
  const requireHere = createRequire(import.meta.url);
  const opened: string[] = [];
  const state: unknown[] = [];
  let cursor = 0;
  const query = {
    data: { items: [workOrder], hasMore: false, nextCursor: null },
    isLoading: false, isError: false, isFetching: false, isPlaceholderData: false, error: null,
  };
  const exports: { default?: (props: Props) => unknown } = {};
  runInNewContext(compile(readFileSync(filename, "utf8")), {
    exports, Error, require: (name: string) => {
      if (name === "react") return {
        useMemo: (factory: () => unknown) => factory(),
        useDeferredValue: (value: unknown) => value,
        useState: (initial: unknown) => {
          const slot = cursor++;
          if (!(slot in state)) state[slot] = initial;
          return [state[slot], (value: unknown) => { state[slot] = value; }];
        },
      };
      if (name === "./queries") return {
        useStaffContractorPreviewWorkOrdersQuery: () => query,
        useStaffContractorPreviewInvoicesQuery: () => ({ ...query, data: { ...query.data, items: [] } }),
      };
      if (name === "../../lib/useCursorPagination") return {
        useCursorPagination: () => ({ position: { page: 1, cursor: null }, previous: () => {}, next: () => {} }),
      };
      return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
    },
  }, { filename });
  assert.ok(exports.default);
  const component = exports.default;
  const render = (page = "contractor_preview") => {
    cursor = 0;
    return component({ page, contractors: [{ id: "synthetic-company", company: "Synthetic contractor" }],
      onOpenWorkOrder: id => opened.push(id) });
  };
  const selectCompany = () => {
    const select = elements(render()).find(element => element.type === "select");
    assert.ok(select);
    invoke(select, "onChange", { target: { value: "synthetic-company" } });
    return render();
  };
  return { render, selectCompany, query, opened };
}

test("contractor-view card opens the exact selected work-order detail without impersonation", () => {
  const h = harness();
  const tree = h.selectCompany();
  const card = elements(tree).find(element => element.type === "article");
  assert.ok(card);
  invoke(card, "onClick");
  assert.deepEqual(h.opened, [workOrder.id]);
  assert.match(text(tree), /Read-only staff preview — no impersonation/);
  assert.match(text(tree), /opens its detail in your normal staff view/);
});

test("work-order identifier is a native keyboard-accessible button and does not double-open", () => {
  const h = harness();
  const button = elements(h.selectCompany()).find(element => element.type === "button"
    && element.props["aria-label"] === `Open work order ${workOrder.id} in staff view`);
  assert.ok(button, "Work-order navigation needs an accessible native control");
  assert.equal(button.props.type, "button");
  let stopped = false;
  invoke(button, "onClick", { stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true, "Button activation must not also trigger the card");
  assert.deepEqual(h.opened, [workOrder.id]);
});

test("copying the work-order number does not open detail", async () => {
  const h = harness();
  const copy = elements(h.selectCompany()).find(element => typeof element.type === "function"
    && element.type.name === "CopyWorkOrderButton");
  assert.ok(copy);
  const filename = resolve("src/components/ui/CopyWorkOrderButton.tsx");
  const requireHere = createRequire(import.meta.url);
  const exports: { CopyWorkOrderButton?: (props: Record<string, unknown>) => unknown } = {};
  const copied: string[] = [];
  runInNewContext(compile(readFileSync(filename, "utf8")), {
    exports, navigator: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
    require: (name: string) => requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name),
  });
  assert.ok(exports.CopyWorkOrderButton);
  const button = elements(exports.CopyWorkOrderButton(copy.props)).find(element => element.type === "button");
  assert.ok(button);
  let stopped = false;
  await invoke(button, "onClick", { preventDefault: () => {}, stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(copied, [workOrder.id]);
  assert.deepEqual(h.opened, []);
});

test("returning to the mounted preview retains the selected company and search", () => {
  const h = harness();
  const input = elements(h.selectCompany()).find(element => element.type === "input");
  assert.ok(input);
  invoke(input, "onChange", { target: { value: "Synthetic repair" } });
  assert.equal(h.render("work_orders"), null);
  const returned = elements(h.render());
  assert.equal(returned.find(element => element.type === "select")?.props.value, "synthetic-company");
  assert.equal(returned.find(element => element.type === "input")?.props.value, "Synthetic repair");
});

test("empty, loading and failed previews expose no stale work-order navigation", () => {
  const h = harness();
  assert.equal(elements(h.render()).some(element => element.type === "article"), false);
  h.selectCompany();
  h.query.isLoading = true;
  assert.equal(elements(h.render()).some(element => element.type === "article"), false);
  h.query.isLoading = false;
  h.query.isError = true;
  assert.equal(elements(h.render()).some(element => element.type === "article"), false);
  h.query.isError = false;
  h.query.data.items = [];
  assert.equal(elements(h.render()).some(element => element.type === "article"), false);
  assert.deepEqual(h.opened, []);
});

test("previous-company placeholder cards cannot open while the new company loads", () => {
  const h = harness();
  h.selectCompany();
  h.query.isPlaceholderData = true;
  h.query.isFetching = true;
  const tree = elements(h.render());
  const card = tree.find(element => element.type === "article");
  const button = tree.find(element => element.type === "button"
    && element.props["aria-label"] === `Open work order ${workOrder.id} in staff view`);
  assert.ok(card && button);
  assert.equal(card.props.onClick, undefined);
  assert.equal(button.props.disabled, true);
  h.query.isPlaceholderData = false;
  h.query.isFetching = false;
  const currentCard = elements(h.render()).find(element => element.type === "article");
  assert.ok(currentCard);
  invoke(currentCard, "onClick");
  assert.deepEqual(h.opened, [workOrder.id]);
});

test("PortalShell connects preview navigation to existing detail and preserves its back destination", () => {
  const filename = resolve("src/components/PortalShell.tsx");
  const source = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "StaffContractorPreview") {
      for (const prop of node.attributes.properties) {
        if (ts.isJsxAttribute(prop) && prop.name.getText(source) === "onOpenWorkOrder"
          && prop.initializer && ts.isJsxExpression(prop.initializer)) callback = prop.initializer.expression;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback, "PortalShell must pass the detail navigation callback");
  const changes: Record<string, unknown> = {};
  const setters = Object.fromEntries(["WorkOrderReturnPage", "SelectedWO", "SelectedInvoice", "SelectedBillingInvoice", "AiNote", "Page"]
    .map(key => [`set${key}`, (value: unknown) => { changes[key] = value; }]));
  const exports: { open?: (id: string) => void } = {};
  runInNewContext(compile(`exports.open = ${callback.getText(source)};`), { exports, ...setters });
  assert.ok(exports.open);
  exports.open(workOrder.id);
  assert.deepEqual(changes, {
    WorkOrderReturnPage: "contractor_preview", SelectedWO: workOrder.id,
    SelectedInvoice: null, SelectedBillingInvoice: null, AiNote: null, Page: "work_orders",
  });
});
