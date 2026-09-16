import { randomUUID } from "node:crypto";
import { z } from "zod";
import { composePartsSmsMessage } from "../partsSmsPolicy";
import { createServerClient } from "../supabase/server";
import { createTwilioPartsSms, type TwilioSmsSendOutcome, type TwilioSmsStatusOutcome } from "./twilioPartsSms";
import { getTwilioConfig } from "../config/server/twilio";
import { getPortalOrigin } from "../config/server/appEnvironment";
import { ConfigurationError, type ConfigurationCode } from "../config/shared";

export const PARTS_SMS_SEND_LIMIT = 25;
export const PARTS_SMS_STATUS_LIMIT = 10;
export const PARTS_SMS_START_WINDOW_MS = 20_000;
export const PARTS_SMS_STATUS_WINDOW_MS = 8_000;
export const PARTS_SMS_WORKER_TIMEOUT_MS = 50_000;
export const PARTS_SMS_DATABASE_TIMEOUT_MS = 5_000;
const count = z.number().int().min(0).max(100_000);
const recurrenceCount = z.number().int().min(0).max(PARTS_SMS_SEND_LIMIT);
const states = z.enum(["pending", "claimed", "sending", "accepted", "sent", "delivered", "failed", "unknown", "not_deliverable", "superseded"]);
const runStartSchema = z.object({ runId: z.uuid(), enabled: z.boolean(), timezone: z.string().max(100), cutoffTime: z.string().max(20).nullable() });
const evaluationSchema = z.object({ status: z.enum(["queued", "disabled", "unscheduled", "before_cutoff", "nothing_to_send", "capacity_exceeded", "no_recipients"]),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), queued: count, skipped: count, superseded: count, parts: count, workOrders: count,
  recurrenceQueued: recurrenceCount.default(0), recurrenceBlocked: recurrenceCount.default(0) })
  .refine(value => value.recurrenceQueued <= value.queued && value.recurrenceBlocked <= value.skipped);
const claimSchema = z.object({ claim: z.object({ id: z.uuid() }).nullable(), recoveredBeforeSend: count, recoveredUnknown: count, superseded: count, notDeliverable: count });
const statusClaimSchema = z.object({ claim: z.object({ id: z.uuid(), providerMessageId: z.string().regex(/^(SM|MM)[0-9a-f]{32}$/i) }).nullable(), stale: count });
const messageSchema = z.object({ id: z.uuid(), phoneE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), requestSignature: z.string().regex(/^[0-9a-f]{64}$/),
  parts: z.number().int().min(1).max(10_000), workOrders: z.number().int().min(1).max(10_000), previewIds: z.array(z.string().min(1).max(128)).min(1).max(8) });
const preparedTerminalSchema = z.object({ status: z.enum(["not_deliverable", "superseded"]) });
const completionSchema = z.object({ id: z.uuid(), state: states, replayed: z.boolean() });
const finishSchema = z.object({ runId: z.uuid(), completed: z.literal(true), replayed: z.boolean() });
type ServiceRpcName = "start_parts_sms_run_v1" | "finish_parts_sms_run_v1" | "enqueue_parts_sms_deliveries_v1"
  | "claim_parts_sms_delivery_v1" | "prepare_parts_sms_send_v1" | "complete_parts_sms_delivery_v1"
  | "claim_parts_sms_status_v1" | "complete_parts_sms_status_v1";
type DatabaseResult = { data: unknown; error: unknown };
type ServiceRpcClient = { rpc(name: ServiceRpcName, args: Record<string, unknown>): { abortSignal(signal: AbortSignal): PromiseLike<DatabaseResult> } };

export async function partsSmsDatabaseRequest(request: (signal: AbortSignal) => PromiseLike<DatabaseResult>, parent?: AbortSignal,
  timeoutMs = PARTS_SMS_DATABASE_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  let rejectDeadline: (error: Error) => void = () => undefined;
  const timeout = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => { controller.abort(); rejectDeadline(new Error("PARTS_SMS_DATABASE_UNAVAILABLE")); };
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, PARTS_SMS_DATABASE_TIMEOUT_MS)) : PARTS_SMS_DATABASE_TIMEOUT_MS;
  const timer = setTimeout(abort, duration);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  try {
    const pending = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("PARTS_SMS_DATABASE_UNAVAILABLE");
      return request(controller.signal);
    });
    const { data, error } = await Promise.race([pending, timeout]);
    if (error) throw new Error("PARTS_SMS_DATABASE_UNAVAILABLE");
    return data;
  } catch { throw new Error("PARTS_SMS_DATABASE_UNAVAILABLE"); }
  finally { clearTimeout(timer); parent?.removeEventListener("abort", abort); controller.abort(); }
}

type ResultCode = "RUN_COMPLETE" | "RUN_PARTIAL" | "TWILIO_NOT_CONFIGURED" | "DATABASE_UNAVAILABLE" | "TIME_BUDGET_EXCEEDED";
type Statistics = {
  queued: number; eligible: number; parts: number; workOrders: number; claimed: number; accepted: number; deliveredUpdates: number; failed: number;
  retryableFailed: number; unknown: number; notDeliverable: number; superseded: number; skipped: number;
  recoveredBeforeSend: number; recoveredUnknown: number; completionUnconfirmed: number;
  statusChecked: number; statusUnavailable: number; statusStale: number;
  recurrenceQueued: number; recurrenceBlocked: number;
};
export type PartsSmsWorkerSummary = Statistics & {
  runId: string; evaluation: z.infer<typeof evaluationSchema>["status"] | "unavailable";
  localDate: string | null; resultCode: ResultCode; heartbeatConfirmed: boolean;
  configurationCode: ConfigurationCode | null;
};
export type PartsSmsWorkerDependencies = {
  start: (runId: string) => Promise<unknown>;
  enqueue: (force: boolean) => Promise<unknown>;
  claim: (token: string, force: boolean) => Promise<unknown>;
  prepare: (id: string, token: string, force: boolean) => Promise<unknown>;
  send: (input: { phoneE164: string; body: string }, signal?: AbortSignal) => Promise<TwilioSmsSendOutcome>;
  complete: (id: string, token: string, outcome: TwilioSmsSendOutcome) => Promise<unknown>;
  claimStatus: (token: string) => Promise<unknown>;
  lookup: (sid: string, signal?: AbortSignal) => Promise<TwilioSmsStatusOutcome>;
  completeStatus: (id: string, token: string, outcome: TwilioSmsStatusOutcome, sid: string) => Promise<unknown>;
  finish: (runId: string, summary: Statistics, result: ResultCode) => Promise<unknown>;
  operationId: () => string; now: () => number; portalUrl: string;
  configurationError?: ConfigurationError;
};

function expectedState(outcome: TwilioSmsSendOutcome): z.infer<typeof states> {
  if (outcome.status === "unknown") return "unknown";
  if (outcome.status === "known_unsent_retryable") return "failed";
  if (outcome.status === "known_unsent_terminal") return ["TWILIO_NOT_CONFIGURED", "RECIPIENT_NOT_DELIVERABLE"].includes(outcome.code) ? "not_deliverable" : "failed";
  if (outcome.providerStatus === "delivered" || outcome.providerStatus === "sent") return outcome.providerStatus;
  return outcome.providerStatus === "failed" || outcome.providerStatus === "undelivered" ? "failed" : "accepted";
}

export async function runPartsSmsWorker(deps: PartsSmsWorkerDependencies, options: { limit?: number; force?: boolean; signal?: AbortSignal } = {}): Promise<PartsSmsWorkerSummary> {
  const started = deps.now();
  const runId = deps.operationId();
  const force = options.force === true;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(PARTS_SMS_SEND_LIMIT, Math.floor(options.limit ?? PARTS_SMS_SEND_LIMIT))) : PARTS_SMS_SEND_LIMIT;
  const stats: Statistics = { queued: 0, eligible: 0, parts: 0, workOrders: 0, claimed: 0, accepted: 0, deliveredUpdates: 0, failed: 0,
    retryableFailed: 0, unknown: 0, notDeliverable: 0, superseded: 0, skipped: 0, recoveredBeforeSend: 0,
    recoveredUnknown: 0, completionUnconfirmed: 0, statusChecked: 0, statusUnavailable: 0, statusStale: 0, recurrenceQueued: 0, recurrenceBlocked: 0 };
  let evaluation: PartsSmsWorkerSummary["evaluation"] = "unavailable";
  let localDate: string | null = null;
  let resultCode: ResultCode = "RUN_COMPLETE";
  let configurationCode: ConfigurationCode | null = null;
  try {
    const receipt = runStartSchema.parse(await deps.start(runId));
    if (receipt.runId !== runId) throw new Error("RUN_ID_MISMATCH");
  } catch { throw new Error("PARTS_SMS_RUN_UNAVAILABLE"); }
  const admitted = (window: number) => !options.signal?.aborted && deps.now() - started < window;
  try {
    const evaluationResult = evaluationSchema.parse(await deps.enqueue(force));
    evaluation = evaluationResult.status; localDate = evaluationResult.localDate;
    stats.queued = evaluationResult.queued; stats.eligible = evaluationResult.queued + evaluationResult.skipped;
    stats.parts = evaluationResult.parts; stats.workOrders = evaluationResult.workOrders;
    stats.recurrenceQueued = evaluationResult.recurrenceQueued; stats.recurrenceBlocked = evaluationResult.recurrenceBlocked;
    stats.skipped = evaluationResult.skipped; stats.superseded = evaluationResult.superseded;
    if (evaluation === "capacity_exceeded" || evaluation === "no_recipients") resultCode = "RUN_PARTIAL";

    // Status-only GETs run independently of send eligibility/settings. They can
    // finish a previously accepted SMS even after alerts have been disabled.
    for (let checked = 0; checked < PARTS_SMS_STATUS_LIMIT && admitted(PARTS_SMS_STATUS_WINDOW_MS); checked++) {
      const token = deps.operationId();
      const status = statusClaimSchema.parse(await deps.claimStatus(token));
      stats.statusStale += status.stale;
      if (!status.claim) break;
      const { id, providerMessageId } = status.claim;
      if (deps.configurationError?.feature === "twilio") configurationCode = deps.configurationError.code;
      let outcome: TwilioSmsStatusOutcome;
      try { outcome = await deps.lookup(providerMessageId, options.signal); }
      catch { outcome = { status: "unavailable", code: "TWILIO_STATUS_UNAVAILABLE" }; }
      try {
        const receipt = completionSchema.parse(await deps.completeStatus(id, token, outcome, providerMessageId));
        if (receipt.id !== id) throw new Error("STATUS_COMPLETION_MISMATCH");
        stats.statusChecked++;
        if (outcome.status === "unavailable") stats.statusUnavailable++;
        else if (outcome.providerStatus === "delivered" && receipt.state === "delivered") stats.deliveredUpdates++;
        else if (["failed", "undelivered"].includes(outcome.providerStatus) && receipt.state === "failed") stats.failed++;
      } catch { stats.completionUnconfirmed++; resultCode = "RUN_PARTIAL"; break; }
    }

    // A single short claim immediately precedes each send. No lease waits behind
    // another recipient's network request; no transaction spans provider I/O.
    for (let inspected = 0; inspected < limit && admitted(PARTS_SMS_START_WINDOW_MS); inspected++) {
      const token = deps.operationId();
      const claim = claimSchema.parse(await deps.claim(token, force));
      stats.recoveredBeforeSend += claim.recoveredBeforeSend; stats.recoveredUnknown += claim.recoveredUnknown;
      stats.superseded += claim.superseded; stats.notDeliverable += claim.notDeliverable;
      if (!claim.claim) {
        if (claim.superseded + claim.notDeliverable > 0) continue;
        break;
      }
      const { id } = claim.claim;
      stats.claimed++;
      if (deps.configurationError) {
        // Claim still performs bounded lease recovery. Configuration cannot
        // authorize durable send-start: leave only a pre-start claim, safely
        // reclaimable on expiry, without inventing a provider outcome.
        configurationCode = deps.configurationError.code;
        stats.skipped++;
        resultCode = deps.configurationError.feature === "twilio" ? "TWILIO_NOT_CONFIGURED" : "RUN_PARTIAL";
        break;
      }
      let prepared: unknown;
      try { prepared = await deps.prepare(id, token, force); }
      catch {
        // Send-start may have committed. Do not issue a compensating failed
        // completion: expiry will derive pre-start reclaim versus unknown.
        stats.completionUnconfirmed++; resultCode = "RUN_PARTIAL"; break;
      }
      if (prepared === null) { stats.skipped++; continue; }
      const terminal = preparedTerminalSchema.safeParse(prepared);
      if (terminal.success) {
        if (terminal.data.status === "superseded") stats.superseded++; else stats.notDeliverable++;
        continue;
      }
      const message = messageSchema.safeParse(prepared);
      let outcome: TwilioSmsSendOutcome;
      if (!message.success || message.data.id !== id) {
        outcome = { status: "known_unsent_terminal", code: "PARTS_SMS_MESSAGE_INVALID" };
      } else {
        try {
          outcome = await deps.send({ phoneE164: message.data.phoneE164, body: composePartsSmsMessage({
            partCount: message.data.parts, workOrderCount: message.data.workOrders,
            previewWorkOrderIds: message.data.previewIds, portalUrl: deps.portalUrl,
          }) }, options.signal);
        } catch { outcome = { status: "unknown", code: "TWILIO_UNKNOWN" }; }
      }
      try {
        const receipt = completionSchema.parse(await deps.complete(id, token, outcome));
        if (receipt.id !== id || receipt.state !== expectedState(outcome)) throw new Error("COMPLETION_MISMATCH");
      } catch {
        // Acceptance plus lost DB completion is NOT a known-unsent failure.
        // Leave the started attempt to lease recovery; never resend it here.
        stats.completionUnconfirmed++; stats.unknown++; resultCode = "RUN_PARTIAL"; break;
      }
      if (outcome.status === "accepted") {
        stats.accepted++;
        if (outcome.providerStatus === "failed" || outcome.providerStatus === "undelivered") stats.failed++;
        else if (outcome.providerStatus === "delivered") stats.deliveredUpdates++;
      }
      else if (outcome.status === "unknown") stats.unknown++;
      else if (outcome.status === "known_unsent_retryable") stats.retryableFailed++;
      else if (expectedState(outcome) === "not_deliverable") stats.notDeliverable++;
      else stats.failed++;
      if (outcome.status !== "accepted" && outcome.code === "TWILIO_NOT_CONFIGURED") { resultCode = "TWILIO_NOT_CONFIGURED"; break; }
      if (outcome.status === "known_unsent_retryable") break;
    }
    if (options.signal?.aborted) resultCode = "TIME_BUDGET_EXCEEDED";
    // A correctly blocked recurrence is visible policy evidence, not a worker
    // failure or confirmation that an SMS was sent. Its count remains separate.
    else if (resultCode === "RUN_COMPLETE" && (stats.unknown + stats.recoveredUnknown + stats.failed + stats.notDeliverable + stats.retryableFailed + stats.statusUnavailable + stats.statusStale > 0)) resultCode = "RUN_PARTIAL";
  } catch { resultCode = options.signal?.aborted ? "TIME_BUDGET_EXCEEDED" : "DATABASE_UNAVAILABLE"; }
  let heartbeatConfirmed = false;
  try {
    const receipt = finishSchema.parse(await deps.finish(runId, stats, resultCode));
    heartbeatConfirmed = receipt.runId === runId;
  } catch { /* The durable unfinished run remains visible as a crash/failure. */ }
  if (!heartbeatConfirmed) resultCode = "RUN_PARTIAL";
  return { ...stats, runId, evaluation, localDate, resultCode, heartbeatConfirmed, configurationCode };
}

export async function drainPartsSms(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<PartsSmsWorkerSummary> {
  // The migration-owned allowlist is narrower than the legacy generated schema;
  // every unknown response is parsed above before affecting delivery decisions.
  const sb = createServerClient() as unknown as ServiceRpcClient;
  const twilio = getTwilioConfig();
  const provider = createTwilioPartsSms(twilio.status === "configured" ? twilio.value : null);
  let configurationError = twilio.status === "configured" ? undefined : twilio.error;
  let portalUrl = "";
  try { portalUrl = `${getPortalOrigin()}/?view=dashboard`; }
  catch (error) { configurationError ??= error instanceof ConfigurationError ? error : new ConfigurationError("CONFIG_INVALID", "app_environment"); }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), PARTS_SMS_WORKER_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const rpc = (name: ServiceRpcName, args: Record<string, unknown>, completingRun = false): Promise<unknown> =>
    partsSmsDatabaseRequest(requestSignal => sb.rpc(name, args).abortSignal(requestSignal), completingRun ? undefined : signal);
  try {
    return await runPartsSmsWorker({
      start: runId => rpc("start_parts_sms_run_v1", { p_run_id: runId, p_release: /^[0-9a-f]{7,40}$/i.test(process.env.VERCEL_GIT_COMMIT_SHA || "") ? process.env.VERCEL_GIT_COMMIT_SHA : null }),
      enqueue: force => rpc("enqueue_parts_sms_deliveries_v1", { p_force: force }),
      claim: (token, force) => rpc("claim_parts_sms_delivery_v1", { p_claim_token: token, p_force: force }),
      prepare: (id, token, force) => rpc("prepare_parts_sms_send_v1", { p_delivery_id: id, p_claim_token: token, p_force: force }),
      send: provider.send,
      complete: (id, token, outcome) => rpc("complete_parts_sms_delivery_v1", { p_delivery_id: id, p_claim_token: token,
        p_outcome: outcome.status, p_code: outcome.status === "accepted" ? null : outcome.code,
        p_provider_message_id: outcome.status === "accepted" ? outcome.sid : null,
        p_provider_status: outcome.status === "accepted" ? outcome.providerStatus : null,
        p_retry_after_seconds: outcome.status === "known_unsent_retryable" ? outcome.retryAfterSeconds ?? null : null }),
      claimStatus: token => rpc("claim_parts_sms_status_v1", { p_claim_token: token }),
      lookup: provider.lookup,
      completeStatus: (id, token, outcome, sid) => rpc("complete_parts_sms_status_v1", { p_delivery_id: id, p_claim_token: token,
        p_status: outcome.status === "observed" ? outcome.providerStatus : "unknown",
        p_code: outcome.status === "observed" ? null : outcome.code, p_provider_message_id: sid }),
      finish: (runId, summary, result) => rpc("finish_parts_sms_run_v1", { p_run_id: runId, p_summary: summary, p_result_code: result }, true),
      operationId: randomUUID, now: Date.now, portalUrl, configurationError,
    }, { force: options.force, signal });
  } finally { clearTimeout(deadline); controller.abort(); }
}
