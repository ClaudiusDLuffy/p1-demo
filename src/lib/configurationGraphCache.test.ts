import assert from "node:assert/strict";
import test from "node:test";
import { getAccessToken } from "./graphClient";
import { ConfigurationError } from "./config/shared";

test("Graph token cache is bound to current tenant/client credentials and cannot mask missing config", async () => {
  const values = { NODE_ENV: "test", OUTLOOK_TENANT_ID: "synthetic-cache-tenant", OUTLOOK_CLIENT_ID: "synthetic-cache-client", OUTLOOK_CLIENT_SECRET: "synthetic-cache-secret", OUTLOOK_USER_EMAIL: "synthetic@example.invalid" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch; let requests = 0;
  Object.assign(process.env, values);
  globalThis.fetch = async () => { requests++; return Response.json({ access_token: `synthetic-token-${requests}`, expires_in: 3600 }); };
  try {
    assert.equal(await getAccessToken(), "synthetic-token-1");
    assert.equal(await getAccessToken(), "synthetic-token-1"); assert.equal(requests, 1);
    process.env.OUTLOOK_CLIENT_SECRET = "synthetic-rotated-secret";
    assert.equal(await getAccessToken(), "synthetic-token-2"); assert.equal(requests, 2);
    process.env.OUTLOOK_TENANT_ID = "synthetic-other-tenant";
    assert.equal(await getAccessToken(), "synthetic-token-3"); assert.equal(requests, 3);
    delete process.env.OUTLOOK_CLIENT_SECRET;
    await assert.rejects(getAccessToken(), error => error instanceof ConfigurationError && error.code === "CONFIG_INCOMPLETE");
    assert.equal(requests, 3);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(values)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});
