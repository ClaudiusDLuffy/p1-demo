import { resolve } from "node:path";
import type { ControllerTestModules } from "./moduleHarness";

export const controllerTestIds = {
  actor: "81000000-0000-4000-8000-000000000001",
  batch: "81000000-0000-4000-8000-000000000002",
  invoice: "81000000-0000-4000-8000-000000000003",
  request: "81000000-0000-4000-8000-000000000004",
  otherActor: "81000000-0000-4000-8000-000000000005",
};
type Row = Record<string, unknown>;
export type ControllerAuthorizationOptions = {
  active?: boolean;
  role?: string;
  permissions?: readonly string[];
  missingProfile?: boolean;
  invalidToken?: boolean;
  authFailure?: unknown;
  profileFailure?: unknown;
  permissionFailure?: unknown;
  returnedProfileId?: string;
  profileResult?: unknown;
  permissionResult?: unknown;
  authResult?: unknown;
  profileEnvelope?: unknown;
  permissionEnvelope?: unknown;
};

/** Configurable SDK ports, not a replacement authorization decision. Every
 * role/grant/error option is consumed by the actual authorization module. */
export function controllerAuthorizationPorts(options: ControllerAuthorizationOptions = {}) {
  const calls: { name: string; value?: unknown }[] = [];
  let publicFetch: typeof fetch | undefined;
  let privilegedFetch: typeof fetch | undefined;
  class Query implements PromiseLike<unknown> {
    private one = false;
    private signal: AbortSignal | null = null;
    constructor(private readonly table: "profiles" | "staff_permission_grants") {}
    select(fields: string) { calls.push({ name: `select:${this.table}`, value: fields }); return this; }
    eq(column: string, value: unknown) {
      calls.push({ name: `eq:${this.table}`, value: { column, value } }); return this;
    }
    maybeSingle() { this.one = true; return this; }
    single() { this.one = true; return this; }
    retry(enabled: boolean) { calls.push({ name: `retry:${this.table}`, value: enabled }); return this; }
    abortSignal(signal: AbortSignal) {
      this.signal = signal; calls.push({ name: `signal:${this.table}`, value: signal }); return this;
    }
    then<TResult1 = unknown, TResult2 = never>(
      fulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const execute = async (): Promise<unknown> => {
        this.signal?.throwIfAborted();
        calls.push({ name: `read:${this.table}` });
        if (this.table === "profiles" && Object.hasOwn(options, "profileEnvelope")) return options.profileEnvelope;
        if (this.table === "staff_permission_grants" && Object.hasOwn(options, "permissionEnvelope")) return options.permissionEnvelope;
        const profile: Row = { id: options.returnedProfileId ?? controllerTestIds.actor,
          name: "Synthetic controller staff", email: "controller@example.invalid",
          role: options.role ?? "manager", active: options.active ?? true };
        const rows = this.table === "profiles" ? (options.missingProfile ? [] : [profile])
          : (options.permissions ?? ["quickbooks_handoff"]).map(permission => ({ permission }));
        const error = this.table === "profiles" ? options.profileFailure ?? null : options.permissionFailure ?? null;
        if (this.table === "profiles" && Object.hasOwn(options, "profileResult")) return { data: options.profileResult, error };
        if (this.table === "staff_permission_grants" && Object.hasOwn(options, "permissionResult")) return { data: options.permissionResult, error };
        return { data: this.one ? rows[0] ?? null : rows, error };
      };
      return execute().then(fulfilled, rejected);
    }
  }
  const session = {
    from(table: string) {
      calls.push({ name: `from:${table}` });
      if (table !== "profiles" && table !== "staff_permission_grants") {
        throw new Error(`Unexpected authorization query: ${table}`);
      }
      return new Query(table);
    },
    rpc() { throw new Error("Authorization ports cannot dispatch a domain command"); },
    auth: { async getUser(token: string) {
      calls.push({ name: "getUser", value: token });
      if (options.authFailure instanceof Error) throw options.authFailure;
      if (Object.hasOwn(options, "authResult")) return options.authResult;
      return { data: { user: options.invalidToken ? null : { id: controllerTestIds.actor } },
        error: options.authFailure ?? null };
    } },
  };
  const modules: ControllerTestModules = {
    "@supabase/supabase-js": { createClient: (_url: string, _key: string, config?: { global?: { fetch?: typeof fetch } }) => {
      calls.push({ name: "createPublicClient" }); publicFetch = config?.global?.fetch; return session;
    } },
    [resolve("src/lib/supabase/server.ts")]: {
      createServerClient: (config?: { fetch?: typeof fetch }) => {
        calls.push({ name: "createPrivilegedClient" }); privilegedFetch = config?.fetch; return session;
      },
    },
  };
  return { calls, session, modules, publicFetch: () => publicFetch, privilegedFetch: () => privilegedFetch };
}
