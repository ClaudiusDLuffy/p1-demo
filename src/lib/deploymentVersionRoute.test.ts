import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/version/route";

test("version route returns the current public build without cache reuse", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal(response.headers.get("pragma"), "no-cache");
  const body = await response.json() as { deploymentVersion?: unknown; displayVersion?: unknown; updatedAt?: unknown };
  assert.equal(typeof body.deploymentVersion, "string");
  assert.equal(typeof body.displayVersion, "string");
  assert.ok(body.updatedAt === null || typeof body.updatedAt === "string");
});
