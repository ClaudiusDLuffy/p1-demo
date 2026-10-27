import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { safeErrorMessage } from "../../../lib/errors/normalizeUnknown";
import { useTransferTechnicianNote, vaCoordinatorQueryKeys, type VaCoordinatorActor } from "../queries";
import type { VaCoordinatorNote } from "../contracts";
import { canTransferTechnicianNote } from "../technicianNoteTransfer";

type UseVaCoordinatorNoteTransferOptions = Readonly<{
  actor: VaCoordinatorActor;
  workOrderId: string | null;
  notes: readonly VaCoordinatorNote[] | undefined;
  notify: (message: string) => void;
}>;

/** Owns eligibility, stale-selection handling, attribution command, and recovery. */
export function useVaCoordinatorNoteTransfer({
  actor,
  workOrderId,
  notes,
  notify,
}: UseVaCoordinatorNoteTransferOptions) {
  const queryClient = useQueryClient();
  const { mutateAsync } = useTransferTechnicianNote(actor, workOrderId);

  return useCallback(async (targetWorkOrderId: string, activityId: string): Promise<boolean> => {
    if (!actor.active || !workOrderId || workOrderId !== targetWorkOrderId) {
      notify("The selected work order changed. Reopen it and review the note before recording the transfer.");
      return false;
    }

    const note = notes?.find(item => item.id === activityId && item.workOrderId === targetWorkOrderId);
    if (!note || !canTransferTechnicianNote(note)) {
      await queryClient.invalidateQueries({ queryKey: vaCoordinatorQueryKeys.notes(actor.id, targetWorkOrderId) });
      notify("This note is no longer eligible for transfer. Refresh and review it again.");
      return false;
    }

    try {
      await mutateAsync({ note, confirmed: true });
      notify("Transfer recorded under your account.");
      return true;
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: vaCoordinatorQueryKeys.notes(actor.id, targetWorkOrderId) });
      notify(`Transfer could not be confirmed: ${safeErrorMessage(error)}`);
      return false;
    }
  }, [actor.active, actor.id, mutateAsync, notes, notify, queryClient, workOrderId]);
}
