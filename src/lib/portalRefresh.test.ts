import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  PORTAL_AUTO_REFRESH_MS,
  shouldRefreshPortal,
} from "./portalRefresh";

test("portal refreshes every few minutes only while it can safely fetch", () => {
  assert.equal(PORTAL_AUTO_REFRESH_MS, 180_000);
  assert.equal(shouldRefreshPortal({
    authenticated: true,
    visible: true,
    online: true,
    busy: false,
  }), true);
  assert.equal(shouldRefreshPortal({
    authenticated: true,
    visible: false,
    online: true,
    busy: false,
  }), false);
  assert.equal(shouldRefreshPortal({
    authenticated: true,
    visible: true,
    online: false,
    busy: false,
  }), false);
  assert.equal(shouldRefreshPortal({
    authenticated: false,
    visible: true,
    online: true,
    busy: false,
  }), false);
  assert.equal(shouldRefreshPortal({
    authenticated: true,
    visible: true,
    online: true,
    busy: true,
  }), false);
});

test("all automatic and manual refresh triggers share one in-flight lock", () => {
  const shell = readFileSync(
    resolve(process.cwd(), "src/components/PortalShell.tsx"),
    "utf8",
  );
  assert.match(shell, /const refreshInFlightRef = useRef\(false\)/);
  assert.match(shell, /busy: refreshInFlightRef\.current/);
  assert.ok(
    shell.indexOf("refreshInFlightRef.current = true")
      < shell.indexOf('await qc.invalidateQueries({ refetchType: "active" })'),
  );
  assert.match(shell, /finally \{[\s\S]*refreshInFlightRef\.current = false/);
});
