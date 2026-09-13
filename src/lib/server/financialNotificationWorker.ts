import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createInvoicePaymentHoldNotificationPlan, createInvoiceReviewNotificationPlan } from "../notificationService";
import { createServerClient } from "../supabase/server";
import { financialProviderAccessToken, financialProviderFailure, sendFinancialProviderEmail, type FinancialProviderOutcome } from "./financialNotificationProvider";

export const FINANCIAL_WORKER_LIMIT = 25;
export const FINANCIAL_CLAIM_LEASE_SECONDS = 60;
export const FINANCIAL_START_WINDOW_MS = 10_000;
const DATABASE_TIMEOUT_MS = 5_000;
const claimSchema = z.object({ claims: z.array(z.object({ id: z.uuid(), eventId: z.uuid() })).max(1),
  notDeliverable: z.number().int().min(0).max(1),
  // One newly inspected item plus up to 100 expired pre-send claims may be
  // superseded in the same bounded recovery transaction.
  superseded: z.number().int().min(0).max(101),
  recoveredBeforeSend: z.number().int().min(0).max(100), recoveredUnknown: z.number().int().min(0).max(100) });
const preparedTerminalSchema = z.object({ status: z.enum(["not_deliverable", "superseded", "failed"]) });
const messageSchema = z.object({
  id: z.uuid(), eventId: z.uuid(), family: z.enum(["invoice_rejected", "invoice_rejection_retracted", "payment_hold_placed", "payment_hold_released"]),
  recipientEmail: z.email().max(320),
  invoice: z.object({ num: z.string().min(1).max(500), workOrderId: z.string().min(1).max(128).nullable(),
    externalWorkOrderId: z.string().max(128).nullable(), storeNumber: z.string().max(200).nullable(),
    rejectionReason: z.string().nullable(), total: z.number().finite().nullable(), contractorName: z.string().max(500).nullable() }),
  actorName: z.string().max(500).nullable(), reason: z.string().max(500).nullable(),
}).refine(message => message.family.startsWith("payment_hold_") || message.invoice.workOrderId !== null);
const completionStateSchema = z.enum(["sent", "failed", "unknown", "not_deliverable", "superseded"]);
const completionSchema = z.object({ id: z.uuid(), state: completionStateSchema,
  deliveryState: completionStateSchema.optional(), replayed: z.boolean() });
export type FinancialNotificationMessage = z.infer<typeof messageSchema>;
export function validateFinancialNotificationCompletion(value: unknown, id: string, state: FinancialProviderOutcome["status"]): void {
  const result = completionSchema.safeParse(value);
  if (!result.success || result.data.id !== id || result.data.state !== state
    || (result.data.deliveryState !== undefined && result.data.deliveryState !== state
      && !(state === "failed" && result.data.deliveryState === "superseded"))) {
    throw new Error("FINANCIAL_NOTIFICATION_COMPLETION_UNCONFIRMED");
  }
}
export type FinancialWorkerSummary = {
  claimed: number; sent: number; failed: number; unknown: number; skipped: number;
  completionUnconfirmed: number; notDeliverable: number; superseded: number; recoveredBeforeSend: number; recoveredUnknown: number;
};
export type FinancialWorkerDependencies = {
  claim: (token: string) => Promise<unknown>;
  prepare: (id: string, token: string) => Promise<unknown>;
  complete: (id: string, token: string, outcome: FinancialProviderOutcome) => Promise<void>;
  accessToken: () => Promise<string>;
  send: (token: string, message: FinancialNotificationMessage) => Promise<void>;
  now: () => number;
  operationId: () => string;
};

export function financialNotificationMessagePlan(message: FinancialNotificationMessage) {
  const recipients = [message.recipientEmail];
  if (message.family === "invoice_rejected" || message.family === "invoice_rejection_retracted") {
    if (message.invoice.workOrderId === null) throw new Error("FINANCIAL_MESSAGE_INVALID");
    return createInvoiceReviewNotificationPlan({ recipients, invoice: { ...message.invoice, workOrderId: message.invoice.workOrderId },
      event: message.family === "invoice_rejected" ? "rejected" : "retraction" });
  }
  return createInvoicePaymentHoldNotificationPlan({ recipients, invoice: message.invoice,
    event: message.family === "payment_hold_placed" ? "placed" : "released",
    actorName: message.actorName || "P1 staff", reason: message.reason || "" });
}

export async function runFinancialNotificationWorker(deps: FinancialWorkerDependencies, limit = FINANCIAL_WORKER_LIMIT): Promise<FinancialWorkerSummary> {
  const started = deps.now();
  const bound = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), FINANCIAL_WORKER_LIMIT) : FINANCIAL_WORKER_LIMIT;
  const summary: FinancialWorkerSummary = { claimed: 0, sent: 0, failed: 0, unknown: 0, skipped: 0, completionUnconfirmed: 0,
    notDeliverable: 0, superseded: 0, recoveredBeforeSend: 0, recoveredUnknown: 0 };
  let inspected = 0;
  // One claim immediately before its provider operation: no lease is consumed
  // waiting behind a different message. Admission closes after ten seconds.
  while (inspected < bound && deps.now() - started < FINANCIAL_START_WINDOW_MS) {
    const token = deps.operationId();
    const claim = claimSchema.parse(await deps.claim(token));
    summary.notDeliverable += claim.notDeliverable; summary.superseded += claim.superseded;
    summary.recoveredBeforeSend += claim.recoveredBeforeSend; summary.recoveredUnknown += claim.recoveredUnknown;
    const [delivery] = claim.claims;
    if (!delivery) {
      if (claim.notDeliverable + claim.superseded > 0) { inspected++; continue; }
      break;
    }
    inspected++;
    summary.claimed++;
    let accessToken: string;
    try { accessToken = await deps.accessToken(); }
    catch (error) {
      try { await deps.complete(delivery.id, token, financialProviderFailure(error, false)); summary.failed++; }
      catch { summary.completionUnconfirmed++; }
      break; // Do not exhaust the queue against unavailable configuration/auth.
    }
    let prepared: unknown;
    try { prepared = await deps.prepare(delivery.id, token); }
    catch {
      // The database may have committed send-start despite losing its response.
      // Only lease recovery can classify that durable ambiguity.
      summary.completionUnconfirmed++;
      break;
    }
    if (prepared === null) { summary.skipped++; continue; }
    const terminal = preparedTerminalSchema.safeParse(prepared);
    if (terminal.success) {
      if (terminal.data.status === "not_deliverable") summary.notDeliverable++;
      else if (terminal.data.status === "superseded") summary.superseded++;
      else summary.failed++;
      continue;
    }
    const parsed = messageSchema.safeParse(prepared);
    if (!parsed.success || parsed.data.id !== delivery.id || parsed.data.eventId !== delivery.eventId) {
      try {
        await deps.complete(delivery.id, token, { status: "failed", code: "FINANCIAL_MESSAGE_INVALID", providerStatus: null, retryAfterSeconds: null });
        summary.failed++;
      } catch { summary.completionUnconfirmed++; }
      break;
    }
    let outcome: FinancialProviderOutcome;
    try {
      await deps.send(accessToken, parsed.data);
      outcome = { status: "sent", code: null, providerStatus: 202, retryAfterSeconds: null };
    } catch (error) { outcome = financialProviderFailure(error, true); }
    try { await deps.complete(delivery.id, token, outcome); }
    catch { summary.unknown++; summary.completionUnconfirmed++; break; }
    if (outcome.status === "sent") summary.sent++;
    else if (outcome.status === "unknown") summary.unknown++;
    else summary.failed++;
    if (outcome.code === "GRAPH_RATE_LIMITED" || outcome.code === "GRAPH_RETRY_WINDOW_EXCEEDED") break;
  }
  return summary;
}

export async function drainFinancialNotifications(limit = FINANCIAL_WORKER_LIMIT): Promise<FinancialWorkerSummary> {
  const sb = createServerClient();
  return runFinancialNotificationWorker({
    claim: async token => {
      const { data, error } = await sb.rpc("claim_financial_notification_deliveries_v1", {
        p_limit: 1, p_lease_seconds: FINANCIAL_CLAIM_LEASE_SECONDS, p_claim_token: token,
      }).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
      if (error) throw new Error("FINANCIAL_NOTIFICATION_CLAIM_FAILED");
      return data;
    },
    prepare: async (id, token) => {
      const { data, error } = await sb.rpc("prepare_financial_notification_send_v1", {
        p_delivery_id: id, p_claim_token: token,
      }).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
      if (error) throw new Error("FINANCIAL_NOTIFICATION_PREPARE_UNCONFIRMED");
      return data;
    },
    complete: async (id, token, outcome) => {
      const { data, error } = await sb.rpc("complete_financial_notification_delivery_v1", {
        p_delivery_id: id, p_claim_token: token, p_status: outcome.status, p_error_code: outcome.code,
        p_provider_status: outcome.providerStatus, p_provider_reference: null, p_retry_after_seconds: outcome.retryAfterSeconds,
      }).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
      if (error) throw new Error("FINANCIAL_NOTIFICATION_COMPLETION_UNCONFIRMED");
      validateFinancialNotificationCompletion(data, id, outcome.status);
    },
    accessToken: financialProviderAccessToken,
    send: async (token, message) => {
      const plan = financialNotificationMessagePlan(message);
      await sendFinancialProviderEmail(token, message.recipientEmail, plan.subject, plan.body);
    },
    now: Date.now, operationId: randomUUID,
  }, limit);
}
