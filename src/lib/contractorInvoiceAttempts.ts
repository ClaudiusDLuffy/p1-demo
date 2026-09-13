import { z } from "zod";
import { ContractorInvoiceCommandError } from "./contractorInvoiceCommands";

/** Per mounted editor/hook; no automatic transport retry or persistent PII. */
export function createContractorInvoiceAttempts() {
  const attempts = new Map<string, { fingerprint: string; pdfPath: string | null; active: boolean }>();
  return {
    begin(operationId: string, payload: unknown) {
      if (!z.uuid().safeParse(operationId).success) throw new ContractorInvoiceCommandError("PT409",
        "Refresh the work order and reopen this invoice form before saving.");
      const fingerprint = JSON.stringify(payload);
      const prior = attempts.get(operationId);
      if (prior?.active) throw new ContractorInvoiceCommandError("INVOICE_BUSY", "This invoice already has an update in progress");
      if (prior && prior.fingerprint !== fingerprint) throw new ContractorInvoiceCommandError("PT409",
        "The earlier invoice change is unconfirmed. Retry it unchanged, or refresh and review the saved invoice before editing.");
      attempts.set(operationId, { fingerprint, pdfPath: prior?.pdfPath ?? null, active: true });
    },
    pdfPath(operationId: string) { return attempts.get(operationId)?.pdfPath ?? null; },
    rememberPdf(operationId: string, path: string) {
      const attempt = attempts.get(operationId);
      if (attempt) attempt.pdfPath = path;
    },
    finish(operationId: string, error?: unknown) {
      const attempt = attempts.get(operationId);
      if (!attempt) return;
      attempt.active = false;
      const parsed = z.object({ code: z.string().optional() }).safeParse(error);
      if (error === undefined || (parsed.success && ["22023", "42501", "INVOICE_NUM_CONFLICT", "23505"].includes(parsed.data.code ?? ""))) {
        attempts.delete(operationId);
      }
    },
  };
}
