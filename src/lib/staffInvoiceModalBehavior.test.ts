import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { financialTestIds } from "./billingFinancialRouteTestHarness";
import { apiFetch } from "./errors/apiFetch";
import { createUnsavedChangesHarness } from "./forms/test-support/unsavedChangesHarness";

type Element = { type: unknown; props: Record<string, unknown> };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== "object" || value === null || !("type" in value) || !("props" in value)) return [];
  const element = value as Element; // JSX-runtime fixture owns this exact shape.
  return [element, ...elements(element.props.children)];
}
const filename = resolve("src/features/billing/BillingInvoiceCreateModal.tsx");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const requireHere = createRequire(import.meta.url);

function harness(save: (body: Record<string, unknown>) => Promise<Response>, validationErrors: Record<string, unknown> = {}) {
  const guardHarness = createUnsavedChangesHarness();
  const states: { index: number; value: unknown }[] = [];
  const stateValues = new Map<number, unknown>();
  const messages: string[] = [];
  const created: unknown[] = [];
  const effects: (() => unknown)[] = [];
  const refs: { current: unknown }[] = [];
  let refIndex = 0, resetCount = 0;
  const data: Record<string, unknown> = { num: "SYNTHETIC", invoiceDate: "2026-09-08", serviceDate: "",
    dueDate: "", workOrderId: "", territory: "Texas", equipmentTag: "7-ELEVEN: Ice", storeNumber: "123",
    storeAddress: "Synthetic address", terms: "Net 30", cme: "", taxState: "TX", salesTaxOverride: 0,
    state: "draft", lines: [{ type: "Labor", desc: "Synthetic work", qty: 1, rate: 10, isTaxable: false }] };
  let stateIndex = 0;
  const queryResult = { data: [], isSuccess: true, isLoading: false };
  const query = new Proxy({}, { get: (_target, key) => key === "then"
    ? (done: (result: unknown) => unknown) => Promise.resolve(done({ data: [], error: null }))
    : () => query });
  const exports: { default?: (props: Record<string, unknown>) => unknown } = {};
  const transport: typeof fetch = async (_url, options) => options?.body
    ? save(JSON.parse(String(options.body))) : Response.json({ num: "SYNTHETIC" });
  runInNewContext(compiled, { exports, console, Date, Promise, Map, Set, crypto: globalThis.crypto,
    setTimeout: () => 1, clearTimeout: () => undefined,
    window: { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout: () => 1, clearTimeout: () => undefined },
    document: { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: "visible" },
    fetch: async (url: string, options?: { body?: string }) => options?.body
      ? save(JSON.parse(options.body)) : Response.json({ num: "SYNTHETIC" }),
    require: (name: string): unknown => {
      if (name.endsWith("/forms/useUnsavedChangesGuard")) return { useUnsavedChangesGuard: guardHarness.useGuard };
      if (name.endsWith("/drafts/browserDraftSession")) return { browserDraftSession: () => null };
      if (name.endsWith("/errors/apiFetch")) return { apiFetch: (input: RequestInfo | URL, init?: RequestInit) => apiFetch(input, init, transport) };
      if (name === "react/jsx-runtime") return {
        jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
        jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
      };
      if (name === "react") return {
        useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
        useId: () => "synthetic-billing-form", useDeferredValue: (value: unknown) => value,
        useRef: (current: unknown) => refs[refIndex++] ??= { current },
        useEffect: (fn: () => unknown) => { effects.push(fn); },
        useState: (initial: unknown) => {
          const index = stateIndex++;
          if (!stateValues.has(index)) stateValues.set(index, typeof initial === "function" ? (initial as () => unknown)() : initial);
          return [stateValues.get(index), (value: unknown) => {
            const next = typeof value === "function"
              ? (value as (current: unknown) => unknown)(stateValues.get(index))
              : value;
            stateValues.set(index, next);
            states.push({ index, value: next });
          }];
        },
      };
      if (name === "react-hook-form") return {
        useForm: () => ({ register: (name: string) => ({ name }), control: {}, formState: { errors: validationErrors },
          handleSubmit: (fn: (value: Record<string, unknown>) => unknown) => () => fn(data),
          watch: (key: unknown) => typeof key === "string" ? data[key] : { unsubscribe: () => undefined },
          getValues: (key?: string) => key ? data[key] : data, reset: () => { resetCount++; },
          setValue: () => undefined, clearErrors: () => undefined, trigger: async () => true,
        }),
        useFieldArray: () => ({ fields: [{ id: "synthetic-line", type: "Labor", desc: "Synthetic work", qty: 1, rate: 10 }], replace: () => undefined, append: () => undefined, remove: () => undefined, move: () => undefined }),
      };
      if (name === "@hookform/resolvers/zod") return { zodResolver: () => undefined };
      if (name === "@tanstack/react-query") return { useQuery: () => queryResult };
      if (name.endsWith("/queries")) return new Proxy({}, { get: (_target, key: string) => () => ({ ...queryResult,
        data: key.includes("Page") ? { items: [] } : key.includes("ById") || key.includes("Details") ? null : [],
      }) });
      if (name.endsWith("/supabase/client")) return { supabase: () => ({ from: () => query,
        auth: { getSession: async () => ({ data: { session: { access_token: "synthetic", user: { id: financialTestIds.actor } } } }) },
      }) };
      if (name.endsWith("/db")) return { loadAllWorkOrderVisits: async () => [] };
      if (name.endsWith("/useInvoiceDocumentAction")) return { useInvoiceDocumentAction: () => async () => { throw new Error("Source hydration is not used by this existing-document save fixture"); } };
      if (name.includes("/components/ui/")) return new Proxy({}, { get: (_target, key) => key });
      if (name.startsWith("./")) return { default: name };
      if (!name.startsWith(".")) return requireHere(name);
      return requireHere(resolve(filename, "..", name));
    },
  }, { filename });
  assert.ok(exports.default);
  const props = { modal: "createBillingInvoice", editingInvoice: {
    id: financialTestIds.invoice, invoiceVersion: 3, assignmentVersion: null, workflowCycle: null,
    num: "SYNTHETIC", state: "draft", lines: data.lines, invoiceDateRaw: "2026-09-08", salesTax: 0,
  }, currentUser: { id: financialTestIds.actor, role: "manager" }, fmt: String,
    fire: (message: string) => messages.push(message), onCreated: (invoice: unknown) => created.push(invoice) };
  const component = exports.default;
  component(props);
  for (const effect of effects) effect();
  // The financial-version effect intentionally enables writes on a following
  // render. Preserve state slots so this VM fixture observes that render too.
  stateIndex = 0;
  refIndex = 0;
  const tree = component(props);
  const nodes = elements(tree);
  const form = nodes.find(node => node.type === "form");
  assert.ok(form && typeof form.props.onSubmit === "function");
  return { submit: form.props.onSubmit, nodes, states, messages, created, data, resetCount: () => resetCount,
    changeContext: (change: Record<string, unknown>) => { stateIndex = 0; refIndex = 0; return component({ ...props, ...change }); } };
}

test("billing editor keeps modal protection, versioned request, success handoff and loading feedback", async () => {
  const requests: Record<string, unknown>[] = [];
  const h = harness(async body => { requests.push(body); return Response.json({ invoice: { id: financialTestIds.invoice, num: "SYNTHETIC" } }); });
  assert.ok(h.nodes.some(node => node.props.closeOnBackdrop === false));
  await h.submit();
  assert.equal(requests.length, 1, h.messages.join("; "));
  assert.equal(requests[0].expectedInvoiceVersion, 3);
  assert.equal(requests[0].expectedAssignmentVersion, null);
  assert.ok(typeof requests[0].operationId === "string");
  assert.deepEqual(h.states.filter(state => state.index === 0).map(state => state.value), [true, false]);
  assert.ok(h.messages.includes("Invoice #SYNTHETIC ready for 7-Eleven"));
  assert.equal(h.created.length, 1);
});
test("accepted old billing response cannot reset or announce into a changed account or reopened form", async () => {
  for (const transition of ["account", "reopen"] as const) {
    let finish: () => void = () => undefined; const wait = new Promise<void>(resolve => { finish = resolve; });
    const h = harness(async () => { await wait; return Response.json({ invoice: { id: financialTestIds.invoice, num: "SYNTHETIC" } }); });
    const submitting = h.submit(); await new Promise(resolve => setImmediate(resolve));
    const before = h.resetCount();
    if (transition === "account") h.changeContext({ currentUser: { id: "00000000-0000-4000-8000-000000000001", role: "manager" } });
    else { h.changeContext({ modal: null }); h.changeContext({ modal: "createBillingInvoice" }); }
    finish(); await submitting;
    assert.equal(h.created.length, 0); assert.equal(h.resetCount(), before);
    assert.equal(h.messages.some(message => message.includes("ready for 7-Eleven") || message.includes("failed:")), false);
  }
});
test("billing header selectors/search have accessible names and controls are grouped for pending writes", () => {
  const h = harness(async () => Response.json({ invoice: { id: financialTestIds.invoice } }));
  for (const label of ["Search work order", "Invoice work order", "Invoice territory", "QuickBooks equipment tag", "Invoice payment terms", "Line 1 type", "Line 1 description", "Line 1 quantity", "Line 1 rate"]) {
    assert.ok(h.nodes.some(node => node.props["aria-label"] === label), label);
  }
  assert.ok(h.nodes.some(node => node.type === "fieldset" && "disabled" in node.props));
  assert.ok(h.nodes.some(node => node.props.name === "invoiceDate" && node.props["aria-required"] === "true"));
});
test("billing required header and line errors are programmatically linked to the relevant controls", () => {
  const h = harness(async () => Response.json({}), { invoiceDate: { message: "Required synthetic date" }, storeNumber: { message: "Required synthetic store" },
    lines: [{ qty: { message: "Required synthetic quantity" }, desc: { message: "Required synthetic description" } }] });
  for (const name of ["invoiceDate", "storeNumber", "lines.0.qty", "lines.0.desc"]) {
    const control = h.nodes.find(node => node.props.name === name); assert.ok(control); assert.equal(control.props["aria-invalid"], true);
    const describedBy = control.props["aria-describedby"]; assert.equal(typeof describedBy, "string");
    assert.ok(h.nodes.some(node => node.props.id === describedBy && node.props.role === "alert"));
  }
});
test("billing editor does not send a second concurrent request and retains identity after response loss", async () => {
  const requests: Record<string, unknown>[] = [];
  let finish: () => void = () => undefined;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const h = harness(async body => { requests.push(body); await wait; throw new Error("Synthetic lost response"); });
  const first = h.submit();
  await h.submit();
  finish(); await first;
  await h.submit();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].operationId, requests[1].operationId);
  assert.equal(h.created.length, 0);
  assert.ok(h.messages.some(message => message.startsWith("Billing invoice update failed:")));
});
