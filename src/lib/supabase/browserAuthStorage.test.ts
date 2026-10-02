import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserAuthStorage } from "./browserAuthStorage";

const key = "sb-synthetic-auth-token";
function fixture(remember = true) {
  const maps = [new Map<string, string>(), new Map<string, string>()];
  const stores = maps.map(map => ({ getItem: (name: string) => map.get(name) ?? null,
    setItem: (name: string, value: string) => { map.set(name, value); }, removeItem: (name: string) => { map.delete(name); } }));
  const make = () => createBrowserAuthStorage({ key, stores: () => stores, remember: () => remember });
  return { maps, storage: make(), reload: make };
}

for (const remember of [true, false]) {
  test(`sign-out forgets durable credentials before SDK/network completion (remember=${remember})`, () => {
    const f = fixture(remember);
    f.storage.setItem(key, "synthetic-token");
    f.storage.setItem(`${key}-code-verifier`, "synthetic-verifier");
    f.storage.setItem(`${key}-user`, "synthetic-user");
    f.maps[0].set("unrelated-project", "preserve");
    const finish = f.storage.beginSignOut();
    assert.equal(f.storage.getItem(key), "synthetic-token", "SDK can still revoke the old token");
    assert.equal(f.reload().getItem(key), null, "reload cannot restore the old login");
    for (const map of f.maps) assert.equal([...map.keys()].some(name => name.startsWith(key)), false);
    assert.equal(f.maps[0].get("unrelated-project"), "preserve");
    finish();
    assert.equal(f.storage.getItem(key), null);
  });
}

test("late token refresh cannot persist during or after a failed sign-out", () => {
  const f = fixture(); f.storage.setItem(key, "old");
  const finish = f.storage.beginSignOut();
  f.storage.setItem(key, "late-refresh"); finish();
  f.storage.setItem(key, "later-refresh");
  assert.equal(f.reload().getItem(key), null);
  assert.equal(f.storage.getItem(key), null);
});

test("explicit fresh sign-in works only after old sign-out cleanup", () => {
  const f = fixture(); f.storage.setItem(key, "old");
  const finish = f.storage.beginSignOut();
  assert.throws(() => f.storage.beginSignIn(), /still completing/);
  finish(); f.storage.beginSignIn(); f.storage.setItem(key, "new");
  finish();
  assert.equal(f.reload().getItem(key), "new");
});

test("SDK removal clears both storage choices and its transient snapshot", () => {
  const f = fixture(); f.maps.forEach(map => map.set(key, "old"));
  const finish = f.storage.beginSignOut();
  f.storage.removeItem(key);
  assert.equal(f.storage.getItem(key), null);
  finish(); assert.equal(f.reload().getItem(key), null);
});

test("a fresh sign-in from another tab is readable after completed logout", () => {
  const f = fixture(); f.storage.setItem(key, "old");
  f.storage.beginSignOut()();
  const otherTab = f.reload();
  otherTab.beginSignIn(); otherTab.setItem(key, "new-other-tab");
  assert.equal(f.storage.getItem(key), "new-other-tab");
  f.storage.setItem(key, "new-session-refresh");
  assert.equal(otherTab.getItem(key), "new-session-refresh");
});
