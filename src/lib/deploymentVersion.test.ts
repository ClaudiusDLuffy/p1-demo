import assert from "node:assert/strict";
import test from "node:test";
import {
  deploymentChanged,
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
