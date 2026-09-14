import assert from "node:assert/strict";
import test from "node:test";
import { authorizeDiagnostic } from "./server/diagnostics/authorization";
import { admitDiagnostic } from "./server/diagnostics/rateLimit";
import { AppError } from "./errors/AppError";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const environment = { NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic", SUPABASE_SECRET_KEY: "sb_secret_synthetic" };
const request = (token: string | null = "Bearer synthetic-token", signal?: AbortSignal) => new Request("https://portal.example.invalid/api/client-errors", {
  headers: token ? { Authorization: token } : {}, signal,
});
const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;
function transport(profile: unknown, identity: unknown = { id }): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
    assert.equal(headers.get("authorization"), "Bearer synthetic-token");
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    if (url.pathname === "/auth/v1/user") return Response.json(identity);
    assert.equal(url.pathname, "/rest/v1/profiles");
    assert.equal(url.searchParams.get("select"), "id,active");
    assert.equal(url.searchParams.get("id"), `eq.${id}`); assert.equal(url.searchParams.get("limit"), "1");
    return Response.json(profile);
  };
}
for (const role of ["manager", "dispatcher", "back_office", "invoice_controller", "contractor", "company_admin", "technician", "report_only"]) {
  test(`active ${role} may report only after current Auth identity and profile validation`, async () => {
    assert.equal(await authorizeDiagnostic(request(), transport([{ id, active: true, role }]), { environment }), id);
    await assert.rejects(authorizeDiagnostic(request(), transport([{ id, active: false, role }]), { environment }), code("ACCOUNT_INACTIVE"));
  });
}
for (const token of [null, "Basic synthetic", "Bearer two tokens", `Bearer ${"x".repeat(8193)}`]) {
  test("missing or malformed diagnostic bearer is denied before configuration or network", async () => {
    let fetched = 0;
    await assert.rejects(authorizeDiagnostic(request(token), async () => { fetched++; return Response.json({}); }, { environment: {} }), code("AUTH_REQUIRED"));
    assert.equal(fetched, 0);
  });
}
for (const profile of [[], [{ id: other, active: true }], [{ id, active: null }], [{ id, active: true }, { id: other, active: true }]]) {
  test("missing, mismatched, malformed or multiple profile rows fail closed", async () => {
    await assert.rejects(authorizeDiagnostic(request(), transport(profile), { environment }), code("FORBIDDEN"));
  });
}
test("forged role claims cannot replace a valid current Auth identity", async () => {
  await assert.rejects(authorizeDiagnostic(request(), transport([{ id, active: true }], { role: "manager", sub: id }), { environment }), code("AUTH_INVALID"));
});
test("auth rejection and provider/database failures have safe distinct outcomes", async () => {
  for (const [status, expected] of [[401, "AUTH_INVALID"], [500, "PROVIDER_UNAVAILABLE"], [429, "PROVIDER_UNAVAILABLE"]] as const) {
    await assert.rejects(authorizeDiagnostic(request(), async () => new Response("synthetic-private-provider-body", { status }), { environment }), code(expected));
  }
  await assert.rejects(authorizeDiagnostic(request(), async () => { throw new Error("synthetic-token private network error"); }, { environment }), code("PROVIDER_UNAVAILABLE"));
});
test("authorization caps actual response bytes irrespective of content-length", async () => {
  for (const headers of [new Headers(), new Headers({ "Content-Length": "1" })]) {
    await assert.rejects(authorizeDiagnostic(request(), async () => new Response(JSON.stringify({ id }).padEnd(16_385, " "), { headers }), { environment }), code("AUTH_INVALID"));
  }
});
test("authorization has a total deadline even when fetch ignores cancellation", async () => {
  let observed: AbortSignal | null | undefined;
  await assert.rejects(authorizeDiagnostic(request(), async (_url, init) => { observed = init?.signal; return new Promise<Response>(() => undefined); },
    { environment, timeoutMs: 10 }), code("AUTH_TIMEOUT"));
  assert.equal(observed?.aborted, true);
});
test("authorization bounds a stalled response body and honors an already aborted request", async () => {
  const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => new Promise(() => undefined) });
  await assert.rejects(authorizeDiagnostic(request(), async () => new Response(stream), { environment, timeoutMs: 10 }), code("AUTH_TIMEOUT"));
  let fetched = 0;
  await assert.rejects(authorizeDiagnostic(request("Bearer synthetic-token", AbortSignal.abort()), async () => { fetched++; return Response.json({}); }, { environment }), code("REQUEST_ABORTED"));
  assert.equal(fetched, 0);
});
test("diagnostic admission uses only the verified profile and service RPC with bounded receipt", async () => {
  const result = await admitDiagnostic(id, new AbortController().signal, async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/rest/v1/rpc/consume_client_diagnostic_rate_limit_v1");
    assert.deepEqual(JSON.parse(String(init?.body)), { p_profile_id: id });
    assert.equal(new Headers(init?.headers).get("apikey"), environment.SUPABASE_SECRET_KEY);
    return Response.json({ allowed: false, retryAfterSeconds: 60 });
  }, { environment });
  assert.deepEqual(result, { allowed: false, retryAfterSeconds: 60 });
});
test("rate limiter fails closed for malformed, oversized and unavailable database receipts", async () => {
  for (const payload of ["broken", JSON.stringify({ allowed: true, retryAfterSeconds: 61 }), JSON.stringify({ allowed: "true", retryAfterSeconds: 0 }), JSON.stringify({ allowed: true, retryAfterSeconds: 0 }).padEnd(1025, " ")]) {
    await assert.rejects(admitDiagnostic(id, new AbortController().signal, async () => new Response(payload, { headers: { "Content-Length": "1" } }), { environment }), code("PROVIDER_UNAVAILABLE"));
  }
  await assert.rejects(admitDiagnostic(id, new AbortController().signal, async () => new Response("synthetic-private-error", { status: 503 }), { environment }), code("PROVIDER_UNAVAILABLE"));
  await assert.rejects(admitDiagnostic(id, new AbortController().signal, async () => new Response(null, { status: 403 }), { environment }), code("ACCOUNT_INACTIVE"));
});
test("rate limiter bounds ignored abort and stalled body; it never admits on uncertainty", async () => {
  let observed: AbortSignal | null | undefined;
  await assert.rejects(admitDiagnostic(id, new AbortController().signal, async (_input, init) => { observed = init?.signal; return new Promise<Response>(() => undefined); }, { environment, timeoutMs: 10 }), code("PROVIDER_UNAVAILABLE"));
  assert.equal(observed?.aborted, true);
  await assert.rejects(admitDiagnostic(id, new AbortController().signal, async () => new Response(new ReadableStream({ pull: () => new Promise(() => undefined) })), { environment, timeoutMs: 10 }), code("PROVIDER_UNAVAILABLE"));
});
test("invalid profile and cancelled admission make no service request", async () => {
  let fetched = 0; const send: typeof fetch = async () => { fetched++; return Response.json({ allowed: true, retryAfterSeconds: 0 }); };
  await assert.rejects(admitDiagnostic("invalid", new AbortController().signal, send, { environment }), code("AUTH_INVALID"));
  await assert.rejects(admitDiagnostic(id, AbortSignal.abort(), send, { environment }), code("REQUEST_ABORTED"));
  assert.equal(fetched, 0);
});
