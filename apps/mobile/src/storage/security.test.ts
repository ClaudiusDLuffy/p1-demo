import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { QueryClient } from "@tanstack/react-query";
import { persistQueryClientSave } from "@tanstack/react-query-persist-client";
import { MobileContractError } from "@p1/mobile-contracts";
import { bindAuthRefresh } from "../auth/supabase";
import { loadMobileProfile } from "../auth/profileRepository";
import { parseRecoveryLink } from "../auth/passwordReset";
import { createChunkedSecureStorage, type SecureKeyValue } from "../storage/secureSessionStorage";
import { CACHE_PREFIX, CACHE_VERSION, createReadPersister, mobileCacheNamespace, purgeAllMobileReadCaches, restoreReadCache } from "../storage/readCache";
import { createApiClient } from "../data/apiClient";
import { createMobileRepositories } from "../data/repositories";
import { createPrivatePhotoAdapter } from "../data/privatePhotos";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
class MemorySecureStore implements SecureKeyValue {
  values = new Map<string, string>();
  async getItemAsync(key: string) { return this.values.get(key) ?? null; }
  async setItemAsync(key: string, value: string) { this.values.set(key, value); }
  async deleteItemAsync(key: string) { this.values.delete(key); }
}

describe("native security foundations", () => {
  beforeEach(async () => { await AsyncStorage.clear(); });
  it("stores and restores large sessions through versioned encrypted chunks", async () => {
    const native = new MemorySecureStore(); const storage = createChunkedSecureStorage(native);
    const session = "s".repeat(9000);
    await storage.setItem("session", session);
    expect(await storage.getItem("session")).toBe(session);
    expect([...native.values.keys()].filter(key => key.includes(".manifest"))).toHaveLength(1);
  });
  it("replaces and removes every session chunk", async () => {
    const native = new MemorySecureStore(); const storage = createChunkedSecureStorage(native);
    await storage.setItem("session", "a".repeat(5000)); await storage.setItem("session", "next");
    expect(await storage.getItem("session")).toBe("next");
    await storage.removeItem("session");
    expect(await storage.getItem("session")).toBeNull();
    expect(native.values.size).toBe(0);
  });
  it("starts refresh in foreground and stops it in background and cleanup", () => {
    const calls: string[] = []; let listener: ((state: "active" | "background") => void) | undefined;
    const cleanup = bindAuthRefresh({ startAutoRefresh: () => calls.push("start"), stopAutoRefresh: () => calls.push("stop") }, {
      currentState: "active", addEventListener: (_type, next) => { listener = next as typeof listener; return { remove: () => calls.push("remove") }; },
    });
    listener?.("background"); listener?.("active"); cleanup();
    expect(calls).toEqual(["start", "stop", "start", "remove", "stop"]);
  });
  it("parses only the approved password recovery deep link", () => {
    expect(parseRecoveryLink("p1pros://reset-password#type=recovery&access_token=a&refresh_token=b"))
      .toEqual({ accessToken: "a", refreshToken: "b" });
    expect(parseRecoveryLink("https://example.invalid/reset?access_token=a&refresh_token=b&type=recovery")).toBeNull();
  });
  it("hydrates active technician and denies missing or inactive profile", async () => {
    const scope = { contractorAccountId: id(2), organizationId: id(3), organizationName: "Synthetic",
      accessLevel: "report_only", canInvoice: false, canManageTeam: false };
    const profile = { id: id(1), role: "contractor", active: true, name: "Synthetic", email: "user@example.invalid" };
    await expect(loadMobileProfile({ readProfile: async () => ({ data: profile, error: null }),
      readScope: async () => ({ data: scope, error: null }) }, id(1))).resolves.toMatchObject({ capability: "technician" });
    await expect(loadMobileProfile({ readProfile: async () => ({ data: null, error: null }),
      readScope: async () => ({ data: scope, error: null }) }, id(1))).rejects.toMatchObject({ code: "profile_missing" });
    await expect(loadMobileProfile({ readProfile: async () => ({ data: { ...profile, active: false }, error: null }),
      readScope: async () => ({ data: {}, error: null }) }, id(1))).rejects.toMatchObject({ code: "account_inactive" });
  });
  it("isolates persisted cache by environment, project, user, role, and company", () => {
    const env = { EXPO_PUBLIC_P1_APP_ENV: "preview", EXPO_PUBLIC_SUPABASE_URL: "https://one.supabase.co",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-synthetic-value", EXPO_PUBLIC_API_BASE_URL: "https://api.example.invalid",
      EXPO_PUBLIC_RELEASE_SHA: "abcdef1", supabaseProjectRef: "one" } as const;
    const profile = { userId: id(1), name: "Synthetic", email: "user@example.invalid", role: "contractor", active: true,
      capability: "technician", contractorAccountId: id(2), organizationId: id(3), organizationName: "Synthetic",
      accessLevel: "report_only" } as const;
    const first = mobileCacheNamespace(env, profile);
    expect(first).toContain(CACHE_VERSION); expect(first).toContain(id(1)); expect(first).toContain(id(3));
    expect(mobileCacheNamespace(env, { ...profile, userId: id(4) })).not.toBe(first);
    expect(mobileCacheNamespace({ ...env, EXPO_PUBLIC_P1_APP_ENV: "development" }, profile)).not.toBe(first);
    expect(mobileCacheNamespace({ ...env, supabaseProjectRef: "two" }, profile)).not.toBe(first);
  });
  it("purges every mobile read namespace on logout or account switch", async () => {
    await AsyncStorage.multiSet([[CACHE_PREFIX + "one", "x"], [CACHE_PREFIX + "two", "y"], ["unrelated", "z"]]);
    await purgeAllMobileReadCaches();
    expect(await AsyncStorage.getItem(CACHE_PREFIX + "one")).toBeNull();
    expect(await AsyncStorage.getItem("unrelated")).toBe("z");
  });
  it("rejects persisted data from an older cache schema version", async () => {
    const namespace = "version-mismatch";
    const oldClient = new QueryClient();
    oldClient.setQueryData([CACHE_VERSION, "work-orders"], { secret: "synthetic-old-cache" });
    await persistQueryClientSave({ queryClient: oldClient, persister: createReadPersister(namespace), buster: "older-version" });
    const currentClient = new QueryClient();
    await restoreReadCache(currentClient, namespace);
    expect(currentClient.getQueryData([CACHE_VERSION, "work-orders"])).toBeUndefined();
    oldClient.clear(); currentClient.clear();
  });
  it("API client injects bearer and request id, parses JSON, and never retries", async () => {
    const calls: RequestInit[] = [];
    const fetcher = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {}); return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const api = createApiClient("https://api.example.invalid", async () => "synthetic-access", fetcher);
    await expect(api.get<{ ok: boolean }>("/read")).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(calls[0]?.headers).get("Authorization")).toBe("Bearer synthetic-access");
    expect(new Headers(calls[0]?.headers).get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("repositories preserve cursor and cancellation on the stabilized RPCs", async () => {
    const controller = new AbortController(); const calls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[] = [];
    const repository = createMobileRepositories(async (name, args, signal) => {
      calls.push({ name, args, ...(signal ? { signal } : {}) });
      return { items: [], nextCursor: null, hasMore: false };
    });
    await repository.workOrders("opaque", controller.signal);
    expect(calls[0]?.name).toBe("list_work_orders_rows_v1");
    expect(calls[0]?.args.p_cursor).toBe("opaque");
    expect(calls[0]?.signal).toBe(controller.signal);
  });
  it("preserves cancellation and maps former-assignment denial without returning data", async () => {
    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));
    const cancelled = createMobileRepositories(async (_name, _args, signal) => { throw signal?.reason; });
    await expect(cancelled.workOrder("WOT000001", aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    const denied = createMobileRepositories(async () => { throw new MobileContractError("forbidden"); });
    await expect(denied.workOrder("WOT000001")).rejects.toMatchObject({ code: "forbidden" });
  });
  it("private-photo adapter rejects cross-parent metadata before transport", async () => {
    const adapter = createPrivatePhotoAdapter({} as SupabaseClient);
    await expect(adapter.load({ id: id(9), workOrderId: "WOT000001", path: "wo/WOT999999/photo.jpg",
      uploaderName: null, caption: null, createdAt: null }, id(1))).rejects.toMatchObject({ code: "invalid_response" });
  });
});
