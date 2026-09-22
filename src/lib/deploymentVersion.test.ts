import assert from "node:assert/strict";
import test from "node:test";
import {
  deploymentChanged,
  deploymentRefreshUrl,
  formatDeploymentUpdatedAt,
  normalizeDeploymentUpdatedAt,
  normalizeDeploymentVersion,
  shortDeploymentVersion,
} from "./deploymentVersion";

test("deployment versions accept only bounded public identifiers", () => {
  assert.equal(normalizeDeploymentVersion(" 0.1.0-beta.1 "), "0.1.0-beta.1");
  for (const invalid of [null, "", "contains spaces", "slash/value", "x".repeat(121)]) {
    assert.equal(normalizeDeploymentVersion(invalid), null);
  }
});

test("deployment comparison fails closed on invalid responses", () => {
  assert.equal(deploymentChanged("0.1.0", "0.1.1"), true);
  assert.equal(deploymentChanged("0.1.0", "0.1.0"), false);
  assert.equal(deploymentChanged("0.1.0", "invalid response"), false);
});

test("display versions preserve package release numbers", () => {
  assert.equal(shortDeploymentVersion("local-development"), "local");
  assert.equal(shortDeploymentVersion("0.1.0"), "0.1.0");
  assert.equal(shortDeploymentVersion("12.34.56"), "12.34.56");
  assert.equal(shortDeploymentVersion("1.2.3-release.10"), "1.2.3-release.10");
});

test("deployment refresh returns to a cache-busted clean portal root", () => {
  assert.equal(
    deploymentRefreshUrl("https://portal.example.test/?view=work_orders&wo=WOT1#photos", "dpl_next-123"),
    "https://portal.example.test/?p1-build=dpl_next-123",
  );
});

test("build timestamps are validated and displayed in Miami time with DST", () => {
  assert.equal(normalizeDeploymentUpdatedAt("not-a-date"), null);
  assert.equal(normalizeDeploymentUpdatedAt("2026-09-19T10:30:00Z"), "2026-09-19T10:30:00.000Z");
  assert.equal(formatDeploymentUpdatedAt("2026-07-15T16:30:00Z"), "Jul 15, 2026, 12:30 PM EDT");
  assert.equal(formatDeploymentUpdatedAt("2026-01-15T16:30:00Z"), "Jan 15, 2026, 11:30 AM EST");
});
