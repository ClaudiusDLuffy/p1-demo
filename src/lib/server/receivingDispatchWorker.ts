import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAccessToken, isGraphHttpError, sendEmail } from "../graphClient";
import { createReceivingDispatchNotification } from "../notificationService";
import { createServerClient } from "../supabase/server";
import { requireGraphConfig, getNotificationOwnerEmails } from "../config/server/graph";
import { getPortalOrigin } from "../config/server/appEnvironment";

const MAX_BATCH = 25;
const LEASE_SECONDS = 60;
const START_WINDOW_MS = 10_000;
const DATABASE_TIMEOUT_MS = 5_000;

const claimSchema = z.array(z.object({ id: z.uuid() })).max(1);
const messageSchema = z.object({
  id: z.uuid(), contractorEmail: z.email().max(320), contractorName: z.string().max(500),
  workOrder: z.object({
    id: z.string().min(1).max(128), incidentId: z.string().nullable(),
    storeNumber: z.string().nullable(), city: z.string().nullable(), state: z.string().nullable(),
    address: z.string().nullable(), priority: z.string().nullable(), summary: z.string().nullable(),
    description: z.string().nullable(), externalWorkOrderId: z.string().nullable(),
  }),
});
type Message = z.infer<typeof messageSchema>;
type Outcome = { status: "sent" | "failed" | "unknown" | "not_deliverable"; code: string | null; providerStatus: number | null };

export type ReceivingDispatchWorkerSummary = {
  claimed: number; sent: number; failed: number; unknown: number; notDeliverable: number; superseded: number;
  skipped: number; completionUnconfirmed: number;
};

export function receivingDispatchProviderFailure(error: unknown, sendStarted: boolean): Outcome {
  if (!sendStarted) {
    // Token acquisition cannot deliver a message. Only explicit transient
    // provider/network failures before send qualify for automatic retry.
    const transient = isGraphHttpError(error)
      ? error.retryable || error.deliveryOutcomeUnknown
      : error instanceof Error && /timed out|network error/.test(error.message);
    return { status: "failed", code: transient ? "GRAPH_AUTH_RETRYABLE" : "GRAPH_CONFIG_UNAVAILABLE", providerStatus: null };
  }
  if (isGraphHttpError(error)) {
    if (error.deliveryOutcomeUnknown) return { status: "unknown", code: "GRAPH_OUTCOME_UNKNOWN", providerStatus: error.status };
    if (error.retryable) return { status: "failed", code: "GRAPH_RATE_LIMITED", providerStatus: error.status };
    return { status: "failed", code: "GRAPH_SEND_REJECTED", providerStatus: error.status };
  }
  // Once send starts, an unrecognized exception never proves non-acceptance.
  return { status: "unknown", code: "GRAPH_OUTCOME_UNKNOWN", providerStatus: null };
}

export type ReceivingDispatchWorkerDependencies = {
  claim: (token: string) => Promise<unknown>;
  prepare: (id: string, token: string) => Promise<unknown>;
  complete: (id: string, token: string, outcome: Outcome) => Promise<void>;
  accessToken: () => Promise<string>;
  send: (token: string, message: Message) => Promise<void>;
  now: () => number;
  operationId: () => string;
};

export async function runReceivingDispatchWorker(deps: ReceivingDispatchWorkerDependencies, limit = MAX_BATCH): Promise<ReceivingDispatchWorkerSummary> {
  const startedAt = deps.now();
  const bound = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), MAX_BATCH) : MAX_BATCH;
  const summary: ReceivingDispatchWorkerSummary = { claimed: 0, sent: 0, failed: 0, unknown: 0, notDeliverable: 0, superseded: 0, skipped: 0, completionUnconfirmed: 0 };
  // Claim immediately before each operation, so rows later in a batch do not
  // lose their lease while waiting for earlier Graph requests.
  while (summary.claimed < bound && deps.now() - startedAt < START_WINDOW_MS) {
    const claimToken = deps.operationId();
    const [delivery] = claimSchema.parse(await deps.claim(claimToken));
    if (!delivery) break;
    summary.claimed++;
    let outcome: Outcome;
    let accessToken: string;
    try { accessToken = await deps.accessToken(); }
    catch (error) {
      outcome = receivingDispatchProviderFailure(error, false);
      try { await deps.complete(delivery.id, claimToken, outcome); summary.failed++; }
      catch { summary.completionUnconfirmed++; }
      // Do not hammer configuration/auth failures across the whole queue.
      break;
    }
    let prepared: unknown;
    try {
      prepared = await deps.prepare(delivery.id, claimToken);
    } catch {
      // A lost prepare response might already have marked send-start. Never
      // guess/reset it; lease recovery owns the durable classification.
      summary.completionUnconfirmed++;
      break;
    }
    if (prepared === null) { summary.skipped++; continue; }
    const parsedMessage = messageSchema.safeParse(prepared);
    if (!parsedMessage.success || parsedMessage.data.id !== delivery.id) {
      // A received but invalid message has definitely not been handed to
      // Graph. Preserve that known-unsent distinction from a lost RPC reply.
      try {
        await deps.complete(delivery.id, claimToken, { status: "failed", code: "RECEIVING_MESSAGE_INVALID", providerStatus: null });
        summary.failed++;
      } catch { summary.completionUnconfirmed++; }
      break;
    }
    const message = parsedMessage.data;
    try { await deps.send(accessToken, message); outcome = { status: "sent", code: null, providerStatus: null }; }
    catch (error) { outcome = receivingDispatchProviderFailure(error, true); }
    try { await deps.complete(delivery.id, claimToken, outcome); }
    catch { summary.unknown++; summary.completionUnconfirmed++; break; }
    if (outcome.status === "sent") summary.sent++;
    else if (outcome.status === "unknown") summary.unknown++;
    else if (outcome.status === "not_deliverable") summary.notDeliverable++;
    else summary.failed++;
    if (outcome.code === "GRAPH_RATE_LIMITED") break;
  }
  return summary;
}

export async function drainReceivingDispatches(limit = MAX_BATCH): Promise<ReceivingDispatchWorkerSummary> {
  const sb = createServerClient();
  return runReceivingDispatchWorker({
    claim: async claimToken => {
      const { data, error } = await sb.rpc("claim_receiving_dispatch_deliveries_v1", {
        p_limit: 1, p_lease_seconds: LEASE_SECONDS, p_claim_token: claimToken,
      }).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
      if (error) throw new Error("RECEIVING_DISPATCH_CLAIM_FAILED");
      return data;
    },
    prepare: async (id, claimToken) => {
      const { data, error } = await sb.rpc("prepare_receiving_dispatch_send_v1", {
        p_delivery_id: id, p_claim_token: claimToken,
      }).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
      if (error) throw new Error("RECEIVING_DISPATCH_PREPARE_UNCONFIRMED");
      return data;
    },
    complete: async (id, claimToken, outcome) => {
      const { error } = await sb.rpc("complete_receiving_dispatch_delivery_v1", {
        p_delivery_id: id, p_claim_token: claimToken, p_status: outcome.status,
        p_error_code: outcome.code, p_provider_status: outcome.providerStatus, p_provider_reference: null,
      }).abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
      if (error) throw new Error("RECEIVING_DISPATCH_COMPLETION_UNCONFIRMED");
    },
    accessToken: () => {
      requireGraphConfig();
      getNotificationOwnerEmails();
      getPortalOrigin();
      return getAccessToken();
    },
    send: async (token, message) => {
      const plan = createReceivingDispatchNotification({ ...message, contractorAssigned: true });
      await sendEmail(token, plan.recipients, plan.subject, plan.body);
    },
    now: Date.now, operationId: randomUUID,
  }, limit);
}
