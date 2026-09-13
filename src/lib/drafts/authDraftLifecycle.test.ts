import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createDraftSession, type DraftStorage } from "./draftSession";
const user = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
const filename = resolve("src/features/auth/useAuth.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const localRequire = createRequire(import.meta.url);
type Session = { user: { id: string } } | null;
function harness() {
  const values = new Map<string, string>(); let sequence = 0;
  const storage: DraftStorage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  const draft = createDraftSession({ storage, project: "https://synthetic.invalid", environment: "test", random: () => String(++sequence) });
  const effects: (() => void | (() => void))[] = []; const timers: (() => unknown)[] = [];
  let callback: (event: string, session: Session) => void = () => undefined;
  let role = "manager", active = true, currentId = user, cancel: () => Promise<void> = async () => undefined;
  let signoutFailure = false, signouts = 0, unsubscribed = 0;
  const query = (table: string): unknown => {
    const result = () => ({ data: table === "profiles" ? { id: currentId, role, active, name: "Synthetic" } : [], error: null });
    const builder: Record<string, unknown> = { then: (done: (value: unknown) => unknown) => Promise.resolve(done(result())) };
    for (const name of ["select", "eq"]) builder[name] = () => builder;
    builder.single = async () => result(); return builder;
  };
  const output: { default?: (options: unknown) => { logout(): Promise<void>; refreshCurrentProfile(): Promise<boolean>; doLogin(email: string, password: string): Promise<void> } } = {};
  runInNewContext(compiled, { exports: output, setTimeout: (fn: () => unknown) => { timers.push(fn); return 1; }, clearTimeout: () => undefined,
    require: (name: string): unknown => {
      if (name === "react") return { useCallback: (fn: unknown) => fn, useRef: (current: unknown) => ({ current }),
        useEffect: (fn: () => void) => effects.push(fn), useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => undefined] };
      if (name === "@tanstack/react-query") return { useQueryClient: () => ({ clear: () => undefined, cancelQueries: () => cancel() }) };
      if (name.endsWith("/drafts/browserDraftSession")) return { draftActivationTicket: draft.generation,
        activateBrowserDraftSession: draft.activate, revokeBrowserDraftSession: draft.revoke, suspendBrowserDraftSession: draft.suspend };
      if (name.endsWith("/db")) return { signIn: async () => ({ user: { id: currentId } }), signOut: async () => {
        signouts++; if (signoutFailure) throw new Error("Synthetic SDK signout failure");
      } };
      if (name.endsWith("/constants")) return { DEMO_ACCOUNTS: [] };
      if (name.endsWith("/supabase/client")) return { getRememberedEmail: () => "", getRememberMePreference: () => false,
        setRememberMePreference: () => undefined, supabase: () => ({ from: query, rpc: async () => ({ data: {}, error: null }),
          auth: { onAuthStateChange: (listener: typeof callback) => { callback = listener; return { data: { subscription: {
            unsubscribe: () => { unsubscribed++; },
          } } }; } } }) };
      return localRequire(resolve(filename, "..", name));
    },
  });
  assert.ok(output.default); const auth = output.default({ setPage: () => undefined, setSelectedWO: () => undefined, setAiNote: () => undefined });
  const cleanups = effects.map(effect => effect());
  return { auth, draft, values, emit: async (event: string, session: Session) => { callback(event, session); while (timers.length) await timers.shift()?.(); },
    mutate: (next: { role?: string; active?: boolean; id?: string }) => { role = next.role ?? role; active = next.active ?? active; currentId = next.id ?? currentId; },
    holdCancellation: (fn: () => Promise<void>) => { cancel = fn; }, failSignout: () => { signoutFailure = true; }, signouts: () => signouts,
    cleanup: () => { for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup(); }, unsubscribed: () => unsubscribed,
  };
}
const validate = (value: unknown) => typeof value === "string" ? value : null;
test("actual auth hook activates only active identity, retains ordinary token refresh, and purges on forced loss", async () => {
  const h = harness(); await h.emit("INITIAL_SESSION", { user: { id: user } });
  const lease = h.draft.open("staff-billing", "new", validate)!; assert.equal(lease.save("synthetic").status, "persisted");
  await h.emit("TOKEN_REFRESHED", { user: { id: user } }); assert.equal(lease.isPersisted(), true);
  await h.emit("SIGNED_OUT", null); assert.equal(lease.save("late").status, "revoked");
  h.cleanup(); assert.equal(h.unsubscribed(), 1);
});
test("actual explicit logout purges before failing SDK signout without blocking the attempt", async () => {
  const h = harness(); await h.emit("INITIAL_SESSION", { user: { id: user } });
  const lease = h.draft.open("staff-billing", "new", validate)!; lease.save("synthetic"); h.failSignout();
  await assert.rejects(h.auth.logout()); assert.equal(h.signouts(), 1); assert.equal(lease.isPersisted(), false);
  assert.equal(h.draft.hasDrafts(), false);
});
test("same-user authorization change fences old draft writes before slow query cancellation", async () => {
  const h = harness(); await h.emit("INITIAL_SESSION", { user: { id: user } });
  const lease = h.draft.open("staff-billing", "new", validate)!; lease.save("synthetic");
  let finish: () => void = () => undefined; const pending = new Promise<void>(resolve => { finish = resolve; });
  h.holdCancellation(() => pending); h.mutate({ role: "dispatcher" }); const refreshed = h.auth.refreshCurrentProfile();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(lease.save("late").status, "revoked");
  finish(); await refreshed; assert.equal(h.draft.hasDrafts(), false);
});
test("confirmed cross-tab account switch and inactive self revoke prior recovery", async () => {
  const h = harness(); await h.emit("INITIAL_SESSION", { user: { id: user } });
  const lease = h.draft.open("staff-billing", "new", validate)!; lease.save("synthetic");
  h.mutate({ id: second }); await h.emit("SIGNED_IN", { user: { id: second } });
  assert.equal(lease.save("late").status, "revoked"); const next = h.draft.open("staff-billing", "new", validate)!; next.save("next");
  h.mutate({ active: false }); await h.auth.refreshCurrentProfile(); assert.equal(next.isPersisted(), false);
});
