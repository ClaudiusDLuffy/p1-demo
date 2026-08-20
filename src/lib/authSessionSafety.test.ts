import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const db = read("src/lib/db.ts");
const authHook = read("src/features/auth/useAuth.ts");

test("ordinary sign-out is local and surfaces SDK failures", () => {
  const start = db.indexOf("export async function signOut");
  const body = db.slice(start, db.indexOf("export async function getSession", start));
  assert.match(body, /scope:\s*SignOutScope\s*=\s*"local"/);
  assert.match(body, /auth\.signOut\(\{\s*scope\s*\}\)/);
  assert.match(body, /if \(error\) throw error/);
});

test("password login gates old profile queries without signing out first", () => {
  const start = authHook.indexOf("const doLogin");
  const body = authHook.slice(start, authHook.indexOf("const logout", start));
  assert.doesNotMatch(body, /signOut\(/);
  assert.match(body, /expectedUserIdRef\.current\s*=\s*null/);
  assert.match(body, /qc\.clear\(\)/);
  assert.match(body, /setCurrentUser\(null\)/);
  assert.match(body, /setSelectedWO\(null\)/);
  assert.match(body, /setInvoices\?\.\(\[\]\)/);
  assert.match(body, /expectedUserIdRef\.current\s*=\s*data\.user\.id/);
  assert.match(body, /authTransitionRef\.current\s*=\s*"login"/);
});

test("stale profile responses cannot overwrite the newly signed-in identity", () => {
  const start = authHook.indexOf("const hydrateProfile");
  const body = authHook.slice(start, authHook.indexOf("// Real Supabase auth", start));
  assert.match(body, /expectedUserIdRef\.current\s*!==\s*userId/);
  assert.match(body, /expectedUserIdRef\.current\s*!==\s*prof\.id/);
  assert.match(authHook, /await signOut\("local"\)/);
  assert.match(authHook, /expectedUserIdRef\.current\s*=\s*nextUserId/);
  assert.match(authHook, /authTransitionRef\.current\s*===\s*"login"/);
  assert.match(authHook, /authTransitionRef\.current\s*===\s*"logout"/);
});
