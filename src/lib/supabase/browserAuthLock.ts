import { navigatorLock, NavigatorLockAcquireTimeoutError, type LockFunc } from "@supabase/supabase-js";

type ProbeResult<T> = { kind: "unavailable" } | { kind: "completed"; value: T } | { kind: "failed"; error: unknown };

/** Preserve cross-tab exclusion without rejecting the native probe callback. */
export function createBrowserAuthLock(locks: Pick<LockManager, "request">, fallback: LockFunc = navigatorLock): LockFunc {
  return async function browserAuthLock<R>(name: string, acquireTimeout: number, fn: () => Promise<R>): Promise<R> {
    // Keep the installed SDK's bounded acquisition/recovery behavior for real
    // auth operations. Only its zero-wait background-refresh probe is adapted.
    if (acquireTimeout !== 0) return fallback(name, acquireTimeout, fn);
    const result = await locks.request<Promise<ProbeResult<R>>>(name, { mode: "exclusive", ifAvailable: true }, async (lock): Promise<ProbeResult<R>> => {
      if (!lock) return { kind: "unavailable" };
      try { return { kind: "completed", value: await fn() }; }
      catch (error) { return { kind: "failed", error }; }
    });
    // Firefox can report a rejection inside the native Web Locks callback as
    // unhandled even when the returned request is caught by the SDK. Reject
    // outside that callback; Supabase still receives its typed contention error.
    if (result.kind === "unavailable") throw new NavigatorLockAcquireTimeoutError(
      `Acquiring an exclusive Navigator LockManager lock "${name}" immediately failed`,
    );
    if (result.kind === "failed") throw result.error;
    return result.value;
  };
}
