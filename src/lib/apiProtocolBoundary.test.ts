import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { apiNotFound, createApiMethodBoundary } from "./server/apiMethodBoundary";
import { validCorrelationId } from "./observability/correlationId";
import * as unmatched from "../app/api/[[...unmatched]]/route";

test("405 advertises only the original closed method set including implicit HEAD and OPTIONS", () => {
  for (const [methods, expected] of [[ ["POST"], "OPTIONS, POST" ],
    [ ["GET", "POST", "PATCH", "DELETE"], "DELETE, GET, HEAD, OPTIONS, PATCH, POST" ]] as const) {
    const boundary = createApiMethodBoundary("/api/synthetic", methods);
    const request = new Request("https://synthetic.invalid/api/synthetic", { method: "PUT", headers: { "Access-Control-Request-Method": "TRACE" } });
    const denied = boundary.methodNotAllowed(request);
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get("Allow"), expected);
    assert.equal(denied.headers.get("Allow"), boundary.OPTIONS(request).headers.get("Allow"));
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(denied.headers.get("Access-Control-Allow-Methods"), null);
  }
});

test("OPTIONS, unsupported methods and unknown API requests never touch a hanging body", async () => {
  const protocol = createApiMethodBoundary("/api/invoice-pdf/parse-total", ["POST"]);
  for (const handler of [protocol.OPTIONS, protocol.methodNotAllowed, apiNotFound]) {
    let pulls = 0; let cancels = 0;
    const body = new ReadableStream({ pull() { pulls++; }, cancel() { cancels++; } }, { highWaterMark: 0 });
    const request = new Request("https://synthetic.invalid/api/private-path?token=private", { method: "POST", body, duplex: "half" } as RequestInit);
    for (const key of ["body", "json", "text", "formData", "arrayBuffer"]) Object.defineProperty(request, key, {
      get: () => { throw new Error("Request body must remain inaccessible to metadata-only handlers"); },
    });
    const response = handler(request);
    assert.ok([204, 404, 405].includes(response.status));
    await Promise.resolve(); assert.equal(pulls, 0); assert.equal(cancels, 0);
    assert.doesNotMatch(await response.text(), /private|token|path/);
  }
});

test("protocol response identities are normalized and malformed values cannot be reflected", async () => {
  const boundary = createApiMethodBoundary("/api/synthetic", ["GET"]);
  for (const value of ["INVALID PRIVATE VALUE", "a".repeat(8_192), "11111111-1111-4111-8111-111111111111", "ABCDEFAB-CDEF-4BCD-8ABC-ABCDEFABCDEF"]) {
    for (const handler of [boundary.OPTIONS, boundary.methodNotAllowed, apiNotFound]) {
      const response = handler(new Request("https://synthetic.invalid/api/unknown", { headers: { "X-Request-ID": value } }));
      const id = response.headers.get("X-Request-ID"); assert.ok(validCorrelationId(id));
      if (validCorrelationId(value)) assert.equal(id, value.toLowerCase());
      assert.doesNotMatch(await response.text(), /INVALID PRIVATE VALUE|a{100}/);
    }
  }
});

test("optional API catch-all covers root and unknown paths without shadowing any existing route", () => {
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(`${path}/${entry.name}`) : entry.name === "route.ts" ? [`${path}/route.ts`] : []);
  const routes = walk("src/app/api").map(path => path.replace("src/app", "").replace("/route.ts", ""));
  assert.equal(routes.length, 26);
  const sorted = getSortedRoutes(routes);
  for (const path of routes.filter(route => !route.includes("["))) assert.equal(sorted.find(route => getRouteRegex(route).re.test(path)), path);
  for (const path of ["/api", "/api/nonexistent", "/api/nonexistent/private-path", "/api/notifications/unknown", "/api/%3Cscript%3E"]) {
    assert.equal(sorted.find(route => getRouteRegex(route).re.test(path)), "/api/[[...unmatched]]");
  }
  assert.ok(!getRouteRegex("/api/[[...unmatched]]").re.test("/dashboard"));
});

test("all unmatched API standard methods use one bounded safe404 contract without logs or body access", async () => {
  let logs = 0; const original = console.info; console.info = () => { logs++; };
  try {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const) {
      assert.equal(unmatched[method], apiNotFound);
      const response = unmatched[method](new Request("https://synthetic.invalid/api/private%3Cscript%3E?credential=private", { method }));
      assert.equal(response.status, 404); assert.ok(validCorrelationId(response.headers.get("X-Request-ID")));
      const text = await response.text(); assert.doesNotMatch(text, /private|script|credential/);
      if (method === "HEAD") assert.equal(text, ""); else assert.equal(JSON.parse(text).code, "NOT_FOUND");
    }
    assert.equal(logs, 0);
  } finally { console.info = original; }
  const source = readFileSync("src/lib/server/apiMethodBoundary.ts", "utf8");
  assert.doesNotMatch(source, /request\.(?:url|body|json|text|formData|arrayBuffer)|fetch\(|process\.env|console\./);
});
