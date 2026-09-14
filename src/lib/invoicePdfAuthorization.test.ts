import assert from "node:assert/strict";
import test from "node:test";
import { installSyntheticAppEnvironment } from "./config-test-support/syntheticAppEnvironment";

installSyntheticAppEnvironment();
import { requireInvoicePdfActor } from "./server/invoicePdfAuthorization";
import { InvoicePdfRequestError } from "./server/invoicePdfRequest";

const actorId = "71000000-0000-4000-8000-000000000001";
const companyId = "71000000-0000-4000-8000-000000000002";
const forgedSubject = "71000000-0000-4000-8000-000000000003";
const token = `synthetic.${Buffer.from(JSON.stringify({ sub: forgedSubject, role: "service_role" })).toString("base64url")}.signature`;
const request = (signal?: AbortSignal) => new Request("https://portal.invalid/api/invoice-pdf/parse-total", {
  method: "POST", headers: { Authorization: `Bearer ${token}` }, signal,
});
async function configured<T>(work: () => Promise<T>): Promise<T> {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.supabase.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "synthetic-publishable-key";
  try { return await work(); }
  finally {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = previousKey;
  }
}
function transport(options: { profile?: unknown; scope?: unknown; identity?: unknown; authStatus?: number; profileStatus?: number; scopeStatus?: number } = {}) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    assert.equal(url.origin, "https://synthetic.supabase.invalid");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("apikey"), "synthetic-publishable-key");
    assert.equal(init?.cache, "no-store");
    if (url.pathname === "/auth/v1/user") return Response.json(options.identity ?? { id: actorId }, { status: options.authStatus ?? 200 });
    if (url.pathname === "/rest/v1/profiles") {
      assert.equal(url.searchParams.get("id"), `eq.${actorId}`, "Use verified Auth identity, not the caller's decoded JWT subject");
      assert.equal(url.searchParams.get("select"), "id,active,role");
      assert.equal(url.searchParams.get("limit"), "1");
      return Response.json(options.profile ?? [{ id: actorId, active: true, role: "contractor" }], { status: options.profileStatus ?? 200 });
    }
    assert.equal(url.pathname, "/rest/v1/rpc/get_my_contractor_scope");
    assert.equal(init?.method, "POST"); assert.equal(init?.body, "{}");
    return Response.json(options.scope ?? { canInvoice: true, contractorAccountId: companyId }, { status: options.scopeStatus ?? 200 });
  };
  return { send, calls };
}
const denied = (status: number, code?: string) => (error: unknown) => {
  assert.ok(error instanceof InvoicePdfRequestError); assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  assert.doesNotMatch(error.message, /synthetic-publishable-key|signature|SQL|native|\/private\//);
  return true;
};

test("PDF authorization rejects missing or malformed bearer credentials before network or body consumption", async () => configured(async () => {
  for (const authorization of [null, "", "Basic synthetic", "Bearer one two"]) {
    const h = transport();
    const req = new Request("https://portal.invalid", { method: "POST", body: "untrusted body",
      headers: authorization === null ? {} : { Authorization: authorization } });
    await assert.rejects(requireInvoicePdfActor(req, { fetch: h.send }), denied(401, authorization ? "AUTH_INVALID" : "AUTH_REQUIRED"));
    assert.equal(h.calls.length, 0); assert.equal(req.bodyUsed, false);
  }
}));

test("PDF authorization delegates token verification to Auth and denies an invalid token despite its claimed subject", async () => configured(async () => {
  const h = transport({ authStatus: 401 });
  await assert.rejects(requireInvoicePdfActor(request(), { fetch: h.send }), denied(401, "AUTH_INVALID"));
  assert.equal(h.calls.length, 1);
}));

test("all active staff roles, including invoice controllers, may parse caller-supplied bytes without operational authority", async () => configured(async () => {
  for (const role of ["manager", "dispatcher", "back_office"]) {
    const h = transport({ profile: [{ id: actorId, active: true, role, staffPermissions: ["invoice_controller"] }] });
    assert.deepEqual(await requireInvoicePdfActor(request(), { fetch: h.send }), { id: actorId, role });
    assert.equal(h.calls.length, 2, "This read-only utility does not require contractor invoice scope for staff");
  }
}));

test("inactive, missing, mismatched or malformed current profiles cannot parse PDFs", async () => configured(async () => {
  for (const profile of [[], [{ id: actorId, active: false, role: "contractor" }],
    [{ id: forgedSubject, active: true, role: "contractor" }], [{ id: actorId, active: true, role: "administrator" }],
    [{ id: actorId, active: "true", role: "contractor" }], [{ id: actorId, role: "contractor" }]]) {
    const h = transport({ profile });
    const first = profile[0];
    const inactive = first && "active" in first && first.active === false;
    await assert.rejects(requireInvoicePdfActor(request(), { fetch: h.send }), denied(403, inactive ? "ACCOUNT_INACTIVE" : "FORBIDDEN"));
    assert.equal(h.calls.length, 2);
  }
}));

test("current database invoice capability authorizes contractors; caller role claims do not", async () => configured(async () => {
  const h = transport();
  assert.deepEqual(await requireInvoicePdfActor(request(), { fetch: h.send }), { id: actorId, role: "contractor" });
  assert.deepEqual(h.calls.map(call => call.url.pathname), ["/auth/v1/user", "/rest/v1/profiles", "/rest/v1/rpc/get_my_contractor_scope"]);
  assert.ok(h.calls.every(call => call.init?.signal === h.calls[0].init?.signal), "All authorization stages share one deadline");
}));

test("report-only, inactive-company and malformed invoice capability results are denied", async () => configured(async () => {
  for (const scope of [{ canInvoice: false, contractorAccountId: companyId }, { canInvoice: true, contractorAccountId: null },
    { canInvoice: "true", contractorAccountId: companyId }, { contractorAccountId: companyId }, []]) {
    const h = transport({ scope });
    await assert.rejects(requireInvoicePdfActor(request(), { fetch: h.send }), denied(403));
  }
}));

test("generic invoice capability remains independent of unspecified current, former or other-company parent assignments", async () => configured(async () => {
  // Each result models get_my_contractor_scope's current authoritative answer.
  // No specific work order is supplied: these are not parent-access assertions.
  for (const scenario of ["standalone direct", "company administrator", "current invoice technician", "unassigned invoice technician", "former invoice technician", "other-company invoice actor"]) {
    const h = transport({ scope: { canInvoice: true, contractorAccountId: companyId, scenario } });
    await requireInvoicePdfActor(request(), { fetch: h.send });
    assert.ok(h.calls.every(call => !call.url.pathname.includes("work_orders") && !call.url.pathname.includes("invoices")));
  }
}));

test("provider rejection and unreadable identity responses fail safely without parsing the request body", async () => configured(async () => {
  for (const options of [{ identity: [] }, { identity: { id: "not-a-uuid" } }, { profileStatus: 403 }, { scopeStatus: 403 }]) {
    const h = transport(options);
    await assert.rejects(requireInvoicePdfActor(request(), { fetch: h.send }), (error: unknown) => {
      assert.ok(error instanceof InvoicePdfRequestError); assert.ok([401, 403].includes(error.status)); return true;
    });
  }
  await assert.rejects(requireInvoicePdfActor(request(), { fetch: async () => { throw new Error("SQL /private/synthetic internal"); } }), denied(401));
}));

test("the combined authorization deadline aborts its actual fetch and returns408", async () => configured(async () => {
  let underlyingAborted = false;
  const send: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { underlyingAborted = true; reject(new Error("Aborted provider")); }, { once: true });
  });
  const keepAlive = setTimeout(() => undefined, 100);
  try { await assert.rejects(requireInvoicePdfActor(request(), { fetch: send, timeoutMs: 5 }), denied(408, "AUTH_TIMEOUT")); }
  finally { clearTimeout(keepAlive); }
  assert.equal(underlyingAborted, true);
}));

test("caller abort cancels authorization and pre-aborted requests start no fetch", async () => configured(async () => {
  const controller = new AbortController(); controller.abort();
  const h = transport();
  await assert.rejects(requireInvoicePdfActor(request(controller.signal), { fetch: h.send }), denied(408, "REQUEST_ABORTED"));
  assert.equal(h.calls.length, 0);
}));

test("authorization JSON bodies are bounded and stalled response streams are cancelled", async () => configured(async () => {
  let cancelled = false;
  const send: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  const keepAlive = setTimeout(() => undefined, 100);
  try { await assert.rejects(requireInvoicePdfActor(request(), { fetch: send, timeoutMs: 5 }), denied(408)); }
  finally { clearTimeout(keepAlive); }
  assert.equal(cancelled, true);
  const oversized: typeof fetch = async () => new Response(new Uint8Array(64 * 1024 + 1));
  await assert.rejects(requireInvoicePdfActor(request(), { fetch: oversized }), denied(401));
}));

test("the same Auth-verified credentials cannot bypass inactivity for any supported staff or contractor role", async () => configured(async () => {
  for (const role of ["manager", "dispatcher", "back_office", "contractor"]) {
    const h = transport({ profile: [{ id: actorId, role, active: false }] });
    const req = new Request(request(), { body: "untrusted PDF body" });
    await assert.rejects(requireInvoicePdfActor(req, { fetch: h.send }), denied(403, "ACCOUNT_INACTIVE"));
    assert.equal(req.bodyUsed, false);
    assert.deepEqual(h.calls.map(call => call.url.pathname), ["/auth/v1/user", "/rest/v1/profiles"]);
  }
}));

test("one unchanged token rechecks current database state across deactivation, reactivation, role downgrade and profile removal", async () => configured(async () => {
  // These are injected current Auth/profile responses, not gateway or SQL-policy
  // certification. Every request retains the same bearer token and Auth UID.
  const current: { profile: unknown; scope: unknown } = {
    profile: [], scope: { canInvoice: false, contractorAccountId: companyId },
  };
  const h = transport(current);
  const states: { profile: unknown; expected: "manager" | "ACCOUNT_INACTIVE" | "FORBIDDEN" }[] = [
    { profile: [{ id: actorId, role: "manager", active: true }], expected: "manager" },
    { profile: [{ id: actorId, role: "manager", active: false }], expected: "ACCOUNT_INACTIVE" },
    { profile: [{ id: actorId, role: "manager", active: true }], expected: "manager" },
    { profile: [{ id: actorId, role: "contractor", active: true }], expected: "FORBIDDEN" },
    { profile: [], expected: "FORBIDDEN" },
    { profile: [{ id: actorId, role: "manager", active: true }], expected: "manager" },
  ];
  for (const state of states) {
    current.profile = state.profile;
    const req = new Request(request(), { body: "untrusted PDF body" });
    const count = h.calls.length;
    const pending = requireInvoicePdfActor(req, { fetch: h.send });
    if (state.expected === "manager") assert.deepEqual(await pending, { id: actorId, role: "manager" });
    else await assert.rejects(pending, denied(403, state.expected));
    assert.equal(req.bodyUsed, false);
    assert.deepEqual(h.calls.slice(count, count + 2).map(call => call.url.pathname), ["/auth/v1/user", "/rest/v1/profiles"]);
  }
  assert.equal(h.calls.length, 13);
  assert.equal(h.calls.filter(call => call.url.pathname === "/rest/v1/rpc/get_my_contractor_scope").length, 1,
    "A cached staff decision must not survive the current contractor downgrade");
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred promise has not initialized"); };
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function delayedProfile() {
  const entered = deferred<void>();
  const supplied = deferred<Response>();
  const calls: string[] = [];
  const state: { signal?: AbortSignal | null; aborts: number; supplierObserved: boolean } = { aborts: 0, supplierObserved: false };
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: actorId });
    if (url.pathname === "/rest/v1/profiles") {
      state.signal = init?.signal;
      init?.signal?.addEventListener("abort", () => { state.aborts++; }, { once: true });
      entered.resolve();
      // Deliberately non-cooperative synthetic supplier: observe even a late
      // response, without allowing it to resume a timed-out authorization.
      const response = await supplied.promise; state.supplierObserved = true; return response;
    }
    assert.equal(url.pathname, "/rest/v1/rpc/get_my_contractor_scope");
    return Response.json({ canInvoice: true, contractorAccountId: companyId });
  };
  return { entered, supplied, calls, state, send };
}

test("a profile fetch that never resolves after successful Auth is aborted by the combined deadline before body admission", async () => configured(async () => {
  const h = delayedProfile();
  const req = new Request(request(), { body: "untrusted PDF body" });
  const pending = requireInvoicePdfActor(req, { fetch: h.send, timeoutMs: 20 });
  await h.entered.promise;
  assert.equal(h.state.signal?.aborted, false);
  await assert.rejects(pending, denied(408, "AUTH_TIMEOUT"));
  assert.equal(h.state.signal?.aborted, true); assert.equal(h.state.aborts, 1);
  assert.equal(req.bodyUsed, false); assert.equal(h.state.supplierObserved, false);
  assert.deepEqual(h.calls, ["/auth/v1/user", "/rest/v1/profiles"]);
}));

test("caller abort during an in-flight profile fetch cancels the underlying signal and cannot be reversed by late supplier success", async () => configured(async () => {
  const h = delayedProfile();
  const controller = new AbortController();
  const req = new Request(request(controller.signal), { body: "untrusted PDF body" });
  const pending = requireInvoicePdfActor(req, { fetch: h.send });
  await h.entered.promise;
  assert.equal(h.state.signal?.aborted, false);
  controller.abort(new Error("/private/synthetic internal abort reason"));
  await assert.rejects(pending, denied(408, "REQUEST_ABORTED"));
  const late = Response.json([{ id: actorId, role: "contractor", active: true }]);
  h.supplied.resolve(late);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.state.supplierObserved, true); assert.equal(h.state.aborts, 1);
  assert.equal(late.bodyUsed, false); assert.equal(req.bodyUsed, false);
  assert.deepEqual(h.calls, ["/auth/v1/user", "/rest/v1/profiles"]);
}));

test("profile supplier settlement is usable before its deadline but never restarts capability checks after that deadline", async () => configured(async () => {
  for (const late of [false, true]) {
    const h = delayedProfile();
    const req = new Request(request(), { body: "untrusted PDF body" });
    const pending = requireInvoicePdfActor(req, { fetch: h.send, timeoutMs: late ? 20 : 1000 });
    await h.entered.promise;
    if (late) await assert.rejects(pending, denied(408, "AUTH_TIMEOUT"));
    const supplied = Response.json([{ id: actorId, role: "contractor", active: true }]);
    h.supplied.resolve(supplied);
    if (!late) assert.deepEqual(await pending, { id: actorId, role: "contractor" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.state.supplierObserved, true);
    assert.equal(h.state.aborts, late ? 1 : 0);
    assert.equal(supplied.bodyUsed, !late); assert.equal(req.bodyUsed, false);
    assert.equal(h.calls.length, late ? 2 : 3);
  }
}));
