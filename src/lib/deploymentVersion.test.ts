import assert from "node:assert/strict";
import test from "node:test";
import {
  deploymentChanged,
  normalizeDeploymentVersion,
  shortDeploymentVersion,
} from "./deploymentVersion";

test("deployment versions accept only bounded public identifiers", () => {
  assert.equal(normalizeDeploymentVersion(" dpl_ABC-123.test "), "dpl_ABC-123.test");
  for (const invalid of [null, "", "contains spaces", "slash/value", "x".repeat(121)]) {
    assert.equal(normalizeDeploymentVersion(invalid), null);
  }
});

test("deployment comparison fails closed on invalid responses", () => {
  assert.equal(deploymentChanged("dpl_old", "dpl_new"), true);
  assert.equal(deploymentChanged("dpl_old", "dpl_old"), false);
  assert.equal(deploymentChanged("dpl_old", "invalid response"), false);
});

test("display versions stay short without exposing the Vercel prefix", () => {
  assert.equal(shortDeploymentVersion("local-development"), "local");
  assert.equal(shortDeploymentVersion("dpl_1234567890abcdef"), "1234567890");
  assert.equal(shortDeploymentVersion("abcdef1234567890"), "abcdef1234");
});
