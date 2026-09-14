import { z } from "zod";
import {
  completionCommandSchema, etaCommandSchema, lifecycleContextSchema,
  lifecycleResultSchema, lifecycleRpcContext, pauseCommandSchema, visitCommandSchema,
  type LifecycleContext, type LifecycleFunctions, type LifecycleResult,
} from "./workOrderLifecycleContracts";

export type LifecycleTransport = <Name extends keyof LifecycleFunctions>(
  name: Name, args: LifecycleFunctions[Name]["Args"],
) => PromiseLike<{ data: unknown; error: unknown }>;

export class LifecycleCommandError extends Error {
  constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "LifecycleCommandError";
  }
}

export function safeLifecycleError(cause: unknown): LifecycleCommandError {
  if (cause instanceof LifecycleCommandError) return cause;
  const provider = z.object({ code: z.string().optional() }).safeParse(cause);
  const code = provider.success ? provider.data.code : undefined;
  if (code === "PT409") return new LifecycleCommandError(code,
    "Work order changed in another session. Refresh and review it before trying again.", cause);
  if (code === "42501") return new LifecycleCommandError(code,
    "You no longer have permission to perform this action. Refresh the work order.", cause);
  if (code === "22023" || cause instanceof z.ZodError) return new LifecycleCommandError("22023",
    "Check the action's dates, equipment details, and required parts information, then try again.", cause);
  return new LifecycleCommandError("LIFECYCLE_FAILED",
    "The action could not be confirmed. Refresh the work order before trying again.", cause);
}

const sourceVersionSchema = z.object({
  id: z.string().min(1), contractorAssignmentVersion: z.number().int().nonnegative(),
  workflowCycle: z.number().int().nonnegative(), lifecycleVersion: z.number().int().nonnegative(),
});

export function lifecycleContextFor(workOrder: unknown, operationId: string = crypto.randomUUID()): LifecycleContext {
  const parsed = sourceVersionSchema.safeParse(workOrder);
  if (!parsed.success) throw new LifecycleCommandError("PT409",
    "Refresh the work order before performing this action. Its lifecycle version is unavailable.");
  return lifecycleContextSchema.parse({
    workOrderId: parsed.data.id, operationId,
    expectedAssignmentVersion: parsed.data.contractorAssignmentVersion,
    expectedWorkflowCycle: parsed.data.workflowCycle,
    expectedLifecycleVersion: parsed.data.lifecycleVersion,
  });
}

export function createLifecycleCommands(transport: LifecycleTransport) {
  async function run<Name extends keyof LifecycleFunctions>(
    name: Name, args: LifecycleFunctions[Name]["Args"], context: LifecycleContext,
  ): Promise<LifecycleResult> {
    try {
      const { data, error } = await transport(name, args);
      if (error) throw error;
      const result = lifecycleResultSchema.parse(data);
      if (result.workOrderId !== context.workOrderId || result.operationId !== context.operationId
          || result.assignmentVersion !== context.expectedAssignmentVersion
          || result.workflowCycle !== context.expectedWorkflowCycle) {
        throw new LifecycleCommandError("LIFECYCLE_RESPONSE_INVALID", "The action could not be confirmed. Refresh the work order.");
      }
      return result;
    } catch (error) { throw safeLifecycleError(error); }
  }
  // No transport retry: caller retains the operation UUID when retrying an
  // ambiguous request. The database, not this adapter, decides replay validity.
  return {
    async setEta(input: z.input<typeof etaCommandSchema>) {
      try {
        const command = etaCommandSchema.parse(input);
        return await run("set_work_order_eta_v1", { ...lifecycleRpcContext(command), p_eta: command.eta }, command);
      } catch (error) { throw safeLifecycleError(error); }
    },
    async start(input: z.input<typeof visitCommandSchema>, resume = false) {
      try {
        const command = visitCommandSchema.parse(input);
        return await run(resume ? "resume_work_order_visit_v1" : "start_work_order_visit_v1", {
          ...lifecycleRpcContext(command), p_check_in_at: command.checkedInAt, p_notes: command.notes,
        }, command);
      } catch (error) { throw safeLifecycleError(error); }
    },
    async pause(input: z.input<typeof pauseCommandSchema>) {
      try {
        const command = pauseCommandSchema.parse(input);
        return await run("pause_work_order_for_parts_v1", {
          ...lifecycleRpcContext(command), p_check_out_at: command.checkedOutAt, p_reason: command.reason,
          p_parts: command.parts, p_notes: command.notes,
          p_legacy_part_needed: command.legacyPartNeeded, p_legacy_part_eta: command.legacyPartEta,
        }, command);
      } catch (error) { throw safeLifecycleError(error); }
    },
    async complete(input: z.input<typeof completionCommandSchema>) {
      try {
        const command = completionCommandSchema.parse(input);
        return await run("complete_work_order_field_v1", {
          ...lifecycleRpcContext(command), p_completed_at: command.completedAt,
          p_asset_make: command.assetMake, p_asset_model: command.assetModel, p_asset_serial: command.assetSerial,
          p_asset_year: command.assetYear, p_resolution_code: command.resolutionCode, p_resolution_notes: command.resolutionNotes,
        }, command);
      } catch (error) { throw safeLifecycleError(error); }
    },
  };
}
