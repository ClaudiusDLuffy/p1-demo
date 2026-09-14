import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MobileProfile } from "@p1/mobile-contracts";
import { StatePanel } from "../components/StatePanel";
import { useAuth } from "../auth/AuthProvider";
import { getMobileEnvironment } from "./environment";
import { mobileCacheNamespace, restoreReadCache, subscribeReadCache } from "../storage/readCache";

function createReadQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: {
    retry: (count, error) => count < 1 && (error as { code?: string }).code === "network",
    staleTime: 60_000, gcTime: 24 * 60 * 60 * 1000, networkMode: "offlineFirst",
  }, mutations: { retry: false } } });
}

function ScopedQueryProvider({ children, namespace, profile }: {
  children: ReactNode; namespace: string; profile: MobileProfile | null;
}) {
  const [client] = useState(createReadQueryClient);
  const [ready, setReady] = useState(!profile);
  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => undefined;
    if (profile) {
      void restoreReadCache(client, namespace).finally(() => {
        if (active) {
          unsubscribe = subscribeReadCache(client, namespace);
          setReady(true);
        }
      });
    }
    return () => { active = false; unsubscribe(); client.clear(); };
  }, [client, namespace, profile]);
  if (!ready) return <StatePanel title="Restoring assigned work" message="Loading your protected offline data." busy />;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function MobileQueryProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const namespace = profile ? mobileCacheNamespace(getMobileEnvironment(), profile) : "signed-out";
  return <ScopedQueryProvider key={namespace} namespace={namespace} profile={profile}>{children}</ScopedQueryProvider>;
}
