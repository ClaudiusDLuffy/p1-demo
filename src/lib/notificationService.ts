import { getAccessToken, sendEmail } from "./graphClient";

type DispatchNotificationInput = {
  workOrder: {
    id: string;
    incidentId?: string | null;
    store?: string | null;
    storeNumber?: string | null;
    city?: string | null;
    state?: string | null;
    addr?: string | null;
    address?: string | null;
    priority?: string | null;
    summary?: string | null;
    description?: string | null;
  };
  contractorAssigned?: boolean;
  contractorEmail?: string | null;
  contractorName?: string | null;
};

const SERVICE_INBOX = "service@p1pros.com";

const PRIORITY_LABELS: Record<string, string> = {
  p1: "P1 Critical",
  p2: "P2 Emergency",
  p3: "P3 Rush",
  p4: "P4 Routine",
  p5: "P5 Preventative",
};

const ownerEmails = () =>
  (process.env.NOTIFY_OWNER_EMAILS || "")
    .split(",")
    .map(email => email.trim())
    .filter(Boolean);

const isProOpsAssignment = (
  contractorEmail?: string | null,
  contractorName?: string | null,
) =>
  /pro[\s-]*ops/i.test(String(contractorName || ""))
  || ["pro.ops.inc@gmail.com", "service@pro-opsinc.com"].includes(
    String(contractorEmail || "").trim().toLowerCase(),
  );

const portalUrl = () =>
  process.env.PORTAL_URL || "https://www.p1prosportal.com";

const priorityLabel = (priority?: string | null) =>
  priority ? (PRIORITY_LABELS[priority.toLowerCase()] || priority.toUpperCase()) : "Not set";

const storeLabel = (workOrder: DispatchNotificationInput["workOrder"]) =>
  workOrder.storeNumber || workOrder.store || "Not captured";

const addressLabel = (workOrder: DispatchNotificationInput["workOrder"]) =>
  [workOrder.address || workOrder.addr, workOrder.city].filter(Boolean).join(", ") || "Not captured";

const issueLabel = (workOrder: DispatchNotificationInput["workOrder"]) =>
  workOrder.summary || workOrder.description || "No issue summary provided";

const buildContractorBody = (
  workOrder: DispatchNotificationInput["workOrder"],
) => `You have been assigned a new work order.

Work Order: ${workOrder.id}
Incident: ${workOrder.incidentId || "Not captured"}
Store: #${storeLabel(workOrder)}
Address: ${addressLabel(workOrder)}
Priority: ${priorityLabel(workOrder.priority)}
Issue: ${issueLabel(workOrder)}

Log in to view details:
${portalUrl()}`;

const buildOwnerBody = (
  workOrder: DispatchNotificationInput["workOrder"],
  contractorAssigned: boolean,
  contractorName?: string | null,
) => `${contractorAssigned
  ? `A new work order has been dispatched${contractorName ? ` to ${contractorName}` : ""}.`
  : "A new work order is waiting for contractor assignment."}

Work Order: ${workOrder.id}
Incident: ${workOrder.incidentId || "Not captured"}
Store: #${storeLabel(workOrder)}
Address: ${addressLabel(workOrder)}
Priority: ${priorityLabel(workOrder.priority)}
Contractor: ${contractorName || "Unassigned"}
Issue: ${issueLabel(workOrder)}

Log in to view details:
${portalUrl()}`;

export const createDispatchNotificationPlan = (
  input: DispatchNotificationInput,
  configuredOwnerEmails: string[] = ownerEmails(),
) => {
  const { workOrder, contractorEmail, contractorName } = input;
  const contractorAssigned = input.contractorAssigned
    ?? Boolean(contractorEmail || contractorName);
  const contractorRecipients = contractorAssigned
    ? [...new Set([
        ...(contractorEmail ? [contractorEmail] : []),
        ...(isProOpsAssignment(contractorEmail, contractorName)
          ? ["service@pro-opsinc.com"]
          : []),
      ])]
    : [];
  const internalRecipients = [...new Set([
    ...configuredOwnerEmails,
    ...(!contractorAssigned ? [SERVICE_INBOX] : []),
  ])];
  const stateLabel = String(workOrder.state || "").trim().toUpperCase();

  return {
    contractorAssigned,
    contractorRecipients,
    internalRecipients,
    ownerSubject: contractorAssigned
      ? `New ${stateLabel ? `${stateLabel} ` : ""}Call Dispatched - ${workOrder.id}`
      : `New ${stateLabel ? `${stateLabel} ` : ""}Call Needs Assignment - ${workOrder.id}`,
    ownerBody: buildOwnerBody(workOrder, contractorAssigned, contractorName),
  };
};

export async function sendDispatchNotification(input: DispatchNotificationInput) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.error("Dispatch notification skipped: missing Graph access token");
    return;
  }

  const { workOrder } = input;
  const plan = createDispatchNotificationPlan(input);

  if (plan.contractorRecipients.length) {
    await sendEmail(
      accessToken,
      plan.contractorRecipients,
      `New Work Order Assigned - ${workOrder.id}`,
      buildContractorBody(workOrder),
    );
  }

  if (plan.internalRecipients.length) {
    await sendEmail(
      accessToken,
      plan.internalRecipients,
      plan.ownerSubject,
      plan.ownerBody,
    );
  }
}

export async function sendContractorPortalPing(contractorEmail: string) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error("Missing Graph access token");
  }

  await sendEmail(
    accessToken,
    [contractorEmail],
    "Notification waiting in the P1 Pros Portal",
    `You have a notification waiting in the P1 Pros Portal.

Log in to review it:
${portalUrl()}`,
  );
}
