"use client";

import { getPublicSupabaseConfig, resolvePublicAppEnvironment } from "../config/public";
import { createDraftSession, type DraftSession } from "./draftSession";
import { reportClientDiagnostic } from "../clientDiagnostics";

let session: DraftSession | null = null;
let listenerInstalled = false;
const reportedAt = { draft_storage_failure: -Infinity, draft_purge_incomplete: -Infinity };

/** Lazy browser-only singleton. Supabase Auth storage and secrets are not inspected. */
export function browserDraftSession(): DraftSession | null {
  if (typeof window === "undefined") return null;
  if (session) return session;
  try {
    const environment = resolvePublicAppEnvironment({ NEXT_PUBLIC_P1_APP_ENV: process.env.NEXT_PUBLIC_P1_APP_ENV, NODE_ENV: process.env.NODE_ENV });
    const project = new URL(getPublicSupabaseConfig().url).origin;
    session = createDraftSession({ environment, project, storage: window.localStorage,
      diagnostic: (category, count) => {
        const now = Date.now();
        if (now - reportedAt[category] < 30_000) return;
        reportedAt[category] = now;
        void reportClientDiagnostic({ source: category, message: "Draft recovery unavailable",
        level: "warning", details: { itemCount: count } }).catch(() => undefined); } });
    if (!listenerInstalled) {
      window.addEventListener("storage", () => session?.storageChanged());
      listenerInstalled = true;
    }
    return session;
  } catch { return null; }
}

export const draftActivationTicket = () => browserDraftSession()?.generation() ?? -1;
export const suspendBrowserDraftSession = () => browserDraftSession()?.suspend();
export const activateBrowserDraftSession = (userId: string, active: boolean, ticket: number) =>
  browserDraftSession()?.activate(userId, active, ticket) ?? false;
export const revokeBrowserDraftSession = (userId?: string | null) =>
  browserDraftSession()?.revoke(userId) ?? false;
export const hasCurrentSensitiveDrafts = () => browserDraftSession()?.hasDrafts() ?? false;
