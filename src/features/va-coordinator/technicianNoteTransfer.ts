import { z } from "zod";
import { normalizeUnknownError } from "../../lib/errors/normalizeUnknown";
import { supabase } from "../../lib/supabase/client";
import type { VaCoordinatorNote } from "./contracts";

export class TechnicianNoteTransferError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}

const responseSchema = z.union([z.null(), z.undefined()]);

export function canTransferTechnicianNote(note: VaCoordinatorNote): boolean {
  return note.requiresSevenElevenSync && note.syncedToSevenElevenAt === null;
}

type TransferTransport = (name: "mark_work_order_activity_synced_v1", args: { p_activity_id: string; p_synced: true })
  => PromiseLike<{ data: unknown; error: unknown }>;

export function createTechnicianNoteTransferAttempt(note: VaCoordinatorNote, confirmed: boolean) {
  if (!canTransferTechnicianNote(note)) throw new TechnicianNoteTransferError("This note is not eligible for a transfer update.");
  if (!confirmed) throw new TechnicianNoteTransferError("Confirm that you copied the update into 7-Eleven first.");
  const args = Object.freeze({ p_activity_id: note.id, p_synced: true as const });
  return async (transport: TransferTransport): Promise<void> => {
    try {
      const { data, error } = await transport("mark_work_order_activity_synced_v1", args);
      if (error) throw error;
      const parsed = responseSchema.safeParse(data);
      if (!parsed.success) throw new TechnicianNoteTransferError("The transfer update could not be verified.", true);
    } catch (cause) {
      if (cause instanceof TechnicianNoteTransferError) throw cause;
      const normalized = normalizeUnknownError(cause);
      if (normalized.code === "FORBIDDEN") throw new TechnicianNoteTransferError("This work order is no longer available for VA review.");
      if (normalized.code === "VALIDATION_FAILED") throw new TechnicianNoteTransferError("This note is no longer eligible for transfer.");
      throw new TechnicianNoteTransferError("The transfer update could not be confirmed. Refresh the note before retrying.", true);
    }
  };
}

export function runTechnicianNoteTransfer(note: VaCoordinatorNote, confirmed: boolean): Promise<void> {
  return createTechnicianNoteTransferAttempt(note, confirmed)((name, args) => supabase().rpc(name, args));
}
