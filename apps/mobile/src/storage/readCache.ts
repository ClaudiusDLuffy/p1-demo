import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { MobileEnvironment, MobileProfile } from "@p1/mobile-contracts";
import type { QueryClient } from "@tanstack/react-query";
import { persistQueryClientRestore, persistQueryClientSubscribe } from "@tanstack/react-query-persist-client";

export const CACHE_VERSION = "p1-mobile-read-v1";
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CACHE_PREFIX = "P1_READ_CACHE:";

export function mobileCacheNamespace(environment: MobileEnvironment, profile: MobileProfile): string {
  return [CACHE_VERSION, environment.EXPO_PUBLIC_P1_APP_ENV, environment.supabaseProjectRef, profile.userId,
    profile.capability, profile.accessLevel ?? "none", profile.organizationId ?? "none",
    profile.contractorAccountId ?? "none"].join(":");
}
export function createReadPersister(namespace: string) {
  return createAsyncStoragePersister({ storage: AsyncStorage, key: `${CACHE_PREFIX}${namespace}`, throttleTime: 1000 });
}
export async function restoreReadCache(client: QueryClient, namespace: string): Promise<void> {
  await persistQueryClientRestore({ queryClient: client, persister: createReadPersister(namespace),
    maxAge: CACHE_MAX_AGE_MS, buster: CACHE_VERSION });
}
export function subscribeReadCache(client: QueryClient, namespace: string): () => void {
  return persistQueryClientSubscribe({ queryClient: client, persister: createReadPersister(namespace),
    buster: CACHE_VERSION, dehydrateOptions: { shouldDehydrateQuery: query =>
      query.queryKey[0] === CACHE_VERSION && query.state.status === "success" } });
}
export async function purgeAllMobileReadCaches(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(CACHE_PREFIX));
  if (keys.length) await AsyncStorage.multiRemove(keys);
}
