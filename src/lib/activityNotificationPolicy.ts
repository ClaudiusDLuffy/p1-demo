const STAFF_ROLES = new Set(["manager", "dispatcher", "back_office"]);

export type ContractorNotificationDelivery =
  | "sent"
  | "already_sent"
  | "pending_or_unknown"
  | "delivery_unknown";

export function shouldAutomaticallyNotifyContractor(
  role: string | null | undefined,
  channel: string | null | undefined,
): boolean {
  return STAFF_ROLES.has(String(role || ""))
    && channel === "contractor_message";
}

export function contractorNotificationToast(
  delivery: ContractorNotificationDelivery,
): string {
  if (delivery === "sent") {
    return "Message posted and contractor notified";
  }
  if (delivery === "already_sent") {
    return "Message posted; contractor was already notified";
  }
  if (delivery === "pending_or_unknown") {
    return "Message posted and contractor alert saved; email delivery is still processing or could not yet be confirmed";
  }
  return "Message posted and contractor alert saved; email delivery could not be confirmed";
}

export function contractorAttentionRequestToast(
  delivery: ContractorNotificationDelivery,
): string {
  if (delivery === "sent") {
    return "Contractor attention requested and portal email sent";
  }
  if (delivery === "already_sent") {
    return "Contractor attention requested; portal email was already sent";
  }
  if (delivery === "pending_or_unknown") {
    return "Contractor attention requested; email delivery is still processing or could not yet be confirmed";
  }
  return "Contractor attention requested; email delivery could not be confirmed";
}
