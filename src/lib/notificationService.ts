import { getAccessToken, sendEmail } from "./graphClient";

type DispatchNotificationInput = {
  workOrder: {
    id: string;
    incidentId?: string | null;
    store?: string | null;
    storeNumber?: string | null;
    city?: string | null;
    addr?: string | null;
    address?: string | null;
    priority?: string | null;
    summary?: string | null;
    description?: string | null;
  };
  contractorEmail?: string | null;
  contractorName?: string | null;
};

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
  contractorName?: string | null,
) => `A new work order has been dispatched${contractorName ? ` to ${contractorName}` : ""}.

Work Order: ${workOrder.id}
Incident: ${workOrder.incidentId || "Not captured"}
Store: #${storeLabel(workOrder)}
Address: ${addressLabel(workOrder)}
Priority: ${priorityLabel(workOrder.priority)}
Contractor: ${contractorName || "Unassigned"}
Issue: ${issueLabel(workOrder)}

Log in to view details:
${portalUrl()}`;

export async function sendDispatchNotification(input: DispatchNotificationInput) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    console.error("Dispatch notification skipped: missing Graph access token");
    return;
  }

  const { workOrder, contractorEmail, contractorName } = input;
  const contractorRecipients = contractorEmail ? [contractorEmail] : [];
  const internalRecipients = ownerEmails();

  if (contractorRecipients.length) {
    await sendEmail(
      accessToken,
      contractorRecipients,
      `New Work Order Assigned - ${workOrder.id}`,
      buildContractorBody(workOrder),
    );
  }

  if (internalRecipients.length) {
    await sendEmail(
      accessToken,
      internalRecipients,
      `New VA Call Dispatched - ${workOrder.id}`,
      buildOwnerBody(workOrder, contractorName),
    );
  }
}
