import type { VaCoordinatorAttachment, VaCoordinatorNote, VaCoordinatorWorkOrder, VaCoordinatorWorkOrderDetail } from "./contracts";

/**
 * Map the VA's narrow DTO into the shared portal work-order view contract.
 * Deliberately omit billing, price, contractor, internal-note, and assignment
 * metadata; this is a read-model adapter, not an authorization boundary.
 */
export function mapVaCoordinatorWorkOrderToPortalModel(workOrder: VaCoordinatorWorkOrder | VaCoordinatorWorkOrderDetail) {
  return {
    id: workOrder.id,
    externalWorkOrderId: workOrder.id,
    incidentId: null,
    store: workOrder.storeNumber,
    city: workOrder.city,
    addr: "address" in workOrder ? workOrder.address : null,
    storeState: workOrder.state,
    storeTimezone: null,
    storeCounty: null,
    storePostalCode: null,
    lineOfService: null,
    businessService: null,
    category: null,
    subCategory: null,
    summary: workOrder.summary,
    description: "description" in workOrder ? workOrder.description : null,
    priority: workOrder.priority,
    status: workOrder.status,
    functionalStatus: workOrder.functionalStatus,
    assetMake: workOrder.assetMake,
    assetModel: workOrder.assetModel,
    assetSerial: workOrder.assetSerial,
    assetYear: "assetYear" in workOrder ? workOrder.assetYear : null,
    technicianOnJob: workOrder.technicianName,
    contractor: null,
    createdAt: null,
    updatedAt: workOrder.updatedAt,
    closedAt: null,
    responseBreachAt: null,
    resolutionBreachAt: null,
    startTime: null,
    startTimeRaw: null,
    endTime: null,
    endTimeRaw: null,
    activities: [],
    photos: [],
    visits: [],
    assignmentHistory: [],
    detailsLoaded: false,
  };
}

/** Adapt only authorized technician notes and finalized attachment paths. */
export function mapVaCoordinatorDetailsToPortalModel(
  notes: readonly VaCoordinatorNote[],
  attachments: readonly VaCoordinatorAttachment[],
) {
  const activities = notes.map(note => ({
    id: note.id,
    authorId: null,
    author: note.authorName,
    createdAt: note.createdAt,
    time: note.createdAt ? new Date(note.createdAt).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }) : "",
    text: note.text,
    type: "note",
    activityChannel: "field_note" as const,
    enteredByRole: note.enteredByRole,
    isStaffOverride: false,
    isStaffOnly: false,
    overrideForContractorId: null,
    eventKey: "note",
    eventData: {},
    requiresSevenElevenSync: note.requiresSevenElevenSync,
    syncedToSevenElevenAt: note.syncedToSevenElevenAt,
    syncedToSevenElevenBy: note.syncedById,
    syncedToSevenElevenByName: note.syncedByName,
    requiresContractorAttention: false,
    contractorAcknowledgedAt: null,
    contractorAcknowledgedBy: null,
    workflowCycle: 0,
  }));
  const photos = attachments.map(attachment => attachment.storagePath);
  return {
    activities,
    photos,
    visits: [],
    latestNoteAt: notes[0]?.createdAt || null,
    latestContractorActivityAt: null,
    hasUnreadNotes: false,
    pendingSevenElevenActivities: activities.filter(activity => activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt),
    pendingSevenElevenSyncCount: activities.filter(activity => activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt).length,
    hasPendingSevenElevenSync: activities.some(activity => activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt),
    pendingContractorActivities: [],
    pendingContractorAttentionCount: 0,
    hasPendingContractorAttention: false,
    activityPage: { nextCursor: null, hasMore: false, totalCount: notes.length },
    photoPage: { nextCursor: null, hasMore: false, totalCount: attachments.length },
    visitPage: { nextCursor: null, hasMore: false, totalCount: 0 },
    assignmentHistory: [],
    detailsLoaded: true,
  };
}
