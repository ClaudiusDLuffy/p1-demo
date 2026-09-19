"use client";
import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DirectoryActor } from "../../features/directory/contracts";
import { directoryActorScope } from "../counts/queryKeys";
import { reportClientFailure } from "../clientDiagnostics";
import { supabase } from "../supabase/client";
import { browserVisibility } from "./browserVisibility";
import type { RealtimeTimer } from "./realtimeBatcher";
import { createPortalRealtimeSession } from "./realtimeSession";

const timer: RealtimeTimer = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: handle => { if (typeof handle === "number") clearTimeout(handle); },
};
export function usePortalRealtime(actor: DirectoryActor | null, refreshIdentity: () => Promise<boolean>) {
  const client = useQueryClient();
  const scope = directoryActorScope(actor);
  const latest = useRef({ actor, refreshIdentity });
  useEffect(() => { latest.current = { actor, refreshIdentity }; }, [actor, refreshIdentity]);
  const batcher = useRef<ReturnType<typeof createPortalRealtimeSession> | null>(null);
  useEffect(() => {
    const identity = latest.current.actor;
    if (!identity?.id || identity.active !== true) return;
    const report = (category: string) => {
      void reportClientFailure({ source: `portal-realtime.${category}`, code: "PROVIDER_UNAVAILABLE",
        message: "Live refresh is temporarily unavailable." });
    };
    const current = createPortalRealtimeSession({ client, actor: identity, timer, visibility: browserVisibility,
      subscription: supabase(), refreshIdentity: () => latest.current.refreshIdentity(), report,
      repeat: (callback, delay) => window.setInterval(callback, delay),
      clearRepeat: handle => { if (typeof handle === "number") window.clearInterval(handle); } });
    batcher.current = current;
    return () => {
      current.stop();
      if (batcher.current === current) batcher.current = null;
    };
  }, [client, scope]);
  return useCallback(() => batcher.current?.refresh() ?? Promise.resolve(), []);
}
