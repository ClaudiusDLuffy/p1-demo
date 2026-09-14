import { z } from "zod";
import type { ControllerExportContext } from "./controllerExportContext";
import { controllerReconciliationSignal, controllerTimestamp, controllerUuid, parseControllerCommandEnvelope,
  sameControllerUuid, unknownControllerOutcome } from "./commandResultValidation";
import { createTransitionCommandRepository, parseTransitionReceipt,
  type TransitionCommand, type TransitionCommandResult } from "./transitionCommandRepository";

const cancelledBatch = z.object({ id: controllerUuid, status: z.literal("cancelled"),
  cancelled_at: controllerTimestamp, cancelled_by: controllerUuid,
  cancellation_reason: z.string().min(1).max(500), confirmed_at: z.null(), confirmed_by: z.null() });
export interface TransitionReconciliation {
  resolve(command: TransitionCommand, result: TransitionCommandResult): Promise<TransitionCommandResult>;
}

export function createTransitionReconciliation(context: ControllerExportContext): TransitionReconciliation {
  const actor = { ...context.actor };
  const actorId = actor.profileId;
  return { resolve: async (command, result) => {
    if (result.status !== "outcome_unknown") return result;
    if (context.signal?.aborted) return result;
    const signal = controllerReconciliationSignal(context.signal);
    try {
      if (command.action === "confirm") {
        // SQL explicitly replays the original confirmed receipt; a later rejection proves no rollback.
        const replay = await createTransitionCommandRepository({ ...context, actor, signal }).execute({ ...command });
        return replay.status === "committed" || replay.status === "replayed" ? replay : unknownControllerOutcome(replay);
      }
      // Cancel has no replay branch: prove the same actor/reason transition using a bounded read.
      const raw = parseControllerCommandEnvelope(await context.dataSession.from("controller_invoice_export_batches")
        .select("id,status,cancelled_at,cancelled_by,cancellation_reason,confirmed_at,confirmed_by")
        .eq("id", command.batchId).abortSignal(signal).maybeSingle().retry(false));
      if (raw.error !== null) return unknownControllerOutcome(raw.error);
      const batch = cancelledBatch.safeParse(raw.data);
      if (!batch.success || !sameControllerUuid(batch.data.id, command.batchId)
        || !sameControllerUuid(batch.data.cancelled_by, actorId) || batch.data.cancellation_reason !== command.reason.trim()) return result;
      const receipt = parseTransitionReceipt({ applied: true, batchId: batch.data.id, status: "cancelled",
        cancelledAt: batch.data.cancelled_at, cancelledBy: batch.data.cancelled_by,
        reason: batch.data.cancellation_reason }, command, actorId);
      return { status: "replayed", receipt };
    } catch (cause: unknown) { return unknownControllerOutcome(cause); }
  } };
}
