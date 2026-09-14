"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppError } from "../../lib/errors/AppError";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { loadDirectoryLabels, loadDirectoryPage, loadDirectorySelection } from "./api";
import { DIRECTORY_DEBOUNCE_MS, DIRECTORY_KEY, DIRECTORY_PAGE_SIZE, directoryLabelIds, directoryScopeKey,
  isDirectoryId, normalizeDirectorySearch, type DirectoryActor, type DirectoryDomain,
  type DirectorySelectionDomain } from "./contracts";

const ActorContext = createContext<DirectoryActor | null>(null);
export function DirectoryScopeProvider({ actor, children }: { actor: DirectoryActor | null; children: ReactNode }) {
  return <ActorContext.Provider value={actor}>{children}</ActorContext.Provider>;
}
export function useDirectoryActor() { return useContext(ActorContext); }
export function useDirectoryPage(domain: DirectoryDomain, enabled: boolean, contractorId: string | null = null,
  actorOverride?: DirectoryActor | null) {
  const contextActor = useDirectoryActor();
  const actor = actorOverride === undefined ? contextActor : actorOverride;
  const scope = directoryScopeKey(actor);
  const [search, setSearch] = useState("");
  let normalized = "";
  let inputError: Error | null = null;
  try { normalized = normalizeDirectorySearch(search); } catch (error) { inputError = error as Error; }
  const [debounced, setDebounced] = useState(normalized);
  const [restart, setRestart] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(normalized), DIRECTORY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [normalized]);
  const signature = JSON.stringify([scope, domain, contractorId, normalized, enabled, restart]);
  const { position, previous, next } = useCursorPagination(signature);
  const allowed = Boolean(enabled && actor?.id && actor.active === true && !inputError);
  const query = useQuery({
    // Raw normalized search changes the observer immediately, aborting the old
    // consumed signal while the new request waits for its full debounce.
    queryKey: [...DIRECTORY_KEY, scope, "page", domain, contractorId, normalized, DIRECTORY_PAGE_SIZE, position.cursor, allowed, restart],
    queryFn: ({ signal }) => {
      if (!allowed || normalized !== debounced) throw inputError || new AppError("INVALID_REQUEST");
      return loadDirectoryPage(domain, normalized, contractorId, position.cursor, signal);
    },
    enabled: allowed && normalized === debounced,
    staleTime: 30_000, gcTime: 60_000,
  });
  return { ...query, error: inputError || query.error, isError: Boolean(inputError || query.isError), items: allowed && !query.isError && normalized === debounced ? query.data?.items || [] : [],
    search, setSearch, position, previous, next: () => next(query.data?.nextCursor || null),
    reset: () => setRestart(value => value + 1),
    waiting: allowed && (normalized !== debounced || query.isFetching) };
}
export function useDirectorySelection(domain: DirectorySelectionDomain, id?: string | null,
  contractorId: string | null = null, enabled = true, actorOverride?: DirectoryActor | null) {
  const contextActor = useDirectoryActor();
  const actor = actorOverride === undefined ? contextActor : actorOverride;
  const allowed = Boolean(enabled && actor?.id && actor.active === true && isDirectoryId(id));
  return useQuery({
    queryKey: [...DIRECTORY_KEY, directoryScopeKey(actor), "selection", domain, contractorId, id || "", allowed],
    queryFn: ({ signal }) => {
      if (!allowed) throw new AppError("INVALID_REQUEST");
      return loadDirectorySelection(domain, id || "", contractorId, signal);
    },
    enabled: allowed, staleTime: 30_000, gcTime: 60_000,
  });
}
export function useDirectoryLabels(values: readonly unknown[], enabled = true, actorOverride?: DirectoryActor | null) {
  const contextActor = useDirectoryActor();
  const actor = actorOverride === undefined ? contextActor : actorOverride;
  const idsKey = JSON.stringify(directoryLabelIds(values));
  const ids: string[] = useMemo(() => JSON.parse(idsKey), [idsKey]);
  const allowed = Boolean(enabled && actor?.id && actor.active === true && ids.length);
  const query = useQuery({
    queryKey: [...DIRECTORY_KEY, directoryScopeKey(actor), "labels", ids, allowed],
    queryFn: ({ signal }) => {
      if (!allowed) throw new AppError("INVALID_REQUEST");
      return loadDirectoryLabels(ids, signal);
    },
    enabled: allowed, staleTime: 30_000, gcTime: 60_000,
  });
  const items = useMemo(() => allowed ? query.data || [] : [], [allowed, query.data]);
  const byId = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  return { ...query, items, getUser: (id: string) => byId.get(id) || null };
}
