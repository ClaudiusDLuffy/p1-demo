import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { safeErrorMessage } from "../../../lib/errors/normalizeUnknown";
import { vaCoordinatorQueryKeys, usePostVaCoordinatorUpdate, type VaCoordinatorActor } from "../queries";

type UseVaCoordinatorSevenElevenUpdateOptions = Readonly<{
  actor: VaCoordinatorActor;
  workOrderId: string | null;
  notify: (message: string) => void;
}>;

/** Owns validation feedback, active-work-order binding, mutation state, and refresh. */
export function useVaCoordinatorSevenElevenUpdate({
  actor,
  workOrderId,
  notify,
}: UseVaCoordinatorSevenElevenUpdateOptions) {
  const queryClient = useQueryClient();
  const { mutateAsync, isPending } = usePostVaCoordinatorUpdate(actor, workOrderId);

  const postUpdate = useCallback(async (targetWorkOrderId: string, text: string): Promise<boolean> => {
    if (!actor.active || !workOrderId || workOrderId !== targetWorkOrderId) {
      notify("The selected work order changed. Reopen it before posting an update.");
      return false;
    }
    try {
      await mutateAsync({ targetWorkOrderId, text });
      notify("Update added to the 7-Eleven queue under your account. Copy it to 7-Eleven, then confirm it below.");
      return true;
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: vaCoordinatorQueryKeys.notes(actor.id, targetWorkOrderId) });
      notify(`Update could not be posted: ${safeErrorMessage(error)}`);
      return false;
    }
  }, [actor.active, actor.id, mutateAsync, notify, queryClient, workOrderId]);

  return { postUpdate, isPosting: isPending };
}
