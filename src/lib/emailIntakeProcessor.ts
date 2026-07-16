import {
  type GraphEmail,
  getAccessToken,
  getOrCreateFolder,
  getUnreadDispatchEmails,
  markEmailRead,
  moveEmailToFolder,
} from "./graphClient";
import { parseDispatchEmail, type ParsedWorkOrder } from "./emailParser";
import { resolveContractor } from "./autoDispatch";
import { createServerClient } from "./supabase/server";
import { sendDispatchNotification } from "./notificationService";

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

const generateWOId = () => `EMAIL-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

const getAllowedIntakeStates = () => {
  const raw = process.env.EMAIL_INTAKE_ALLOWED_STATES;
  if (!raw) return null;

  const states = raw
    .split(",")
    .map(state => state.trim().toUpperCase())
    .filter(Boolean);

  if (states.length === 0 || states.includes("ALL") || states.includes("*")) {
    return null;
  }

  return states;
};

const stateAllowlistReason = (state: string | null) => {
  const allowedStates = getAllowedIntakeStates();
  if (!allowedStates) return null;

  const normalizedState = state?.trim().toUpperCase() || "";
  if (!normalizedState) {
    return `state missing; allowed intake states: ${allowedStates.join(", ")}`;
  }

  if (!allowedStates.includes(normalizedState)) {
    return `state ${normalizedState} not in allowed intake states: ${allowedStates.join(", ")}`;
  }

  return null;
};

const compactPatch = (parsed: ParsedWorkOrder) => {
  const patch: Record<string, unknown> = {};
  if (parsed.incidentId) patch.incident_id = parsed.incidentId;
  if (parsed.storeNumber) patch.store_number = parsed.storeNumber;
  if (parsed.summary) patch.summary = parsed.summary;
  if (parsed.description) patch.description = parsed.description;
  if (parsed.priority) patch.priority = parsed.priority;
  if (parsed.afmName) patch.afm_name = parsed.afmName;
  if (parsed.afmEmail) patch.afm_email = parsed.afmEmail;
  if (parsed.city) patch.city = parsed.city;
  if (parsed.address) patch.address = parsed.address;
  if (parsed.nte !== null) patch.nte = parsed.nte;
  if (parsed.lineOfService) patch.line_of_service = parsed.lineOfService;
  if (parsed.businessService) patch.business_service = parsed.businessService;
  if (parsed.category) patch.category = parsed.category;
  if (parsed.subCategory) patch.sub_category = parsed.subCategory;
  patch.source = "email_intake";
  return patch;
};

const findExistingWorkOrder = async (parsed: ParsedWorkOrder) => {
  const sb = createServerClient();
  const ids = [parsed.wotId, parsed.fwkdId].filter(Boolean) as string[];
  for (const id of ids) {
    const { data, error } = await sb
      .from("work_orders")
      .select("id")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) {
      console.error("Email intake dedup lookup failed", error);
      continue;
    }
    if (data?.id) return data.id;
  }
  return null;
};

const addSystemActivity = async (workOrderId: string, text: string) => {
  const sb = createServerClient();
  const { error } = await (sb as any).from("activities").insert({
    work_order_id: workOrderId,
    author_name: "System",
    text,
    type: "system",
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
    const { error } = await (sb as any).from("email_intake_log").insert({
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

  try {
    const allowlistReason = stateAllowlistReason(parsed.state);

    if (parsed.doNotDispatch) {
      result = skippedResult(result, "do not dispatch flag detected");
    } else if (parsed.emailType === "TYPE_UNKNOWN") {
      result = skippedResult(result, "unknown email type");
    } else if (parsed.parseConfidence === "low") {
      result = skippedResult(result, "low parse confidence; manual review needed");
    } else if (allowlistReason) {
      result = skippedResult(result, allowlistReason);
    } else if (parsed.emailType === "TYPE_NTE_APPROVED") {
      const existingId = await findExistingWorkOrder(parsed);
      if (!existingId) {
        result = skippedResult(result, "NTE approved email did not match an existing work order");
      } else {
        await addSystemActivity(existingId, "NTE approved by 7-Eleven");
        result = {
          ...result,
          action: "updated",
          workOrderId: existingId,
          reason: "NTE approval noted on existing work order",
        };
      }
    } else if (parsed.emailType === "TYPE_CAPITAL_PENDING") {
      const existingId = await findExistingWorkOrder(parsed);
      if (!existingId) {
        result = skippedResult(result, "capital pending email did not match an existing work order");
      } else {
        const sb = createServerClient();
        const { error } = await sb
          .from("work_orders")
          .update({ status: "capital" })
          .eq("id", existingId);
        if (error) throw error;
        await addSystemActivity(existingId, "Capital approval pending");
        result = {
          ...result,
          action: "updated",
          workOrderId: existingId,
          reason: "capital approval pending noted on existing work order",
        };
      }
    } else if (parsed.emailType === "TYPE_STATE_UPDATE") {
      const existingId = await findExistingWorkOrder(parsed);
      if (!existingId) {
        result = skippedResult(result, "state update email did not match an existing work order");
      } else {
        await addSystemActivity(existingId, `7-Eleven state update: ${parsed.state || "state not provided"}`);
        result = {
          ...result,
          action: "updated",
          workOrderId: existingId,
          reason: "7-Eleven state update noted on existing work order",
        };
      }
    } else {
      const sb = createServerClient();
      const existingId = await findExistingWorkOrder(parsed);
      if (existingId) {
        const { error } = await sb
          .from("work_orders")
          .update(compactPatch(parsed) as any)
          .eq("id", existingId);

        if (error) throw error;
        result = {
          ...result,
          action: "updated",
          workOrderId: existingId,
          reason: "existing work order updated from email intake",
        };
      } else {
        const contractor = await resolveContractor(parsed);
        const workOrderId = parsed.wotId || parsed.fwkdId || generateWOId();
        const row = {
          id: workOrderId,
          store_number: parsed.storeNumber,
          summary: parsed.summary,
          description: parsed.description,
          priority: parsed.priority || "p2",
          status: contractor.contractorId ? "assigned" : "unassigned",
          functional_status: "New",
          contractor_id: contractor.contractorId,
          afm_name: parsed.afmName,
          afm_email: parsed.afmEmail,
          city: parsed.city,
          address: parsed.address,
          nte: parsed.nte || 0,
          line_of_service: parsed.lineOfService,
          business_service: parsed.businessService,
          category: parsed.category,
          sub_category: parsed.subCategory,
          incident_id: parsed.incidentId,
          source: "email_intake",
          dispatched_at: email.receivedDateTime || processedAt,
          sla_started_at: email.receivedDateTime || processedAt,
          created_at: processedAt,
        };

        const { error } = await (sb as any).from("work_orders").insert(row);
        if (error) throw error;

        if (contractor.contractorId) {
          await sendDispatchNotification({
            workOrder: {
              id: workOrderId,
              incidentId: parsed.incidentId,
              storeNumber: parsed.storeNumber,
              city: parsed.city,
              address: parsed.address,
              priority: parsed.priority || "p2",
              summary: parsed.summary,
              description: parsed.description,
            },
            contractorEmail: contractor.contractorEmail,
            contractorName: contractor.contractorName,
          }).catch(err => console.error("Dispatch notification failed", err));
        }

        result = {
          ...result,
          action: "created",
          workOrderId,
          reason: contractor.reason,
          contractorAssigned: contractor.contractorId,
        };
      }
    }

    await finishEmail(email, folderId);
  } catch (err) {
    console.error("Email intake processing failed", err);
    result = {
      ...result,
      action: "failed",
      reason: err instanceof Error ? err.message : "unknown processing error",
    };
  }

  await insertLog(email, result);
  return result;
}

export async function runIntakeCycle(): Promise<IntakeResult[]> {
  const accessToken = await getAccessToken();
  if (!accessToken) return [];

  const folderId = await getOrCreateFolder(accessToken);
  if (!folderId) return [];

  const emails = await getUnreadDispatchEmails(accessToken);
  const results: IntakeResult[] = [];
  for (const email of emails) {
    results.push(await processEmail(email, folderId));
  }
  return results;
}
