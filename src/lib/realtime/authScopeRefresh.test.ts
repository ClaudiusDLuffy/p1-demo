import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { partsModuleHarness } from "../partsSmsOperatorTestHarness";
import type { PortalAuthProfile } from "../../features/auth/authProfile";
type AuthState = { currentUser: PortalAuthProfile | null; refreshCurrentProfile(): Promise<boolean>; doLogin(email: string, password: string): Promise<void>; logout(): Promise<void> };
function fixture() {
  const client = new QueryClient(); let profile = { id: "synthetic-a", name: "Synthetic", role: "manager", active: true, email: "synthetic@example.invalid" };
  let grants: string[] = []; let scope = {}; let scopeFailure = false; let pause: Promise<void> | null = null;
  const harness = partsModuleHarness("src/features/auth/useAuth.ts", {
    "@tanstack/react-query": { useQueryClient: () => client }, "../../lib/constants": { DEMO_ACCOUNTS: [] },
    "../../lib/db": { signIn: async () => ({ user: { id: profile.id } }), signOut: async () => undefined },
    "../../lib/supabase/client": { getRememberedEmail: () => "", getRememberMePreference: () => false, setRememberMePreference() {},
      supabase: () => ({ rpc: async () => ({ data: scope, error: scopeFailure ? { code: "42501" } : null }), from: (table: string) => ({ select: () => ({ eq: () => table === "profiles"
        ? { single: async () => { const data = profile; if (pause) await pause; return { data, error: null }; } }
        : { data: grants.map(permission => ({ permission })), error: null } }) }) }) },
  });
  const controls = { fire() {}, setPage() {}, setSelectedWO() {}, setAiNote() {}, setInvoices() {} };
  return { client, read: () => harness.call("default", controls) as AuthState,
    change(value: Partial<typeof profile>, permissions = grants, company = scope) { profile = { ...profile, ...value }; grants = permissions; scope = company; },
    failScope() { scopeFailure = true; },
    pause(value: Promise<void> | null) { pause = value; } };
}
test("same-id active/role/grant/company changes refresh identity and clear only on scope transition", async () => {
  const f = fixture(); await f.read().doLogin("synthetic@example.invalid", "synthetic-password");
  f.client.setQueryData(["synthetic-old-scope"], { safe: true });
  f.change({ name: "Renamed" }); assert.equal(await f.read().refreshCurrentProfile(), true);
  assert.ok(f.client.getQueryData(["synthetic-old-scope"])); assert.equal(f.read().currentUser?.name, "Renamed");
  f.change({}, ["invoice_controller"]); assert.equal(await f.read().refreshCurrentProfile(), false);
  assert.equal(f.client.getQueryCache().getAll().length, 0); assert.deepEqual([...f.read().currentUser!.staffPermissions], ["invoice_controller"]);
  f.client.setQueryData(["synthetic-controller"], 1); f.change({ active: false }); f.failScope();
  assert.equal(await f.read().refreshCurrentProfile(), false); assert.equal(f.read().currentUser?.active, false); assert.equal(f.client.getQueryCache().getAll().length, 0);
  f.client.clear();
});
test("late self refresh after logout cannot restore profile or directory/count cache", async () => {
  const f = fixture(); await f.read().doLogin("synthetic@example.invalid", "synthetic-password");
  let finish: () => void = () => undefined; f.pause(new Promise<void>(resolve => { finish = resolve; }));
  const pending = f.read().refreshCurrentProfile(); await f.read().logout(); finish();
  assert.equal(await pending, false); assert.equal(f.read().currentUser, null); assert.equal(f.client.getQueryCache().getAll().length, 0); f.client.clear();
});
