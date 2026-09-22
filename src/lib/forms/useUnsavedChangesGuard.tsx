"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DiscardChangesDialog } from "../../components/ui/DiscardChangesDialog";
import { decideDismissal, needsUnloadWarning } from "./dismissal";
import type { DirtyPersistenceState, ModalDismissReason } from "./dismissal";
import { registerDirtySensitiveForm } from "./dirtyFormRegistry";
import { isForcedDeploymentReload } from "../deploymentReload";

export type UnsavedChangesOptions = {
  dirty: boolean;
  persistence?: DirtyPersistenceState;
  busy?: boolean;
  enabled?: boolean;
  sensitive?: boolean;
  scopeKey?: string;
  onClose(reason: ModalDismissReason): void;
  onDiscard?: () => void | boolean | Promise<void | boolean>;
  onKeepDraft?: () => boolean | Promise<boolean>;
};

export function useUnsavedChangesGuard(options: UnsavedChangesOptions) {
  const { dirty, busy = false, enabled = true, sensitive = true,
    persistence = dirty ? "dirty_not_persisted" : "clean" } = options;
  const current = useRef(options);
  const generation = useRef(0);
  const scope = useRef(options.scopeKey);
  const operation = useRef(false);
  const [reason, setReason] = useState<ModalDismissReason | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // Layout-free event callbacks always consult the current rendered contract.
  current.current = options;
  useEffect(() => () => { generation.current += 1; operation.current = false; }, []);
  useEffect(() => {
    if (scope.current === options.scopeKey) return;
    scope.current = options.scopeKey;
    generation.current += 1; operation.current = false;
    setReason(null); setPending(false); setFailed(false);
  }, [options.scopeKey]);
  useEffect(() => {
    if (!enabled) { generation.current += 1; operation.current = false; setReason(null); setPending(false); }
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !dirty || !sensitive) return;
    return registerDirtySensitiveForm();
  }, [enabled, dirty, sensitive]);
  useEffect(() => {
    if (!enabled || !needsUnloadWarning(dirty, persistence)) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (isForcedDeploymentReload()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [enabled, dirty, persistence]);

  const requestClose = useCallback((nextReason: ModalDismissReason) => {
    const latest = current.current;
    if (latest.enabled === false || operation.current) return;
    const decision = decideDismissal({ reason: nextReason, dirty: latest.dirty,
      busy: latest.busy === true,
      persistence: latest.persistence ?? (latest.dirty ? "dirty_not_persisted" : "clean") });
    if (decision.action === "close") { setReason(null); latest.onClose(nextReason); }
    else if (decision.action !== "blocked") { setFailed(false); setReason(nextReason); }
  }, []);

  const confirm = async (keep: boolean) => {
    const latest = current.current;
    if (reason === null || latest.enabled === false || latest.busy || operation.current) return;
    if (keep && (latest.persistence !== "dirty_persisted" || !latest.onKeepDraft)) return;
    operation.current = true;
    setPending(true);
    const issuedGeneration = generation.current;
    const issuedScope = latest.scopeKey;
    try {
      // Normalize synchronous failures to the same pending turn as async saves,
      // so a double activation cannot invoke discard twice in one event turn.
      const accepted = await (async () => keep ? latest.onKeepDraft?.() : latest.onDiscard?.())();
      if (generation.current !== issuedGeneration || current.current.enabled === false || current.current.scopeKey !== issuedScope) return;
      if (accepted === false || (keep && accepted !== true)) { setFailed(true); return; }
      setReason(null);
      current.current.onClose(reason);
    } catch {
      // No draft values or storage/provider exceptions leave this boundary.
      if (generation.current === issuedGeneration && current.current.scopeKey === issuedScope) setFailed(true);
    } finally {
      if (generation.current === issuedGeneration && current.current.scopeKey === issuedScope) { operation.current = false; setPending(false); }
    }
  };

  return {
    requestClose,
    dialog: enabled && reason !== null ? <DiscardChangesDialog persistence={persistence}
      pending={pending || busy} failed={failed}
      onKeepEditing={() => { if (!operation.current && !busy) setReason(null); }}
      onDiscard={() => { void confirm(false); }}
      onKeepDraft={options.onKeepDraft ? () => { void confirm(true); } : undefined} /> : null,
  };
}
