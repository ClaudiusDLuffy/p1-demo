import {
  type GraphEmail,
  getAccessToken,
  getDispatchInboxEmails,
  getOrCreateFolder,
  markEmailRead,
  moveEmailToFolder,
} from "./graphClient";
import {
  isConfirmedWorkOrderIntakeEmail,
  parseDispatchEmail,
  type ParsedWorkOrder,
} from "./emailParser";
import { resolveContractor } from "./autoDispatch";
import { normalizeStateCode, timezoneForWorkOrder } from "./billingRules";
import {
  intakeStateActivationDecision,
  intakeStateBlockReason,
} from "./intakeStatePolicy";
import { createServerClient } from "./supabase/server";
import { sendDispatchNotification } from "./notificationService";
import {
  chooseIntakeWorkOrderMatch,
  type IntakeWorkOrderMatch,
  type WorkOrderMatchCandidate,
} from "./emailIntakeMatching";
import { intakeErrorMessage } from "./intakeError";
import {
  BILLING_ONLY_ACTIVITY,
  BILLING_ONLY_INTAKE_REASON,
  billingOnlyIntakeFields,
} from "./emailIntakeWorkflow";
import type { Database } from "./supabase/database.types";
import {
  emailPrioritySourceMessageId,
  priorityIntakeCutoverDecision,
  priorityEscalationSlaFields,
} from "./emailPriorityEscalation";
import {
  applyEmailPriorityEscalation,
  drainPendingPriorityEscalationNotifications,
} from "./emailPriorityEscalationProcessor";
import { drainEmailAssignmentRemovals } from "./emailAssignmentRemovalProcessor";

type WorkOrderInsert = Database["public"]["Tables"]["work_orders"]["Insert"];
type WorkOrderUpdate = Database["public"]["Tables"]["work_orders"]["Update"];
type IntakeLogClient = {
  from: (table: "email_intake_log") => {
    insert: (row: Record<string, unknown>) => PromiseLike<{
      error: { message: string } | null;
    }>;
  };
};

export type IntakeResult = {
  emailId: string;
  subject: string;
  action: "created" | "updated" | "skipped" | "failed";
  workOrderId: string | null;
  reason: string;
  parseConfidence: "high" | "medium" | "low";
  contractorAssigned: string | null;
  processedAt: string;
};

const stateAllowlistReason = (state: string | null) => {
  return intakeStateBlockReason(
    state,
    process.env.EMAIL_INTAKE_ALLOWED_STATES,
    process.env.EMAIL_INTAKE_TEXAS_ENABLED,
  );
};

const stateActivationDecision = (
  state: string | null,
  receivedAt: string | null,
) => {
  return intakeStateActivationDecision(
    state,
    receivedAt,
    process.env.EMAIL_INTAKE_FLORIDA_START_AT,
  );
};

const priorityCutoverDecision = (receivedAt: string) =>
  priorityIntakeCutoverDecision(
    receivedAt,
    process.env.EMAIL_PRIORITY_INTAKE_START_AT,
  );

const compactPatch = (parsed: ParsedWorkOrder) => {
  const patch: WorkOrderUpdate = {};
  if (parsed.incidentId) patch.incident_id = parsed.incidentId;
  if (parsed.storeNumber) patch.store_number = parsed.storeNumber;
  if (parsed.summary) patch.summary = parsed.summary;
  if (parsed.description) patch.description = parsed.description;
  if (parsed.afmName) patch.afm_name = parsed.afmName;
  if (parsed.city) patch.city = parsed.city;
  if (parsed.address) patch.address = parsed.address;
  const storeState = normalizeStateCode(parsed.state);
  if (storeState) {
    patch.store_state = storeState;
    patch.store_timezone = timezoneForWorkOrder({ storeState });
  }
  if (parsed.nte !== null) patch.nte = parsed.nte;
  if (parsed.lineOfService) patch.line_of_service = parsed.lineOfService;
  if (parsed.businessService) patch.business_service = parsed.businessService;
  if (parsed.category) patch.category = parsed.category;
  if (parsed.subCategory) patch.sub_category = parsed.subCategory;
  patch.source = "email_intake";
  return patch;
};

const saveAfmContact = async (workOrderId: string, afmEmail: string | null) => {
  const email = String(afmEmail || "").trim();
  if (!email) return;
  const sb = createServerClient();
  const { error } = await sb.from("work_order_afm_contacts").upsert({
    work_order_id: workOrderId,
    afm_email: email,
  });
  if (error) throw error;
};

const findWorkOrderMatch = async (parsed: ParsedWorkOrder): Promise<IntakeWorkOrderMatch | null> => {
  const sb = createServerClient();
  const ids = [...new Set([parsed.wotId, parsed.fwkdId].filter(Boolean) as string[])];
  const candidates: WorkOrderMatchCandidate[] = [];

  for (const id of ids) {
    const [exactResult, continuationResult] = await Promise.all([
      sb
        .from("work_orders")
        .select("id,deleted_at")
        .eq("id", id)
        .maybeSingle(),
      /^WOT\d{6,12}$/i.test(id)
        ? sb
          .from("work_orders")
          .select("id,deleted_at,duplicate_sequence")
          .eq("duplicate_root_work_order_id", id)
          .order("duplicate_sequence", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (exactResult.error) {
      throw new Error(
        `Work order lookup failed for ${id}: ${exactResult.error.message}`,
      );
    }
    if (continuationResult.error) {
      throw new Error(
        `Work-order continuation lookup failed for ${id}: ${continuationResult.error.message}`,
      );
    }
    if (exactResult.data?.id) {
      candidates.push({
        id: exactResult.data.id,
        deletedAt: exactResult.data.deleted_at,
        matchedBy: "work_order_id",
      });
    }
    for (const continuation of continuationResult.data || []) {
      candidates.push({
        id: continuation.id,
        deletedAt: continuation.deleted_at,
        matchedBy: "canonical_work_order_id",
        duplicateSequence: continuation.duplicate_sequence,
      });
    }
  }

  return chooseIntakeWorkOrderMatch(candidates);
};

const addSystemActivity = async (
  workOrderId: string,
  text: string,
  options: { eventKey?: string; staffOnly?: boolean } = {},
) => {
  const sb = createServerClient();
  const { error } = await sb.from("activities").insert({
    work_order_id: workOrderId,
    author_name: "System",
    text,
    type: "system",
    is_staff_only: options.staffOnly || false,
    ...(options.eventKey ? { event_key: options.eventKey } : {}),
  });
  if (error) throw error;
};

const skippedResult = (
  result: IntakeResult,
  reason: string,
  workOrderId: string | null = null,
): IntakeResult => ({
  ...result,
  action: "skipped",
  workOrderId,
  reason,
});

const insertLog = async (email: GraphEmail, result: IntakeResult) => {
  try {
    const sb = createServerClient();
    const logClient = sb as unknown as IntakeLogClient;
    const { error } = await logClient.from("email_intake_log").insert({
      email_id: result.emailId,
      subject: result.subject,
      action: result.action,
      work_order_id: result.workOrderId,
      reason: result.reason,
      parse_confidence: result.parseConfidence,
      contractor_assigned: result.contractorAssigned,
      raw_subject: email.subject,
      raw_from: email.from?.emailAddress?.address || null,
      processed_at: result.processedAt,
    });
    if (error) console.error("Email intake log insert failed", error);
  } catch (err) {
    console.error("Email intake log insert error", err);
  }
};

const finishEmail = async (email: GraphEmail, folderId: string) => {
  const accessToken = await getAccessToken();
  if (!accessToken) return;
  await markEmailRead(accessToken, email.id);
  await moveEmailToFolder(accessToken, email.id, folderId);
};

const finalizeEmailProcessing = async (
  email: GraphEmail,
  folderId: string,
  result: IntakeResult,
  shouldFinishEmail: boolean,
): Promise<IntakeResult> => {
  let finalizedResult = result;
  if (shouldFinishEmail) {
    try {
      await finishEmail(email, folderId);
    } catch (err) {
      const finishReason = intakeErrorMessage(
        err,
        "unknown mailbox finalization error",
      );
      console.error("Email intake mailbox finalization failed", finishReason);
      finalizedResult = {
        ...finalizedResult,
        reason: `${finalizedResult.reason}; mailbox finalization failed: ${finishReason}`,
      };
    }
  }

  await insertLog(email, finalizedResult);
  return finalizedResult;
};

export async function processEmail(
  email: GraphEmail,
  folderId: string,
): Promise<IntakeResult> {
  const parsed = parseDispatchEmail(email);
  const processedAt = new Date().toISOString();
  let result: IntakeResult = {
    emailId: email.id,
    subject: email.subject,
    action: "skipped",
    workOrderId: null,
    reason: "not processed",
    parseConfidence: parsed.parseConfidence,
    contractorAssigned: null,
    processedAt,
  };

  let shouldFinishEmail = true;

  if (!isConfirmedWorkOrderIntakeEmail(email)) {
    result = skippedResult(
      result,
      "not a confirmed direct 7-Eleven dispatch or priority update; mailbox left unchanged",
    );
    await insertLog(email, result);
    return result;
  }

  try {
    const allowlistReason = stateAllowlistReason(parsed.state);

    if (parsed.emailType === "TYPE_NTE_APPROVED") {
      result = skippedResult(result, "NTE email ignored by intake policy");
    } else if (parsed.emailType === "TYPE_UNKNOWN") {
      result = skippedResult(result, "unknown email type");
    } else if (parsed.emailType === "TYPE_DISPATCHED") {
      if (!parsed.wotId) {
        result = skippedResult(result, "initial dispatch is missing a WOT number");
      } else if (parsed.priorityConflict) {
        shouldFinishEmail = false;
        result = {
          ...result,
          action: "failed",
          reason: "initial dispatch contains conflicting subject and body priorities; mailbox left unchanged",
        };
      } else if (parsed.parseConfidence !== "high") {
        shouldFinishEmail = false;
        result = {
          ...result,
          action: "failed",
          reason: "initial dispatch store number could not be parsed; mailbox left unchanged",
        };
      } else if (allowlistReason) {
        result = skippedResult(result, allowlistReason);
      } else {
        const activationDecision = stateActivationDecision(
          parsed.state,
          email.receivedDateTime,
        );

        if (activationDecision.action === "hold") {
          shouldFinishEmail = false;
          result = {
            ...result,
            action: "failed",
            reason: activationDecision.reason,
          };
        } else if (activationDecision.action === "skip") {
          result = skippedResult(result, activationDecision.reason);
        } else {
          const sb = createServerClient();
          const match = await findWorkOrderMatch(parsed);

          if (match?.archived) {
            result = skippedResult(
              result,
              "initial dispatch matched an archived work order; archived row was not recreated",
              match.id,
            );
          } else if (match) {
            if (!parsed.priority) {
              shouldFinishEmail = false;
              result = {
                ...result,
                action: "failed",
                workOrderId: match.id,
                reason: "repeat dispatch is missing a valid priority; mailbox left unchanged",
              };
              return await finalizeEmailProcessing(email, folderId, result, shouldFinishEmail);
            }
            const cutover = priorityCutoverDecision(email.receivedDateTime);
            if (cutover.action === "hold") {
              shouldFinishEmail = false;
              result = {
                ...result,
                action: "failed",
                workOrderId: match.id,
                reason: cutover.reason,
              };
              return await finalizeEmailProcessing(
                email,
                folderId,
                result,
                shouldFinishEmail,
              );
            }
            if (cutover.action === "skip") {
              result = skippedResult(result, cutover.reason, match.id);
              return await finalizeEmailProcessing(
                email,
                folderId,
                result,
                shouldFinishEmail,
              );
            }

            const patch: WorkOrderUpdate = {
              ...compactPatch(parsed),
              ...(parsed.doNotDispatch
                ? billingOnlyIntakeFields(email.receivedDateTime || processedAt)
                : {}),
            };
            const priorityUpdate = await applyEmailPriorityEscalation(
              match.id,
              parsed,
              email,
              patch,
            );
            if (!priorityUpdate) {
              throw new Error("Repeat dispatch priority could not be validated");
            }
            const resolvedWorkOrderId = priorityUpdate.workOrderId;
            if (priorityUpdate.replayed || ["stale", "non_operational"].includes(priorityUpdate.outcome)) {
              result = skippedResult(
                result,
                priorityUpdate.replayed
                  ? "repeat dispatch was already processed; current metadata preserved"
                  : "repeat dispatch is stale or no longer operational; current metadata preserved",
                resolvedWorkOrderId,
              );
              return await finalizeEmailProcessing(email, folderId, result, shouldFinishEmail);
            }
            result = {
              ...result,
              action: "updated",
              workOrderId: resolvedWorkOrderId,
              reason: parsed.doNotDispatch
                ? "existing active work order refreshed and routed to billing without contractor dispatch"
                : priorityUpdate?.outcome === "escalated"
                  ? `existing active work order refreshed; priority escalated ${priorityUpdate.previousPriority.toUpperCase()} to ${priorityUpdate.reportedPriority.toUpperCase()} and staff notification ${priorityUpdate.notificationStatus}`
                  : "existing active work order refreshed from initial dispatch",
            };
          } else {
            const billingOnly = parsed.doNotDispatch;
            const contractor = billingOnly ? null : await resolveContractor(parsed);
            const workOrderId = parsed.wotId;
            const priority = parsed.priority || "p2";
            const receivedAt = new Date(email.receivedDateTime || processedAt);
            if (!Number.isFinite(receivedAt.getTime())) {
              throw new Error("Initial dispatch email has an invalid received time");
            }
            const receivedAtIso = receivedAt.toISOString();
            const billingOnlyFields = billingOnly
              ? billingOnlyIntakeFields(receivedAtIso)
              : {};
            const slaStartedAt = billingOnly ? null : receivedAtIso;
            const sla = priorityEscalationSlaFields(priority, slaStartedAt);
            const row: WorkOrderInsert = {
              id: workOrderId,
              store_number: parsed.storeNumber,
              summary: parsed.summary,
              description: parsed.description,
              priority,
              status: contractor?.contractorId ? "assigned" : "unassigned",
              functional_status: "New",
              contractor_id: contractor?.contractorId || null,
              afm_name: parsed.afmName,
              afm_email: null,
              city: parsed.city,
              address: parsed.address,
              store_state: normalizeStateCode(parsed.state) || null,
              store_timezone: timezoneForWorkOrder({ storeState: parsed.state }),
              nte: parsed.nte || 0,
              line_of_service: parsed.lineOfService,
              business_service: parsed.businessService,
              category: parsed.category,
              sub_category: parsed.subCategory,
              incident_id: parsed.incidentId,
              source: "email_intake",
              dispatched_at: receivedAtIso,
              sla_started_at: slaStartedAt,
              response_breach_at: sla.responseBreachAt,
              resolution_breach_at: sla.resolutionBreachAt,
              ...(parsed.priority
                ? {
                    priority_source_message_id: emailPrioritySourceMessageId(email),
                    priority_source_received_at: receivedAtIso,
                  }
                : {}),
              created_at: processedAt,
              ...billingOnlyFields,
            };

            const { error } = await sb.from("work_orders").insert(row);
            if (error) throw error;
            await saveAfmContact(workOrderId, parsed.afmEmail);

            if (billingOnly) {
              await addSystemActivity(workOrderId, BILLING_ONLY_ACTIVITY, {
                eventKey: "straight_to_billing",
                staffOnly: true,
              });
            } else if (contractor) {
              await sendDispatchNotification({
                workOrder: {
                  id: workOrderId,
                  incidentId: parsed.incidentId,
                  storeNumber: parsed.storeNumber,
                  city: parsed.city,
                  state: parsed.state,
                  address: parsed.address,
                  priority,
                  summary: parsed.summary,
                  description: parsed.description,
                },
                contractorAssigned: Boolean(contractor.contractorId),
                contractorEmail: contractor.contractorEmail,
                contractorName: contractor.contractorName,
              }).catch(err => console.error("Dispatch notification failed", err));
            }

            result = {
              ...result,
              action: "created",
              workOrderId,
              reason: billingOnly
                ? BILLING_ONLY_INTAKE_REASON
                : contractor?.reason || "work order created without an assignment",
              contractorAssigned: contractor?.contractorId || null,
            };
          }
        }
      }
    } else if (parsed.emailType === "TYPE_PRIORITY_UPDATE") {
      if (!parsed.wotId && !parsed.fwkdId) {
        result = skippedResult(result, "priority update is missing a work order number");
      } else if (!parsed.priority) {
        shouldFinishEmail = false;
        result = {
          ...result,
          action: "failed",
          reason: parsed.priorityConflict
            ? "priority update contains conflicting subject and body priorities; mailbox left unchanged"
            : "priority update did not contain a valid P1-P5 priority; mailbox left unchanged",
        };
      } else {
        const cutover = priorityCutoverDecision(email.receivedDateTime);
        if (cutover.action === "hold") {
          shouldFinishEmail = false;
          result = {
            ...result,
            action: "failed",
            reason: cutover.reason,
          };
          return await finalizeEmailProcessing(
            email,
            folderId,
            result,
            shouldFinishEmail,
          );
        }
        if (cutover.action === "skip") {
          result = skippedResult(result, cutover.reason);
          return await finalizeEmailProcessing(
            email,
            folderId,
            result,
            shouldFinishEmail,
          );
        }

        const match = await findWorkOrderMatch(parsed);

        if (match?.archived) {
          result = skippedResult(
            result,
            "priority update matched an archived work order; archived row was not updated",
            match.id,
          );
        } else if (!match) {
          result = skippedResult(
            result,
            "priority update did not match an active work order; no work order was created",
          );
        } else {
          const priorityUpdate = await applyEmailPriorityEscalation(
            match.id,
            parsed,
            email,
          );

          if (!priorityUpdate) {
            throw new Error("Priority update could not be validated");
          }

          result = priorityUpdate.outcome === "escalated"
            ? {
                ...result,
                action: "updated",
                workOrderId: priorityUpdate.workOrderId,
                reason: `priority escalated ${priorityUpdate.previousPriority.toUpperCase()} to ${priorityUpdate.reportedPriority.toUpperCase()}; staff notification ${priorityUpdate.notificationStatus}`,
              }
            : skippedResult(
                result,
                priorityUpdate.outcome === "stale"
                  ? "stale priority update ignored"
                  : priorityUpdate.outcome === "non_operational"
                    ? "priority update matched a completed, cancelled, or billing-stage work order; operational state was not changed"
                  : priorityUpdate.outcome === "not_escalation"
                    ? "lower-urgency priority update recorded but not applied automatically"
                    : "priority update matched the current priority",
                priorityUpdate.workOrderId,
              );
        }
      }
    } else if (
      parsed.emailType === "TYPE_CAPITAL_PENDING" ||
      parsed.emailType === "TYPE_STATE_UPDATE"
    ) {
      if (!parsed.wotId && !parsed.fwkdId) {
        result = skippedResult(result, "status email is missing a work order number");
      } else if (parsed.state && allowlistReason) {
        result = skippedResult(result, allowlistReason);
      } else {
        const match = await findWorkOrderMatch(parsed);

        if (match?.archived) {
          result = skippedResult(
            result,
            "status email matched an archived work order; archived row was not updated",
            match.id,
          );
        } else if (!match) {
          result = skippedResult(result, "status email did not match an active work order");
        } else if (parsed.emailType === "TYPE_CAPITAL_PENDING") {
          const sb = createServerClient();
          const { error } = await sb
            .from("work_orders")
            .update({ status: "capital", is_capital: true })
            .eq("id", match.id)
            .is("deleted_at", null);

          if (error) throw error;
          await addSystemActivity(match.id, "Capital approval pending");
          result = {
            ...result,
            action: "updated",
            workOrderId: match.id,
            reason: "capital status noted on existing active work order",
          };
        } else {
          const statusLabel = parsed.functionalState || parsed.rawSubject || "status not provided";
          await addSystemActivity(match.id, `7-Eleven status update: ${statusLabel}`);
          result = {
            ...result,
            action: "updated",
            workOrderId: match.id,
            reason: "7-Eleven status noted on existing active work order",
          };
        }
      }
    } else {
      result = skippedResult(result, "unsupported email type");
    }
  } catch (err) {
    console.error("Email intake processing failed", err);
    shouldFinishEmail = false;
    result = {
      ...result,
      action: "failed",
      reason: intakeErrorMessage(err, "unknown processing error"),
    };
  }

  return finalizeEmailProcessing(email, folderId, result, shouldFinishEmail);
}

export async function runIntakeCycle(): Promise<IntakeResult[]> {
  const accessToken = await getAccessToken();
  const folderId = await getOrCreateFolder(accessToken);
  const emails = await getDispatchInboxEmails(accessToken);
  const results: IntakeResult[] = [];
  for (const email of emails) {
    results.push(await processEmail(email, folderId));
  }
  await Promise.all([
    drainPendingPriorityEscalationNotifications(accessToken).catch(error => {
      console.error("Priority escalation outbox drain failed", error);
    }),
    drainEmailAssignmentRemovals(accessToken).catch(error => {
      console.error("Email assignment-removal outbox drain failed", error);
    }),
  ]);
  return results;
}
