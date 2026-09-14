import { z } from "zod";
import { supabase } from "./supabase/client";
import type { Database } from "./supabase/database.types";
import { parseApiError } from "./errors/clientApiError";
import { financialBatchReviewResultSchema, financialHoldResultSchema, financialReceiptMatches, financialReviewResultSchema,
  FinancialNotificationCommandError, safeFinancialNotificationCommandError } from "./financialNotificationCommandContracts";

type Names = "review_contractor_invoice_with_notification_v1" | "review_contractor_invoices_with_notification_v1"
  | "retract_contractor_invoice_rejection_with_notification_v1";
type Functions = Pick<Database["public"]["Functions"], Names>;
type Session = { id: string; token: string };
export type FinancialNotificationCommandPorts = {
  session(): Promise<Session | null>;
  rpc<Name extends Names>(name: Name, args: Functions[Name]["Args"]): PromiseLike<{ data: unknown; error: unknown }>;
  reviewRevision(invoiceId: string): Promise<number>;
  holdSource(invoiceId: string): Promise<string | null>;
  holdRequest(token: string, body: { invoiceId: string; action: "hold" | "release"; reason: string;
    operationId: string; expectedSourceEventId: string | null }): Promise<{ ok: boolean; status: number; payload: unknown }>;
  operationId(): string;
};
const idsSchema = z.array(z.uuid()).min(1).max(100);
const revisionSchema = z.number().int().positive().max(999_999_999);
const reasonSchema = z.string().trim();
type Context = { revisions: Record<string, number>; sourceEventId: string | null };
type Attempt = { fingerprint: string; operationId: string; context: Context | null; sent: boolean; active: Promise<unknown> | null };

/** Memory-only, actor-scoped replay contexts. No automatic retry, stored token,
 * persistent reason, or silent eviction of an uncertain command. At most 100
 * invoice slots; a batch shares one operation. Cleared on logout/actor change. */
export function createFinancialNotificationCommands(ports: FinancialNotificationCommandPorts) {
  const attempts = new Map<string, Attempt>();
  let actorId: string | null = null;
  function reset() { attempts.clear(); actorId = null; }
  async function run<T>(invoiceIds: string[], input: unknown, prepare: () => Promise<Context>,
    send: (context: Context, operationId: string, session: Session) => Promise<unknown>, parse: (data: unknown, operationId: string) => T): Promise<T> {
    const session = await ports.session();
    if (!session) { reset(); throw new FinancialNotificationCommandError("AUTH_REQUIRED"); }
    if (actorId !== session.id) { reset(); actorId = session.id; }
    const fingerprint = JSON.stringify(input);
    const prior = invoiceIds.map(id => attempts.get(id)).find(Boolean);
    if (prior && (prior.fingerprint !== fingerprint || invoiceIds.some(id => attempts.get(id) !== prior))) {
      throw new FinancialNotificationCommandError("OPERATION_REUSED");
    }
    if (!prior && attempts.size + invoiceIds.length > 100) throw new FinancialNotificationCommandError("REQUEST_CAPACITY");
    const attempt = prior ?? { fingerprint, operationId: z.uuid().parse(ports.operationId()), context: null, sent: false, active: null };
    invoiceIds.forEach(id => attempts.set(id, attempt));
    if (attempt.active) return parse(await attempt.active, attempt.operationId);
    const task = (async () => {
      try {
        attempt.context ??= await prepare();
        const currentSession = await ports.session();
        if (!currentSession || currentSession.id !== session.id) throw new FinancialNotificationCommandError("AUTH_REQUIRED");
        attempt.sent = true;
        const data = await send(attempt.context, attempt.operationId, currentSession);
        parse(data, attempt.operationId);
        invoiceIds.forEach(id => { if (attempts.get(id) === attempt) attempts.delete(id); });
        return data;
      } catch (cause) {
        const error = safeFinancialNotificationCommandError(cause);
        if (!attempt.sent || !error.uncertain) invoiceIds.forEach(id => { if (attempts.get(id) === attempt) attempts.delete(id); });
        throw error;
      } finally { attempt.active = null; }
    })();
    attempt.active = task;
    return parse(await task, attempt.operationId);
  }
  async function rpc<Name extends Names>(name: Name, args: Functions[Name]["Args"]) {
    const { data, error } = await ports.rpc(name, args);
    if (error) throw error;
    return data;
  }
  function verified<T>(schema: z.ZodType<T>, data: unknown, check: (result: T) => boolean): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success || !check(parsed.data)) throw new FinancialNotificationCommandError("RESULT_UNCONFIRMED");
    return parsed.data;
  }
  async function revisions(ids: string[], expected?: Record<string, number>): Promise<Record<string, number>> {
    if (expected) {
      const parsed = z.record(z.uuid(), revisionSchema).parse(expected);
      if (Object.keys(parsed).length !== ids.length || ids.some(id => !parsed[id])) throw new FinancialNotificationCommandError("VALIDATION_FAILED");
      return Object.fromEntries(ids.map(id => [id, parsed[id]]));
    }
    const result: Record<string, number> = {};
    // Legacy approve callers omit a revision. Resolve only the bounded selection,
    // serially, once; retries retain this exact snapshot.
    for (const id of ids) result[id] = revisionSchema.parse(await ports.reviewRevision(id));
    return result;
  }
  return {
    reset,
    async prepareHold(invoiceId: string) {
      try {
        const id = z.uuid().parse(invoiceId);
        if (!await ports.session()) throw new FinancialNotificationCommandError("AUTH_REQUIRED");
        return { invoiceId: id, expectedSourceEventId: z.uuid().nullable().parse(await ports.holdSource(id)) };
      } catch (error) { throw safeFinancialNotificationCommandError(error); }
    },
    async review(invoiceId: string, action: "approve" | "reject", reason?: string | null, expectedRevision?: number) {
      try {
        const id = z.uuid().parse(invoiceId); const verb = z.enum(["approve", "reject"]).parse(action);
        const text = reasonSchema.parse(reason ?? "");
        if (verb === "reject" && !text) throw new FinancialNotificationCommandError("VALIDATION_FAILED");
        const expected = expectedRevision === undefined ? undefined : { [id]: revisionSchema.parse(expectedRevision) };
        return await run([id], { kind: "review", id, verb, text }, async () => ({ revisions: await revisions([id], expected), sourceEventId: null }),
          (context, operationId) => rpc("review_contractor_invoice_with_notification_v1", { p_invoice_id: id, p_action: verb,
            p_reason: text || null, p_operation_id: operationId, p_expected_revision: context.revisions[id] }),
          (data, operationId) => verified(financialReviewResultSchema, data, result => result.invoiceId === id && result.operationId === operationId
            && result.invoiceState === (verb === "approve" ? "approved" : "rejected")
            && financialReceiptMatches(result, verb === "approve" ? null : "invoice_rejected")));
      } catch (error) { throw safeFinancialNotificationCommandError(error); }
    },
    async batch(invoiceIds: string[], action: "approve" | "reject", reason?: string | null, expectedRevisions?: Record<string, number>) {
      try {
        const ids = [...new Set(idsSchema.parse(invoiceIds))].sort(); const verb = z.enum(["approve", "reject"]).parse(action);
        const text = reasonSchema.parse(reason ?? "");
        if (verb === "reject" && !text) throw new FinancialNotificationCommandError("VALIDATION_FAILED");
        const expected = expectedRevisions ? await revisions(ids, expectedRevisions) : undefined;
        return await run(ids, { kind: "batch", ids, verb, text }, async () => ({ revisions: await revisions(ids, expected), sourceEventId: null }),
          (context, operationId) => rpc("review_contractor_invoices_with_notification_v1", { p_invoice_ids: ids, p_action: verb,
            p_reason: text || null, p_operation_id: operationId, p_expected_revisions: context.revisions }),
          (data, operationId) => verified(financialBatchReviewResultSchema, data, result => result.operationId === operationId && result.action === verb
            && result.count === ids.length && [...result.invoiceIds].sort().join() === ids.join() && result.results.length === ids.length
            && [...new Set(result.results.map(item => item.invoiceId))].sort().join() === ids.join()
            && result.results.every(item => item.invoiceState === (verb === "approve" ? "approved" : "rejected")
              && financialReceiptMatches(item, verb === "approve" ? null : "invoice_rejected"))));
      } catch (error) { throw safeFinancialNotificationCommandError(error); }
    },
    async retract(invoiceId: string, expectedRevision?: number) {
      try {
        const id = z.uuid().parse(invoiceId);
        const expected = expectedRevision === undefined ? undefined : { [id]: revisionSchema.parse(expectedRevision) };
        return await run([id], { kind: "retract", id }, async () => ({ revisions: await revisions([id], expected), sourceEventId: null }),
          (context, operationId) => rpc("retract_contractor_invoice_rejection_with_notification_v1", {
            p_invoice_id: id, p_operation_id: operationId, p_expected_revision: context.revisions[id] }),
          (data, operationId) => verified(financialReviewResultSchema, data, result => result.invoiceId === id && result.operationId === operationId
            && result.invoiceState === "approved" && financialReceiptMatches(result, "invoice_rejection_retracted")));
      } catch (error) { throw safeFinancialNotificationCommandError(error); }
    },
    async hold(invoiceId: string, action: "hold" | "release", reason: string, expectedSourceEventId?: string | null) {
      try {
        const id = z.uuid().parse(invoiceId); const verb = z.enum(["hold", "release"]).parse(action);
        const text = reasonSchema.min(1).max(500).parse(reason);
        const expected = expectedSourceEventId === undefined ? undefined : z.uuid().nullable().parse(expectedSourceEventId);
        return await run([id], { kind: "hold", id, verb, text }, async () => ({ revisions: {}, sourceEventId: expected === undefined
          ? z.uuid().nullable().parse(await ports.holdSource(id)) : expected }),
          async (context, operationId, session) => {
            const response = await ports.holdRequest(session.token, { invoiceId: id, action: verb, reason: text, operationId, expectedSourceEventId: context.sourceEventId });
            if (!response.ok) {
              if (response.status === 401) throw new FinancialNotificationCommandError("AUTH_REQUIRED");
              if (response.status === 403) throw new FinancialNotificationCommandError("FORBIDDEN");
              throw safeFinancialNotificationCommandError(response.payload);
            }
            const parsed = z.object({ result: z.unknown() }).safeParse(response.payload);
            return parsed.success ? parsed.data.result : null;
          }, (data, operationId) => verified(financialHoldResultSchema, data, result => result.invoiceId === id && result.operationId === operationId
            && financialReceiptMatches(result, result.applied ? verb === "hold" ? "payment_hold_placed" : "payment_hold_released" : null)));
      } catch (error) { throw safeFinancialNotificationCommandError(error); }
    },
  };
}

let currentCommands: ReturnType<typeof createFinancialNotificationCommands> | null = null;
function commands() {
  if (currentCommands) return currentCommands;
  const sb = supabase();
  currentCommands = createFinancialNotificationCommands({
    session: async () => { const { data, error } = await sb.auth.getSession(); if (error) throw safeFinancialNotificationCommandError(error);
      return data.session ? { id: data.session.user.id, token: data.session.access_token } : null; },
    rpc: (name, args) => sb.rpc(name, args),
    reviewRevision: async invoiceId => {
      const { data, error } = await sb.from("invoices").select("review_revision").eq("id", invoiceId).single();
      if (error) throw safeFinancialNotificationCommandError(error);
      return z.object({ review_revision: revisionSchema }).parse(data).review_revision;
    },
    holdSource: async invoiceId => {
      const { data, error } = await sb.rpc("get_financial_notification_status_v1", { p_invoice_id: invoiceId, p_cursor: null, p_limit: 1 });
      if (error) throw safeFinancialNotificationCommandError(error);
      return z.object({ latestHoldSourceEventId: z.uuid().nullable() }).parse(data).latestHoldSourceEventId;
    },
    holdRequest: async (token, body) => {
      const response = await fetch("/api/contractor-invoice-holds", { method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { ok: response.ok, status: response.status, payload: response.ok
        ? await response.json().catch(() => null) : await parseApiError(response) };
    },
    operationId: () => crypto.randomUUID(),
  });
  // Supabase may emit SIGNED_IN again on tab focus; that must not discard an
  // uncertain operation. Different actors are cleared by run(), logout here.
  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") currentCommands?.reset(); });
  return currentCommands;
}
export const reviewInvoiceWithNotification = (invoiceId: string, action: "approve" | "reject", reason?: string | null, expectedRevision?: number) =>
  commands().review(invoiceId, action, reason, expectedRevision);
export const reviewInvoicesWithNotification = (invoiceIds: string[], action: "approve" | "reject", reason?: string | null, expectedRevisions?: Record<string, number>) =>
  commands().batch(invoiceIds, action, reason, expectedRevisions);
export const retractInvoiceWithNotification = (invoiceId: string, expectedRevision?: number) => commands().retract(invoiceId, expectedRevision);
export const prepareInvoicePaymentHold = (invoiceId: string) => commands().prepareHold(invoiceId);
export const updateInvoicePaymentHold = (invoiceId: string, action: "hold" | "release", reason: string, expectedSourceEventId?: string | null) =>
  commands().hold(invoiceId, action, reason, expectedSourceEventId);
