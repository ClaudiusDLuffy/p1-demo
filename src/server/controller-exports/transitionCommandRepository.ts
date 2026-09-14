import { z } from "zod";
import type { ControllerExportContext } from "./controllerExportContext";
import { controllerCommandFailure, controllerCount, controllerTimestamp, controllerTotal, controllerUuid,
  ControllerCommandResultInvalid, parseControllerCommandEnvelope, sameControllerUuid,
  type ControllerCommandFailure } from "./commandResultValidation";

export type TransitionCommand = { action: "confirm"; batchId: string }
  | { action: "cancel"; batchId: string; reason: string };
const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), batchId: controllerUuid }),
  z.object({ action: z.literal("cancel"), batchId: controllerUuid, reason: z.string().trim().min(1).max(500) }),
]);
const confirmed = { batchId: controllerUuid, status: z.literal("confirmed"),
  confirmedAt: controllerTimestamp, confirmedBy: controllerUuid };
const confirmReceipt = z.discriminatedUnion("applied", [
  z.object({ ...confirmed, applied: z.literal(true), invoiceCount: controllerCount, total: controllerTotal }),
  z.object({ ...confirmed, applied: z.literal(false), reason: z.literal("already_confirmed") }),
]);
const cancelReceipt = z.object({ applied: z.literal(true), batchId: controllerUuid, status: z.literal("cancelled"),
  cancelledAt: controllerTimestamp, cancelledBy: controllerUuid, reason: z.string().min(1).max(500) });
export type TransitionReceipt = z.infer<typeof confirmReceipt> | z.infer<typeof cancelReceipt>;
export type TransitionCommandResult = { status: "committed"; receipt: TransitionReceipt }
  | { status: "replayed"; receipt: TransitionReceipt } | ControllerCommandFailure;
export interface TransitionCommandRepository { execute(command: TransitionCommand): Promise<TransitionCommandResult> }

export function parseTransitionReceipt(value: unknown, command: TransitionCommand, actorId: string): TransitionReceipt {
  if (command.action === "cancel") {
    const parsed = cancelReceipt.safeParse(value);
    if (!parsed.success) throw new ControllerCommandResultInvalid();
    const receipt = parsed.data;
    if (!sameControllerUuid(receipt.batchId, command.batchId) || !sameControllerUuid(receipt.cancelledBy, actorId)
      || receipt.reason !== command.reason.trim()) throw new ControllerCommandResultInvalid();
    return receipt;
  }
  const parsed = confirmReceipt.safeParse(value);
  if (!parsed.success) throw new ControllerCommandResultInvalid();
  const receipt = parsed.data;
  if (!sameControllerUuid(receipt.batchId, command.batchId)
    || (receipt.applied && !sameControllerUuid(receipt.confirmedBy, actorId))) throw new ControllerCommandResultInvalid();
  return receipt;
}

export function createTransitionCommandRepository(context: ControllerExportContext): TransitionCommandRepository {
  const actorId = context.actor.profileId;
  return { execute: async command => {
    if (context.signal?.aborted) return { status: "not_dispatched", code: "REQUEST_ABORTED", cause: context.signal.reason };
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success) return { status: "not_dispatched", code: "CONTROLLER_EXPORT_COMMAND_INVALID", cause: parsed.error };
    const captured = parsed.data;
    try {
      const query = captured.action === "confirm"
        ? context.dataSession.rpc("confirm_controller_invoice_export", { p_batch_id: captured.batchId, p_actor_id: actorId })
        : context.dataSession.rpc("cancel_controller_invoice_export", { p_batch_id: captured.batchId,
          p_actor_id: actorId, p_reason: captured.reason });
      const result = parseControllerCommandEnvelope(await (context.signal ? query.abortSignal(context.signal) : query));
      if (result.error !== null) return controllerCommandFailure(result.error);
      const receipt = parseTransitionReceipt(result.data, captured, actorId);
      return receipt.applied ? { status: "committed", receipt } : { status: "replayed", receipt };
    } catch (cause: unknown) { return controllerCommandFailure(cause); }
  } };
}
