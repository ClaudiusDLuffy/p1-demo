import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { QueryClient, type InvalidateQueryFilters } from "@tanstack/react-query";
import { directoryScopeKey } from "../features/directory/contracts";
import { createUnsavedChangesHarness } from "./forms/test-support/unsavedChangesHarness";

type Element = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value) || !("type" in value)) return [];
  const node = value as Element;
  if (typeof node.type === "function") return nodes(node.type(node.props));
  return [node, ...nodes(node.props.children)];
}
const company = "70000000-0000-4000-8000-000000000001";
const technician = "70000000-0000-4000-8000-000000000002";
const profile = "70000000-0000-4000-8000-000000000003";
const contact = "70000000-0000-4000-8000-000000000004";
const actor = { id: "70000000-0000-4000-8000-000000000010", role: "manager", active: true, staffPermissions: [] };
const requireHere = createRequire(import.meta.url);
function harness(kind: "contractors" | "contacts") {
  const path = kind === "contractors" ? "src/features/contractors/ContractorList.tsx" : "src/features/contacts/AddressBookModal.tsx";
  const filename = resolve(path); const states: unknown[] = []; let index = 0;
  const reads: { domain: string; enabled: boolean; companyId: unknown }[] = [];
  const details: { domain: string; id: string; companyId: unknown; signal?: AbortSignal }[] = [];
  const mutations: { method: string; body: unknown }[] = []; const invalidations: unknown[] = []; const cleanups: (() => void)[] = [];
  const dismissal = createUnsavedChangesHarness();
  cleanups.push(() => dismissal.unmount());
  let pageError = false;
  const datasets: Record<string, unknown[]> = {
    contractor_directory: [{ id: company, name: "Synthetic contractor", company: "Synthetic company", activeCount: 7, capitalCount: 3, teamActiveCount: 11 }],
    technician_management: [{ id: technician, name: "Synthetic technician", contractorId: company, profileId: profile, isActive: true, profileActive: true, contractorAccessLevel: "invoice" },
      { id: "70000000-0000-4000-8000-000000000005", name: "Synthetic legacy", contractorId: company, profileId: null, isActive: true, profileActive: null }],
    contacts: [{ id: contact, name: "Synthetic contact", company: "Synthetic company", title: "Synthetic title" }],
  };
  const output = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: { default?: (props: Record<string, unknown>) => unknown } = {};
  runInNewContext(output, { exports, Headers, AbortController, AbortSignal,
    require: (name: string): unknown => {
      if (name === "react/jsx-runtime") return { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }) };
      if (name === "react") return {
        useState: (initial: unknown) => { const key = index++; if (!(key in states)) states[key] = initial;
          return [states[key], (next: unknown) => { states[key] = typeof next === "function" ? next(states[key]) : next; }]; },
        useRef: (initial: unknown) => { const key = index++; states[key] ??= { current: initial }; return states[key]; },
        useEffect: (effect: () => () => void) => { cleanups.push(effect()); },
      };
      if (name === "@tanstack/react-query") return { useQueryClient: () => ({ invalidateQueries: async (value: unknown) => { invalidations.push(value); } }) };
      if (name.endsWith("/forms/useUnsavedChangesGuard")) return { useUnsavedChangesGuard: dismissal.useGuard };
      if (name.endsWith("/directory/queries")) return {
        useDirectoryActor: () => actor,
        useDirectoryPage: (domain: string, enabled: boolean, companyId: unknown = null) => {
          reads.push({ domain, enabled, companyId }); return { items: datasets[domain], search: "", setSearch: () => undefined,
            position: { page: 1 }, waiting: false, isError: pageError, refetch: () => undefined };
        },
        useDirectorySelection: (domain: string, id: string, companyId: unknown, enabled: boolean) => {
          if (enabled) details.push({ domain, id, companyId });
          return { data: enabled ? { id, name: "Synthetic contact", email: "contact@example.invalid", phone: "+15555550123" } : null,
            isFetching: false, isError: false, refetch: () => undefined };
        },
      };
      if (name.endsWith("/directory/api")) return { loadDirectorySelection: async (domain: string, id: string, companyId: unknown, signal: AbortSignal) => {
        details.push({ domain, id, companyId, signal }); return { id, name: "Synthetic exact technician", profileId: profile,
          contractorId: company, email: "technician@example.invalid", phone: "+15555550124", contractorAccessLevel: "invoice" };
      } };
      if (name.endsWith("/directory/DirectorySelect")) return { DirectoryError: "DirectoryError", DirectoryPageControls: "DirectoryPageControls" };
      if (name.endsWith("/work-orders/queries")) return { WORK_ORDERS_KEY: ["work-orders"] };
      if (name.endsWith("/supabase/client")) return { supabase: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "synthetic" } } }) } }) };
      if (name.endsWith("/errors/apiFetch")) return { apiFetch: async (_path: string, options: RequestInit) => {
        mutations.push({ method: options.method || "GET", body: JSON.parse(String(options.body)) });
        return Response.json({ emailDelivery: "none", technician: { contractorId: company, profileId: profile } });
      } };
      if (name.endsWith("/ui/Modal")) return { Modal: "Modal" };
      if (name.endsWith("/ui/Avatar")) return { Avatar: "Avatar" };
      return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
    },
  }, { filename });
  assert.ok(exports.default); const component = exports.default;
  const render = (props: Record<string, unknown> = {}) => { index = 0; return nodes(component(kind === "contractors"
    ? { page: "contractors", isManager: true, nav: () => undefined, setFilterC: () => undefined, ...props }
    : { open: true, onClose: () => undefined, ...props })); };
  const button = (tree: Element[], label: string) => { const result = tree.find(node => node.type === "button" && node.props.children === label); assert.ok(result); return result.props.onClick as () => unknown; };
  return { render, button, reads, details, mutations, invalidations, cleanups, fail: () => { pageError = true; } };
}

test("contractor cards fetch only the active directory page and expanded company team", async () => {
  const h = harness("contractors"); h.render({ page: "dashboard" }); assert.equal(h.reads[0].enabled, false);
  let tree = h.render(); assert.ok(h.reads.every(read => read.domain === "contractor_directory"));
  assert.ok(tree.some(node => node.props.children === 11), "Card count comes from the server aggregate, not current team page length");
  h.button(tree, "View technicians")(); tree = h.render();
  assert.ok(h.reads.some(read => read.domain === "technician_management" && read.companyId === company));
  assert.ok(tree.some(node => node.props.children === "Legacy record")); assert.equal(h.details.length, 0);
  await h.button(tree, "Edit")(); tree = h.render();
  assert.equal(h.details[0].domain, "technician_detail"); assert.equal(h.details[0].id, technician); assert.equal(h.details[0].companyId, company);
  assert.ok(tree.some(node => node.type === "input" && node.props.value === "technician@example.invalid" && node.props.readOnly === true));
  const form = tree.find(node => node.type === "form"); assert.ok(form);
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined });
  assert.equal(h.mutations[0].method, "POST"); assert.equal((h.mutations[0].body as { profileId: string }).profileId, profile);
  const invalidation = h.invalidations.find(value => value && typeof value === "object" && "predicate" in value);
  assert.ok(invalidation && typeof invalidation === "object" && "queryKey" in invalidation);
  assert.deepEqual(JSON.parse(JSON.stringify(invalidation.queryKey)), ["directory", directoryScopeKey(actor)]);
  tree = h.render(); h.button(tree, "Remove")(); tree = h.render(); await h.button(tree, "Deactivate access")();
  assert.deepEqual(h.mutations[1], { method: "DELETE", body: { profileId: profile } });
  for (const cleanup of h.cleanups) cleanup(); assert.ok(h.details[0].signal?.aborted);
  h.fail(); tree = h.render(); assert.ok(!tree.some(node => node.props.children === "View technicians"));
});
test("technician changes invalidate only current-actor relevant pages and the affected company/profile", async () => {
  const h = harness("contractors"); let tree = h.render();
  h.button(tree, "View technicians")(); tree = h.render(); await h.button(tree, "Edit")(); tree = h.render();
  const form = tree.find(node => node.type === "form"); assert.ok(form);
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined });
  const invalidation = h.invalidations.find(value => value && typeof value === "object" && "predicate" in value);
  assert.ok(invalidation && typeof invalidation === "object" && "predicate" in invalidation && typeof invalidation.predicate === "function");
  const affected = invalidation.predicate as (query: { queryKey: unknown[] }) => boolean;
  const scope = directoryScopeKey(actor); const otherScope = directoryScopeKey({ ...actor, id: contact });
  const pageKey = (domain: string, companyId: string | null = null, owner: unknown = scope) => ["directory", owner, "page", domain, companyId, "", 25, null, true, 0];
  const exactKey = (domain: string, companyId: string | null, id: string, owner: unknown = scope) => ["directory", owner, "selection", domain, companyId, id, true];
  const affectedKeys = [pageKey("contractor_directory"), pageKey("contacts"), pageKey("contractor_filter"),
    pageKey("technician_management", company), pageKey("company_technicians", company),
    exactKey("technician_detail", company, technician), exactKey("technician_profile", company, profile),
    exactKey("contact_detail", null, profile), exactKey("profile_labels", null, profile),
    ["directory", scope, "labels", [profile, contact], true]];
  const unaffectedKeys = [pageKey("technician_management", contact), pageKey("company_technicians", contact),
    pageKey("staff_choices"), pageKey("assignable_contractors"), pageKey("legacy_team"),
    exactKey("technician_detail", contact, technician), exactKey("profile_labels", null, contact),
    ["directory", scope, "labels", [contact], true], pageKey("contacts", null, otherScope),
    pageKey("technician_management", company, otherScope), exactKey("contact_detail", null, profile, otherScope)];
  for (const queryKey of affectedKeys) assert.equal(affected({ queryKey }), true);
  for (const queryKey of unaffectedKeys) {
    assert.equal(affected({ queryKey }), false, "No unrelated actor/company/family read is invalidated");
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  try {
    for (const queryKey of [...affectedKeys, ...unaffectedKeys]) queryClient.setQueryData(queryKey, { synthetic: true });
    await queryClient.invalidateQueries(invalidation as InvalidateQueryFilters);
    for (const queryKey of affectedKeys) assert.equal(queryClient.getQueryState(queryKey)?.isInvalidated, true);
    for (const queryKey of unaffectedKeys) assert.equal(queryClient.getQueryState(queryKey)?.isInvalidated, false);
  } finally { queryClient.clear(); }
  assert.ok(!h.invalidations.some(value => JSON.stringify(value) === '{"queryKey":["work-orders"]}'), "A technician edit must not refresh unrelated work-order pages");
});
test("address book is closed-lazy, pages summaries, and loads only explicitly expanded contact details", () => {
  const h = harness("contacts"); assert.deepEqual(h.render({ open: false }), []); assert.equal(h.reads[0].enabled, false);
  let tree = h.render(); assert.equal(h.details.length, 0); assert.ok(!tree.some(node => node.type === "a"));
  assert.ok(h.reads.every(read => read.domain === "contacts"));
  h.button(tree, "View contact")(); tree = h.render();
  assert.deepEqual(h.details[0], { domain: "contact_detail", id: contact, companyId: null });
  assert.ok(tree.some(node => node.props.href === "mailto:contact@example.invalid"));
  assert.ok(tree.some(node => node.props.href === "tel:+15555550123"));
  h.button(tree, "Hide contact")(); tree = h.render(); assert.ok(!tree.some(node => node.type === "a"));
  h.fail(); tree = h.render(); assert.ok(!tree.some(node => node.props.children === "View contact"));
});
