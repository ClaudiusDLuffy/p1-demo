import { getAccessToken, sendEmail } from "./graphClient";
import { canonicalSevenElevenWorkOrderId } from "./workOrderIdentity";

type DispatchNotificationInput = {
  workOrder: {
    id: string;
    externalWorkOrderId?: string | null;
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

type WorkOrderAssignmentRemovalNotificationInput = {
  recipientEmail: string;
  transitionType: "reassigned" | "unassigned" | "duplicated_for_reassignment";
  workOrder: {
    id: string;
    externalWorkOrderId?: string | null;
  };
};

type InvoiceReviewNotificationInput = {
  event: "rejected" | "retraction";
  recipients: string[];
  invoice: {
    num: string;
    workOrderId: string;
    externalWorkOrderId?: string | null;
    storeNumber?: string | null;
    rejectionReason?: string | null;
  };
};

type InvoicePaymentHoldNotificationInput = {
  event: "placed" | "released";
  recipients: string[];
  invoice: {
    num: string;
    workOrderId?: string | null;
    externalWorkOrderId?: string | null;
    contractorName?: string | null;
    total?: number | null;
  };
  actorName: string;
  reason: string;
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

const dispatchWorkOrderReference = (
  workOrder: DispatchNotificationInput["workOrder"],
) => {
  const externalId = canonicalSevenElevenWorkOrderId({
    id: workOrder.id,
    duplicateRootWorkOrderId: workOrder.externalWorkOrderId,
  });
  return {
    externalId,
    portalReferenceLine: externalId !== workOrder.id
      ? `\nPortal reassignment reference: ${workOrder.id}`
      : "",
  };
};

const invoiceWorkOrderReference = (
  invoice: {
    workOrderId?: string | null;
    externalWorkOrderId?: string | null;
  },
) => {
  const portalReference = String(invoice.workOrderId || "").trim();
  const externalId = canonicalSevenElevenWorkOrderId({
    id: portalReference,
    duplicateRootWorkOrderId: invoice.externalWorkOrderId,
  });
  return {
    externalId: externalId || "Not captured",
    portalReferenceLine: externalId && portalReference && externalId !== portalReference
      ? `\nP1 portal reassignment reference: ${portalReference}`
      : "",
  };
};

const buildContractorBody = (
  workOrder: DispatchNotificationInput["workOrder"],
) => `You have been assigned a new work order.

Work Order: ${dispatchWorkOrderReference(workOrder).externalId}${dispatchWorkOrderReference(workOrder).portalReferenceLine}
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

Work Order: ${dispatchWorkOrderReference(workOrder).externalId}${dispatchWorkOrderReference(workOrder).portalReferenceLine}
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
  const workOrderReference = dispatchWorkOrderReference(workOrder);

  return {
    contractorAssigned,
    contractorRecipients,
    internalRecipients,
    ownerSubject: contractorAssigned
      ? `New ${stateLabel ? `${stateLabel} ` : ""}Call Dispatched - ${workOrderReference.externalId}`
      : `New ${stateLabel ? `${stateLabel} ` : ""}Call Needs Assignment - ${workOrderReference.externalId}`,
    contractorSubject: `New Work Order Assigned - ${workOrderReference.externalId}`,
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
      plan.contractorSubject,
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

export function createWorkOrderAssignmentRemovalNotificationPlan(
  input: WorkOrderAssignmentRemovalNotificationInput,
) {
  const recipient = input.recipientEmail.trim().toLowerCase();
  const externalWorkOrderId = canonicalSevenElevenWorkOrderId({
    id: input.workOrder.id,
    duplicateRootWorkOrderId: input.workOrder.externalWorkOrderId,
  });
  const preservesBillingRecord = input.transitionType === "duplicated_for_reassignment";
  const introduction = preservesBillingRecord
    ? "P1 created a separate reassignment copy for ongoing field service. Your team should stop field work on this call."
    : "This work order has been removed from your team's active field assignment and may no longer appear under My Jobs in the portal.";
  const portalGuidance = preservesBillingRecord
    ? "Your original portal record remains available only for documenting work already performed and submitting any approved incurred costs."
    : "No action is required in the portal for this removal.";

  return {
    recipients: recipient ? [recipient] : [],
    subject: preservesBillingRecord
      ? `Field Assignment Updated - ${externalWorkOrderId}`
      : `Work Order Removed From Your Assignment - ${externalWorkOrderId}`,
    body: `${introduction}

Work Order: ${externalWorkOrderId}

Please do not dispatch or continue work unless P1 Service assigns this work order to you again.

${portalGuidance}

If work has already started or approved costs were incurred, contact P1 Service at ${SERVICE_INBOX} for billing instructions.`,
  };
}

export async function sendWorkOrderAssignmentRemovalNotification(
  input: WorkOrderAssignmentRemovalNotificationInput,
) {
  const plan = createWorkOrderAssignmentRemovalNotificationPlan(input);
  if (plan.recipients.length === 0) {
    throw new Error("Outgoing contractor email not found");
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error("Missing Graph access token");
  }
  await sendEmail(
    accessToken,
    plan.recipients,
    plan.subject,
    plan.body,
  );
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

export function createInvoiceReviewNotificationPlan(
  input: InvoiceReviewNotificationInput,
) {
  const recipients = [...new Set(
    (input.recipients || [])
      .map(email => email.trim().toLowerCase())
      .filter(Boolean),
  )];
  const { invoice } = input;
  const workOrderReference = invoiceWorkOrderReference(invoice);

  if (input.event === "rejected") {
    return {
      recipients,
      subject: `Invoice #${invoice.num} rejected — action required`,
      body: `Your contractor invoice needs corrections before it can be approved.

Invoice: #${invoice.num}
Work Order: ${workOrderReference.externalId}${workOrderReference.portalReferenceLine}
Store: #${invoice.storeNumber || "Not captured"}
Reason: ${invoice.rejectionReason || "No reason provided"}

Log in to edit and resubmit the rejected invoice:
${portalUrl()}`,
    };
  }

  return {
    recipients,
    subject: `Invoice #${invoice.num} rejection withdrawn — invoice approved`,
    body: `The prior rejection of your contractor invoice was withdrawn by P1 staff. The invoice is now approved; no correction or resubmission is needed.

Invoice: #${invoice.num}
Work Order: ${workOrderReference.externalId}${workOrderReference.portalReferenceLine}
Store: #${invoice.storeNumber || "Not captured"}

Log in to review the updated status:
${portalUrl()}`,
  };
}

export async function sendInvoiceReviewNotification(
  input: InvoiceReviewNotificationInput,
) {
  const plan = createInvoiceReviewNotificationPlan(input);
  if (plan.recipients.length === 0) {
    throw new Error("No contractor invoice recipients were found");
  }

  const accessToken = await getAccessToken();
  await sendEmail(
    accessToken,
    plan.recipients,
    plan.subject,
    plan.body,
  );
}

export function createInvoicePaymentHoldNotificationPlan(
  input: InvoicePaymentHoldNotificationInput,
) {
  const recipients = [...new Set(
    (input.recipients || [])
      .map(email => email.trim().toLowerCase())
      .filter(Boolean),
  )];
  const { invoice } = input;
  const amount = Number.isFinite(Number(invoice.total))
    ? `$${Number(invoice.total || 0).toFixed(2)}`
    : "Not captured";
  const placed = input.event === "placed";
  const workOrderReference = invoiceWorkOrderReference(invoice);

  return {
    recipients,
    subject: placed
      ? `Payment hold placed — invoice #${invoice.num}`
      : `Payment hold released — invoice #${invoice.num}`,
    body: `${placed ? "A contractor invoice was placed on payment hold." : "A contractor invoice payment hold was released."}

Invoice: #${invoice.num}
Work Order: ${workOrderReference.externalId}${workOrderReference.portalReferenceLine}
Contractor: ${invoice.contractorName || "Not captured"}
Amount: ${amount}
${placed ? "Placed" : "Released"} by: ${input.actorName}
Reason: ${input.reason}

${placed
  ? "This invoice is excluded from the QuickBooks handoff queue until an authorized controller releases it."
  : "This invoice is eligible for the QuickBooks handoff queue again."}

Review it in the P1 Pros Portal:
${portalUrl()}`,
  };
}

export async function sendInvoicePaymentHoldNotification(
  input: InvoicePaymentHoldNotificationInput,
) {
  const plan = createInvoicePaymentHoldNotificationPlan(input);
  if (plan.recipients.length === 0) {
    throw new Error("No QuickBooks handoff recipients were found");
  }

  const accessToken = await getAccessToken();
  await sendEmail(
    accessToken,
    plan.recipients,
    plan.subject,
    plan.body,
  );
}
