type WorkOrderIdentityInput = {
  id?: string | null;
  duplicateRootWorkOrderId?: string | null;
  duplicate_root_work_order_id?: string | null;
};

const DUPLICATE_WOT_REFERENCE = /^(WOT\d{6,12})-\d+$/i;

/**
 * Returns the real 7-Eleven work-order number for external communication.
 * Reassignment copies keep a suffixed portal primary key, while their
 * explicit root remains the canonical WOT recognized by 7-Eleven.
 */
export const canonicalSevenElevenWorkOrderId = (
  value: string | WorkOrderIdentityInput | null | undefined,
): string => {
  if (value && typeof value === "object") {
    const explicitRoot = String(
      value.duplicateRootWorkOrderId
        || value.duplicate_root_work_order_id
        || "",
    ).trim();
    if (explicitRoot) return explicitRoot;
    return canonicalSevenElevenWorkOrderId(value.id);
  }

  const reference = String(value || "").trim();
  const duplicateMatch = reference.match(DUPLICATE_WOT_REFERENCE);
  return duplicateMatch?.[1] || reference;
};

export const isReassignmentPortalReference = (
  value: WorkOrderIdentityInput | null | undefined,
): boolean => {
  if (!value?.id) return false;
  return canonicalSevenElevenWorkOrderId(value) !== String(value.id).trim();
};
