import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { sanitizeDiagnosticDetails } from "./clientDiagnostics";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("diagnostic details retain only bounded primitive fields", () => {
  assert.deepEqual(sanitizeDiagnosticDetails({
    count: 4,
    empty: false,
    scope: "x".repeat(250),
    nullable: null,
    "bad key": "discarded",
    infinite: Number.POSITIVE_INFINITY,
  }), {
    count: 4,
    empty: false,
    scope: "x".repeat(200),
    nullable: null,
  });
});

test("the diagnostic route revalidates levels and structured details", () => {
  const route = read("src/app/api/client-errors/route.ts");
  assert.match(route, /body\.level\s*===\s*"info"/);
  assert.match(route, /body\.level\s*===\s*"warning"/);
  assert.match(route, /details:\s*diagnosticDetails\(body\.details\)/);
  assert.match(route, /Object\.entries\(value\)\.slice\(0, 20\)/);
  assert.match(route, /console\.info\("P1 client diagnostic"/);
  assert.match(route, /console\.warn\("P1 client diagnostic"/);
  assert.match(route, /console\.error\("P1 client error"/);
});
