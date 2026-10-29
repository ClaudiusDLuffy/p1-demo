import { VA_COORDINATOR_UPDATE_MAX_LENGTH } from "./contracts";

export class VaCoordinatorUpdateValidationError extends Error {}

export function prepareVaCoordinatorSevenElevenUpdate(workOrderId: string, value: string) {
  if (!workOrderId.trim() || workOrderId.length > 128) {
    throw new VaCoordinatorUpdateValidationError("Reopen the work order before posting an update.");
  }
  const text = value.trim();
  if (!text) throw new VaCoordinatorUpdateValidationError("Enter an update before posting.");
  if (text.length > VA_COORDINATOR_UPDATE_MAX_LENGTH) {
    throw new VaCoordinatorUpdateValidationError(
      `Updates must be ${VA_COORDINATOR_UPDATE_MAX_LENGTH.toLocaleString()} characters or fewer.`,
    );
  }
  return { p_work_order_id: workOrderId, p_text: text } as const;
}
