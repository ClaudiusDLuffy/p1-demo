import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import type { DirectoryItem } from "./contracts";

type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const nodes = (value: unknown): Node[] => !value ? [] : Array.isArray(value) ? value.flatMap(nodes)
  : typeof value === "object" && "props" in value ? [value as Node, ...nodes((value as Node).props.children)] : [];
const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(text).join("")
  : typeof value === "object" && value !== null && "props" in value ? text((value as Node).props.children) : "";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const requireHere = createRequire(import.meta.url);
function componentHarness(file: string, imports: (name: string) => unknown) {
  const filename = resolve(file), slots: unknown[] = [], cleanups: (() => void)[] = [];
  let index = 0;
  const document = { activeElement: null as unknown, body: {}, addEventListener: () => undefined, removeEventListener: () => undefined };
  const window = { innerWidth: 1024, innerHeight: 768, addEventListener: () => undefined, removeEventListener: () => undefined };
  const exports: Record<string, (props: Record<string, unknown>) => Node> = {};
  const jsx = (type: unknown, props: Node["props"]) => ({ type, props });
  const react = {
    forwardRef: (render: (props: unknown, ref: unknown) => Node) => (props: unknown) => render(props, null),
    useState: (initial: unknown) => { const i = index++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef: (initial: unknown) => { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useImperativeHandle: () => undefined,
    useEffect: (run: () => (() => void) | void) => { const cleanup = run(); if (cleanup) cleanups.push(cleanup); }, useId: () => "synthetic-list",
  };
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  runInNewContext(code, { exports, document, window, HTMLInputElement: class {}, AbortController, AbortSignal, Promise,
    require: (name: string) => name === "react" ? react : name === "react-dom" ? { createPortal: (children: unknown) => children }
      : name.endsWith("/fieldContext") ? { useFieldControl: (props: unknown) => props }
      : name.endsWith("/Modal") ? { useModalPortalHost: () => null }
      : name.endsWith("/floatingPanel") ? { getFloatingPanelPosition: () => ({ top: 42, left: 24, width: 230, maxHeight: 360, placement: "bottom" }) }
      : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
      : imports(name) || requireHere(resolve(filename, "..", name)),
  }, { filename });
  return { exports, slots, document, render: (name: string, props: Record<string, unknown>) => { index = 0; return exports[name](props); },
    close: () => cleanups.forEach(cleanup => cleanup()) };
}

test("picker lists lazily, hydrates selected identity outside page, and retains disabled selection", () => {
  const reads: { domain: string; enabled: unknown }[] = [];
  const selections: { domain: string; id: unknown }[] = [];
  const directory = { items: [{ id: id(1), name: "Page one" }], data: { hasMore: true, nextCursor: "cursor" }, search: "", setSearch: () => undefined,
    position: { page: 1 }, previous: () => undefined, next: () => undefined, waiting: false, isError: false, refetch: () => undefined };
  const h = componentHarness("src/features/directory/DirectorySelect.tsx", name => name === "./queries" ? {
    useDirectoryPage: (domain: string, enabled: unknown) => { reads.push({ domain, enabled }); return directory; },
    useDirectorySelection: (domain: string, selectedId: unknown) => { selections.push({ domain, id: selectedId });
      return { data: selectedId === id(99) ? { id: id(99), name: "Outside current page" } : null, isSuccess: true }; },
  } : null);
  const props = { domain: "assignable_contractors", value: id(99) };
  let tree = h.render("DirectorySelect", props);
  assert.equal(reads[0].enabled, false); assert.ok(text(tree).includes("Outside current page"));
  const trigger = nodes(tree).find(node => node.type === "button")!;
  (trigger.props.onClick as () => void)(); tree = h.render("DirectorySelect", props);
  assert.equal(reads.at(-1)?.enabled, true); assert.ok(nodes(tree).some(node => node.type === "input" && node.props.type === "search"));
  assert.ok(nodes(tree).some(node => node.props.role === "option" && text(node) === "Page one"));
  assert.ok(selections.some(selection => selection.id === id(99)));
  tree = h.render("DirectorySelect", { ...props, disabled: true });
  assert.equal(reads.at(-1)?.enabled, false); assert.ok(text(tree).includes("Outside current page")); h.close();
});
test("picker keyboard traversal and record-only selection preserve rowUUID without inferred portal identity", () => {
  const selections: { domain: string; id: unknown }[] = [], changes: unknown[][] = [];
  const technician = { id: id(3), name: "Duplicate display name", profileId: null };
  const h = componentHarness("src/features/directory/DirectorySelect.tsx", name => name === "./queries" ? {
    useDirectoryPage: () => ({ items: [technician], search: "", setSearch: () => undefined, position: { page: 1 }, waiting: false }),
    useDirectorySelection: (domain: string, selectedId: unknown) => { selections.push({ domain, id: selectedId }); return { data: null, isSuccess: true }; },
  } : null);
  const props = { domain: "company_technicians", contractorId: id(4), technicianValues: true, value: `legacy:${id(3)}`,
    onChange: (...args: unknown[]) => changes.push(args) };
  let tree = h.render("DirectorySelect", props);
  (nodes(tree).find(node => node.type === "button")!.props.onClick as () => void)(); tree = h.render("DirectorySelect", props);
  const choices = [0, 1, 2].map(index => ({ index, focus() { h.document.activeElement = this; } }));
  const panel = nodes(tree).find(node => node.props["data-directory-panel"] === "true")!;
  (panel.props.ref as { current: unknown }).current = { querySelectorAll: () => choices };
  const key = tree.props.onKeyDown as (event: unknown) => void;
  key({ key: "ArrowDown", target: {}, preventDefault() {} }); assert.equal(h.document.activeElement, choices[0]);
  key({ key: "End", target: {}, preventDefault() {} }); assert.equal(h.document.activeElement, choices[2]);
  key({ key: "ArrowUp", target: {}, preventDefault() {} }); assert.equal(h.document.activeElement, choices[1]);
  key({ key: "Home", target: {}, preventDefault() {} }); assert.equal(h.document.activeElement, choices[0]);
  let triggerFocusCalls = 0;
  const triggerRef = nodes(tree).find(node => node.type === "button")!.props.ref as { current: unknown };
  triggerRef.current = { focus() { triggerFocusCalls++; h.document.activeElement = this; } };
  let prevented = false; let stopped = false;
  key({ key: "Escape", target: {}, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true); assert.equal(stopped, true);
  assert.equal(triggerFocusCalls, 1);
  const option = nodes(tree).find(node => node.props.role === "option" && text(node).includes("record only"))!;
  (option.props.onClick as () => void)();
  assert.equal(triggerFocusCalls, 2);
  assert.equal(h.document.activeElement, triggerRef.current);
  assert.equal((changes[0][0] as { target: { value: string } }).target.value, `legacy:${id(3)}`);
  assert.equal((changes[0][1] as DirectoryItem).profileId, null);
  assert.ok(selections.some(selection => selection.domain === "company_technicians" && selection.id === id(3)));
  assert.ok(!selections.some(selection => selection.id === technician.name)); h.close();
});
test("technician change exact-revalidates original name, locks double click, and never persists display ellipsis", async () => {
  let finish!: () => void; const gate = new Promise<void>(done => { finish = done; });
  const calls: unknown[][] = [], exact: unknown[][] = [];
  const row = { id: id(3), name: "Display…", profileId: null };
  const h = componentHarness("src/features/work-orders/WorkOrderTechnicianPicker.tsx", name => name.endsWith("/DirectorySelect") ? { DirectorySelect: "DirectorySelect" }
    : name.endsWith("/directory/api") ? { loadDirectorySelection: async (...args: unknown[]) => { exact.push(args); await gate; return { ...row, name: "Full original technician name" }; } } : null);
  const props = { workOrder: { id: "WOT-SYNTHETIC", contractor: id(4), assignedTechnicianProfileId: id(9) }, actor: { canManageTeam: true }, isManager: false,
    doAssignPortalTechnician: async (...args: unknown[]) => { calls.push(["portal", ...args]); return true; },
    doSetTechnician: async (...args: unknown[]) => { calls.push(["snapshot", ...args]); return true; } };
  const tree = h.render("default", props);
  const change = nodes(tree).find(node => node.type === "DirectorySelect")!.props.onChange as (event: unknown, item: unknown) => Promise<void>;
  const pending = change({ target: { value: `legacy:${id(3)}` } }, row);
  await change({ target: { value: `legacy:${id(3)}` } }, row); assert.equal(exact.length, 1);
  assert.equal(exact[0][0], "company_technicians"); assert.equal(exact[0][1], id(3)); assert.equal(exact[0][2], id(4));
  finish(); await pending;
  assert.deepEqual(calls, [["portal", "WOT-SYNTHETIC", null, null], ["snapshot", "WOT-SYNTHETIC", "Full original technician name"]]);
  h.close();
});
test("technician revalidation failure is visible without mutation and ordinary members never enumerate a team", async () => {
  const calls: unknown[] = [];
  const h = componentHarness("src/features/work-orders/WorkOrderTechnicianPicker.tsx", name => name.endsWith("/DirectorySelect") ? { DirectorySelect: "DirectorySelect" }
    : name.endsWith("/directory/api") ? { loadDirectorySelection: async () => { throw new Error("Synthetic failure"); } } : null);
  const props = { workOrder: { id: "WOT-SYNTHETIC", contractor: id(4), technicianOnJob: "Stored snapshot" }, actor: { canManageTeam: true }, isManager: false,
    doAssignPortalTechnician: async () => calls.push("portal"), doSetTechnician: async () => calls.push("snapshot") };
  let tree = h.render("default", props);
  const change = nodes(tree).find(node => node.type === "DirectorySelect")!.props.onChange as (event: unknown, item: unknown) => Promise<void>;
  await change({ target: { value: id(3) } }, { id: id(3), profileId: id(3), name: "Option" });
  tree = h.render("default", props); assert.ok(nodes(tree).some(node => node.props.role === "alert")); assert.equal(calls.length, 0);
  for (const actor of [{ contractorOrganizationId: id(4), canManageTeam: false }, { contractorAccessLevel: "report_only" }, { contractorTier: "direct" }]) {
    tree = h.render("default", { ...props, actor });
    assert.ok(!nodes(tree).some(node => node.type === "DirectorySelect")); assert.ok(text(tree).includes("Stored snapshot"));
  }
  h.close();
});
test("authorized team lead revalidates and assigns a structured team profile", async () => {
  const calls: unknown[][] = [];
  const h = componentHarness("src/features/work-orders/WorkOrderTechnicianPicker.tsx", name => name.endsWith("/DirectorySelect") ? { DirectorySelect: "DirectorySelect" }
    : name.endsWith("/directory/api") ? { loadDirectorySelection: async () => ({ id: id(7), name: "Crew technician" }) } : null);
  const props = { workOrder: { id: "WOT-SYNTHETIC", contractor: id(4), assignedTechnicianProfileId: id(6), technicianOnJob: "Team lead" },
    actor: { contractorOrganizationId: id(5), contractorAccessLevel: "report_only", canLeadTeam: true }, isManager: false,
    doAssignPortalTechnician: async (...args: unknown[]) => calls.push(args), doSetTechnician: async () => undefined };
  const tree = h.render("default", props);
  const picker = nodes(tree).find(node => node.type === "DirectorySelect")!;
  assert.equal(picker.props.domain, "legacy_team");
  await (picker.props.onChange as (event: unknown, item: unknown) => Promise<void>)(
    { target: { value: id(7) } }, { id: id(7), name: "Crew technician" },
  );
  assert.deepEqual(calls, [["WOT-SYNTHETIC", id(7), "Crew technician"]]);
  h.close();
});
