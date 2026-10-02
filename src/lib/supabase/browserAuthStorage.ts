type AuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Persisted credentials are removed before the UI can claim local sign-out.
 * The SDK retains a short-lived memory snapshot only to revoke its old token.
 */
export function createBrowserAuthStorage(options: {
  key: string;
  stores(): readonly AuthStorage[];
  remember(): boolean;
}) {
  let signedOut = false;
  let logoutSnapshot: Map<string, string> | null = null;
  const keys = [options.key, `${options.key}-code-verifier`, `${options.key}-user`];
  const readStored = (key: string) => {
    for (const storage of options.stores()) {
      const value = storage.getItem(key);
      if (value !== null) return value;
    }
    return null;
  };
  const removeStored = (key: string) => {
    for (const storage of options.stores()) storage.removeItem(key);
  };
  return {
    getItem(key: string) {
      if (logoutSnapshot) return logoutSnapshot.get(key) ?? null;
      const value = readStored(key);
      // After SDK cleanup, another tab may explicitly sign in. Accept that
      // new durable session; this instance still cannot persist late writes
      // while storage is empty after its own sign-out.
      if (key === options.key && value !== null) signedOut = false;
      return value;
    },
    setItem(key: string, value: string) {
      // A delayed refresh must not restore durable credentials during logout.
      if (signedOut) return;
      const stores = options.stores();
      const primary = stores[options.remember() ? 0 : 1];
      for (const storage of stores) if (storage !== primary) storage.removeItem(key);
      primary?.setItem(key, value);
    },
    removeItem(key: string) {
      logoutSnapshot?.delete(key);
      removeStored(key);
    },
    beginSignOut() {
      signedOut = true;
      const snapshot = logoutSnapshot ?? new Map<string, string>();
      for (const key of keys) {
        const value = readStored(key);
        if (value !== null) snapshot.set(key, value);
        removeStored(key);
      }
      logoutSnapshot = snapshot;
      return () => { if (logoutSnapshot === snapshot) logoutSnapshot = null; };
    },
    beginSignIn() {
      if (logoutSnapshot) throw new Error("Sign-out is still completing. Try signing in again shortly.");
      signedOut = false;
    },
  };
}
