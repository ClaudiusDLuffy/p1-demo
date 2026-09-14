import assert from "node:assert/strict";
import test from "node:test";
import { createTwilioPartsSms, TWILIO_SEND_TIMEOUT_MS, TWILIO_STATUS_TIMEOUT_MS,
  type TwilioPartsSmsConfiguration } from "./server/twilioPartsSms";

const sid = `SM${"1".repeat(32)}`;
const configuration: TwilioPartsSmsConfiguration = {
  accountSid: `AC${"0".repeat(32)}`, username: `AC${"0".repeat(32)}`,
  password: "synthetic-secret", messagingServiceSid: `MG${"0".repeat(32)}`, from: "",
};
const input = { phoneE164: "+12025550123", body: "Synthetic parts alert" };
const provider = (fetcher: typeof fetch, timeout = 30) => createTwilioPartsSms(configuration,
  { fetch: fetcher, sendTimeoutMs: timeout, statusTimeoutMs: timeout });

test("parts SMS provider deadlines are named and below the route budget", () => {
  assert.equal(TWILIO_SEND_TIMEOUT_MS, 10_000);
  assert.equal(TWILIO_STATUS_TIMEOUT_MS, 5_000);
});
test("Twilio creation requires 201 and a valid SID; acceptance is not delivered", async () => {
  const adapter = provider(async (_url, init) => {
    assert.equal(init?.method, "POST"); assert.ok(init?.signal);
    assert.equal(new URLSearchParams(String(init?.body)).get("Body"), input.body);
    return Response.json({ sid, status: "queued", body: "Discard this provider content" }, { status: 201 });
  });
  assert.deepEqual(await adapter.send(input), { status: "accepted", sid, providerStatus: "queued" });
});
test("Twilio timeout after acceptance aborts request and quarantines the unknown outcome", async () => {
  let accepted = 0; let signal: AbortSignal | null | undefined;
  const adapter = provider(async (_url, init) => {
    accepted++; signal = init?.signal;
    return new Promise<Response>(() => undefined);
  });
  const outcome = await adapter.send(input);
  assert.equal(accepted, 1); assert.ok(signal?.aborted);
  assert.deepEqual(outcome, { status: "unknown", code: "TWILIO_UNKNOWN" });
});
test("Twilio body parsing shares the request deadline", async () => {
  let cancelled = false;
  const adapter = provider(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"sid":')); },
    cancel() { cancelled = true; },
  }), { status: 201 }));
  assert.equal((await adapter.send(input)).status, "unknown");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});
for (const payload of [{}, { sid: "invalid" }, { sid: 123 }, null]) {
  test(`Twilio invalid SID shape ${JSON.stringify(payload)} remains unknown`, async () => {
    assert.equal((await provider(async () => Response.json(payload, { status: 201 })).send(input)).status, "unknown");
  });
}
for (const status of [200, 202, 400, 401, 404, 408, 429, 500, 503]) {
  test(`unverified Twilio HTTP ${status} does not establish safe retry or delivery`, async () => {
    const adapter = provider(async () => Response.json({ message: "synthetic-secret", status }, { status }));
    assert.deepEqual(await adapter.send(input), { status: "unknown", code: "TWILIO_RESPONSE_UNCONFIRMED" });
  });
}
test("Twilio malformed, oversized and disconnected responses are unknown without leaking content", async () => {
  for (const fetcher of [
    async () => new Response("not-json", { status: 201 }),
    async () => new Response("x".repeat(17_000), { status: 201 }),
    async () => { throw new Error(`${input.phoneE164} synthetic-secret ${input.body}`); },
  ]) {
    const result = await provider(fetcher).send(input);
    assert.equal(result.status, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|202555|Synthetic parts|not-json/);
  }
});
test("local invalid input and missing configuration fail before any network request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("Unexpected network"); };
  assert.equal((await createTwilioPartsSms(null, { fetch: fetcher }).send(input)).status, "known_unsent_terminal");
  assert.equal((await provider(fetcher).send({ ...input, phoneE164: "invalid" })).status, "known_unsent_terminal");
  assert.equal((await provider(fetcher).send({ ...input, body: "x".repeat(1501) })).status, "known_unsent_terminal");
  assert.equal(calls, 0);
});
test("already cancelled send is provably unsent; mid-request cancellation is unknown", async () => {
  const cancelled = new AbortController(); cancelled.abort(); let calls = 0;
  const adapter = provider(async () => { calls++; return new Promise<Response>(() => undefined); });
  assert.equal((await adapter.send(input, cancelled.signal)).status, "known_unsent_retryable");
  assert.equal(calls, 0);
  const active = new AbortController(); const pending = adapter.send(input, active.signal); active.abort();
  assert.equal((await pending).status, "unknown"); assert.equal(calls, 1);
});
for (const status of ["accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed"] as const) {
  test(`Twilio status ${status} is observed through GET, never another send`, async () => {
    const adapter = provider(async (url, init) => {
      assert.equal(init?.method, "GET"); assert.ok(String(url).endsWith(`/Messages/${sid}.json`));
      return Response.json({ sid, status, to: input.phoneE164, body: input.body });
    });
    assert.deepEqual(await adapter.lookup(sid), { status: "observed", providerStatus: status });
  });
}
test("Twilio status failure cannot infer delivery, failure or a resend", async () => {
  for (const fetcher of [
    async () => Response.json({ sid, status: "unrecognized" }),
    async () => Response.json({ sid: `SM${"2".repeat(32)}`, status: "delivered" }),
    async () => Response.json({ sid, status: "delivered" }, { status: 404 }),
    async () => new Response(null, { status: 503 }),
    async () => new Response("malformed"),
    async () => new Promise<Response>(() => undefined),
  ]) assert.equal((await provider(fetcher).lookup(sid)).status, "unavailable");
});
test("Twilio SID cannot be used as an arbitrary URL/path", async () => {
  let calls = 0;
  const adapter = provider(async () => { calls++; throw new Error("Unexpected"); });
  assert.equal((await adapter.lookup("../../Messages")).status, "unavailable");
  assert.equal(calls, 0);
});
