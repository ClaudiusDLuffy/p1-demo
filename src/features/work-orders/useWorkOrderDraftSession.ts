import { useCallback, useEffect, useRef } from "react";

type DraftChannel = "field_note" | "general";

/** Prevent late failures from replacing another call/account or a newer edit. */
export function useWorkOrderDraftSession({ workOrderId, actorId }: {
  workOrderId: string;
  actorId?: string | null;
}) {
  const generation = useRef(0);
  const edits = useRef({ field_note: 0, general: 0 });
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [workOrderId, actorId]);
  const captureDraftSession = useCallback((channel: DraftChannel) => {
    const issuedGeneration = generation.current;
    const issuedEdit = edits.current[channel];
    return () => generation.current === issuedGeneration && edits.current[channel] === issuedEdit;
  }, []);
  const markDraftEdited = useCallback((channel: DraftChannel) => { edits.current[channel] += 1; }, []);
  return { captureDraftSession, markDraftEdited };
}
