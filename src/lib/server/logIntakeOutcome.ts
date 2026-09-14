import { safeLog } from "../observability/safeLogger";
import { currentRequestOperation } from "./requestOperation";

type IntakeOutcomeEvent =
  | "intake_history_unconfirmed" | "intake_mailbox_unconfirmed" | "intake_processing_failed"
  | "intake_priority_drain_failed" | "intake_removal_drain_failed"
  | "intake_priority_delivery_failed" | "intake_removal_delivery_failed"
  | "intake_routing_lookup_failed" | "intake_routing_failed" | "dispatch_token_unavailable";

/** Only handled, non-throwing outcomes are logged here. Propagated failures
 * belong to the route boundary, avoiding a second copy of the same failure. */
export function logIntakeOutcome(event: IntakeOutcomeEvent, eventId?: string) {
  const context = currentRequestOperation();
  if (context) safeLog(event, context, { code: "RESULT_UNCONFIRMED", eventId });
}
