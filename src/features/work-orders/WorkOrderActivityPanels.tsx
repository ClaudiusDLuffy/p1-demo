import { useState } from "react";
import type { ReactNode } from "react";
import { BtnSpinner, BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { T } from "../../lib/constants";

export type WorkOrderActivityChannel =
  | "field_note"
  | "internal_note"
  | "contractor_message"
  | "system_event"
  | "legacy";

export type WorkOrderActivity = {
  id?: string | null;
  activityChannel?: WorkOrderActivityChannel | null;
  requiresSevenElevenSync?: boolean;
  syncedToSevenElevenAt?: string | null;
  isStaffOnly?: boolean;
  type?: string | null;
  authorId?: string | null;
  author?: string | null;
  time?: string | null;
  text?: string | null;
  enteredByRole?: string | null;
  isStaffOverride?: boolean;
  requiresContractorAttention?: boolean;
  contractorAcknowledgedAt?: string | null;
};

type ActivityViewer = {
  id?: string | null;
} | null | undefined;

export const channelForWorkOrderActivity = (activity: WorkOrderActivity): WorkOrderActivityChannel =>
  activity?.activityChannel
  || (activity?.requiresSevenElevenSync
    ? "field_note"
    : activity?.isStaffOnly
      ? "internal_note"
      : activity?.type === "system"
        ? "system_event"
        : "legacy");

export const splitWorkOrderActivities = (activities: WorkOrderActivity[]) => ({
  sevenEleven: activities.filter(
    activity => channelForWorkOrderActivity(activity) === "field_note",
  ),
  general: activities.filter(
    activity => channelForWorkOrderActivity(activity) !== "field_note",
  ),
});

const ACTIVITY_CHANNEL_LABELS: Record<WorkOrderActivityChannel, string> = {
  field_note: "7-Eleven update",
  internal_note: "P1 internal",
  contractor_message: "P1 / contractor chat",
  system_event: "System activity",
  legacy: "Legacy activity",
};

type ActivityEntryListProps = {
  activities: WorkOrderActivity[];
  emptyMessage: string;
  workOrderId: string;
  isManager: boolean;
  currentUser: ActivityViewer;
  activityMenuId: string | null;
  setActivityMenuId: (id: string | null) => void;
  setPendingDelete: (value: { woId: string; activityId: string }) => void;
  setModal: (modal: string) => void;
  isLoading: (key: string) => boolean;
  doMarkSevenElevenSynced: (workOrderId: string, activityId: string, synced: boolean) => void;
  doMarkContractorAttention: (workOrderId: string, activityId: string, required: boolean) => void;
  doAcknowledgeContractorAttention: (workOrderId: string, activityId: string, acknowledged: boolean) => void;
};

function ActivityEntryList({
  activities,
  emptyMessage,
  workOrderId,
  isManager,
  currentUser,
  activityMenuId,
  setActivityMenuId,
  setPendingDelete,
  setModal,
  isLoading,
  doMarkSevenElevenSynced,
  doMarkContractorAttention,
  doAcknowledgeContractorAttention,
}: ActivityEntryListProps) {
  if (activities.length === 0) {
    return (
      <div style={{ padding: "18px 10px", textAlign: "center", color: T.subtle, fontSize: 12 }}>
        {emptyMessage}
      </div>
    );
  }

  return activities.map((activity, index) => {
    const activityChannel = channelForWorkOrderActivity(activity);
    const canDelete = !!activity.id
      && activityChannel !== "system_event"
      && activity.type !== "system"
      && !!activity.authorId
      && (isManager || activity.authorId === currentUser?.id);
    const menuOpen = activityMenuId === activity.id;
    const staffEntered = ["manager", "dispatcher", "back_office"].includes(activity.enteredByRole);
    const originLabel = activity.isStaffOverride
      ? "Staff override"
      : staffEntered
        ? "Staff-entered"
        : activity.enteredByRole === "contractor"
          ? "Contractor-entered"
          : null;
    const channelColor = activityChannel === "field_note"
      ? T.accent
      : activityChannel === "internal_note"
        ? T.violet
        : activityChannel === "contractor_message"
          ? "#166534"
          : T.subtle;
    const channelBackground = activityChannel === "field_note"
      ? T.accentSoft
      : activityChannel === "internal_note"
        ? T.violetSoft
        : activityChannel === "contractor_message"
          ? "#DCFCE7"
          : T.surfaceSoft;
    const channelBorder = activityChannel === "field_note"
      ? `${T.accent}44`
      : activityChannel === "internal_note"
        ? `${T.violet}44`
        : activityChannel === "contractor_message"
          ? "#22C55E55"
          : T.borderSoft;

    return (
      <div
        key={activity.id || index}
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 16,
          animation: index === 0 ? "fadeUp 0.3s" : "none",
          position: "relative",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: activity.type === "system" ? T.border : activityChannel === "field_note" ? T.accent : "#4A7C59",
            marginTop: 6,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px" }}>
            <span style={{ fontWeight: 600, color: T.ink }}>{activity.author}</span>
            <span style={{ color: T.subtle, fontSize: 11 }}>{activity.time}</span>
            {originLabel && (
              <span style={{ display: "inline-block", padding: "2px 6px", borderRadius: 6, fontSize: 9, fontWeight: 700, color: activity.isStaffOverride ? "#73560C" : T.muted, background: activity.isStaffOverride ? T.warnSoft : T.surfaceSoft, border: `1px solid ${activity.isStaffOverride ? `${T.warn}55` : T.borderSoft}` }}>
                {originLabel}
              </span>
            )}
            <span style={{ display: "inline-block", padding: "2px 6px", borderRadius: 6, fontSize: 9, fontWeight: 700, color: channelColor, background: channelBackground, border: `1px solid ${channelBorder}` }}>
              {ACTIVITY_CHANNEL_LABELS[activityChannel]}
            </span>
          </div>
          <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.55, marginTop: 3, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
            {activity.text}
          </div>
          {isManager && activity.id && activityChannel === "field_note" && activity.requiresSevenElevenSync && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 8, padding: "5px 8px", borderRadius: 8, background: activity.syncedToSevenElevenAt ? T.successSoft : T.warnSoft, border: `1px solid ${activity.syncedToSevenElevenAt ? `${T.success}44` : `${T.warn}55`}`, color: activity.syncedToSevenElevenAt ? T.success : "#73560C", fontSize: 10, fontWeight: 700, cursor: isLoading("sync711_" + activity.id) ? "wait" : "pointer" }}>
              <input
                type="checkbox"
                checked={!!activity.syncedToSevenElevenAt}
                disabled={isLoading("sync711_" + activity.id)}
                onChange={event => doMarkSevenElevenSynced(workOrderId, activity.id, event.target.checked)}
                style={{ width: 14, height: 14, accentColor: T.success, cursor: "inherit" }}
              />
              {activity.syncedToSevenElevenAt ? "Updated in 7-Eleven" : "Needs 7-Eleven update"}
            </label>
          )}
          {isManager
            && activity.id
            && ["field_note", "contractor_message", "legacy"].includes(activityChannel)
            && (staffEntered || activity.isStaffOverride || activity.requiresContractorAttention) && (
              <label style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 8, marginLeft: activity.requiresSevenElevenSync ? 7 : 0, padding: "5px 8px", borderRadius: 8, background: activity.requiresContractorAttention && !activity.contractorAcknowledgedAt ? "#DCFCE7" : T.surfaceSoft, border: `1px solid ${activity.requiresContractorAttention && !activity.contractorAcknowledgedAt ? "#22C55E66" : T.borderSoft}`, color: activity.requiresContractorAttention && !activity.contractorAcknowledgedAt ? "#166534" : T.muted, fontSize: 10, fontWeight: 700, cursor: isLoading("contractorAttention_" + activity.id) ? "wait" : "pointer" }}>
                <input
                  type="checkbox"
                  checked={!!activity.requiresContractorAttention}
                  disabled={isLoading("contractorAttention_" + activity.id)}
                  onChange={event => doMarkContractorAttention(workOrderId, activity.id, event.target.checked)}
                  style={{ width: 14, height: 14, accentColor: "#16A34A", cursor: "inherit" }}
                />
                {activity.contractorAcknowledgedAt
                  ? "Contractor acknowledged"
                  : activity.requiresContractorAttention
                    ? "Needs contractor action"
                    : "Request contractor action"}
              </label>
            )}
          {!isManager && activity.requiresContractorAttention && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 8, padding: "6px 9px", borderRadius: 8, background: activity.contractorAcknowledgedAt ? T.surfaceSoft : "#DCFCE7", border: `1px solid ${activity.contractorAcknowledgedAt ? T.borderSoft : "#22C55E66"}`, color: activity.contractorAcknowledgedAt ? T.muted : "#166534", fontSize: 10, fontWeight: 700, cursor: isLoading("contractorAck_" + activity.id) ? "wait" : "pointer" }}>
              <input
                type="checkbox"
                checked={!!activity.contractorAcknowledgedAt}
                disabled={!!activity.contractorAcknowledgedAt || isLoading("contractorAck_" + activity.id)}
                onChange={event => doAcknowledgeContractorAttention(workOrderId, activity.id, event.target.checked)}
                style={{ width: 14, height: 14, accentColor: "#16A34A", cursor: "inherit" }}
              />
              {activity.contractorAcknowledgedAt ? "Reviewed" : "Needs your attention"}
            </label>
          )}
        </div>
        {canDelete && (
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setActivityMenuId(menuOpen ? null : activity.id)}
              aria-label="Activity actions"
              style={{ width: 36, height: 36, padding: 0, borderRadius: 6, border: "none", background: menuOpen ? T.bgWarm : "transparent", color: T.subtle, cursor: "pointer", fontSize: 16, lineHeight: 1, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center" }}
            >…</button>
            {menuOpen && (
              <>
                <div onClick={() => setActivityMenuId(null)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div style={{ position: "absolute", top: 34, right: 0, zIndex: 41, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(31,30,28,0.12)", minWidth: 120, overflow: "hidden" }}>
                  <button
                    type="button"
                    onClick={() => {
                      setActivityMenuId(null);
                      setPendingDelete({ woId: workOrderId, activityId: activity.id });
                      setModal("deleteActivity");
                    }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "none", border: "none", cursor: "pointer", fontSize: 12, color: T.danger, fontFamily: "inherit" }}
                  >Delete</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  });
}

type WorkOrderActivityPanelsProps = Omit<ActivityEntryListProps, "activities" | "emptyMessage"> & {
  activities: WorkOrderActivity[];
  totalCount?: number | null;
  pendingSevenElevenCount?: number | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  fieldNoteText: string;
  setFieldNoteText: (text: string) => void;
  doPostNote: (
    workOrderId: string,
    channel: "field_note" | "internal_note" | "contractor_message",
    text?: string,
  ) => Promise<boolean | void> | boolean | void;
  onCopyWorkOrder: () => void;
  aiNote: ReactNode;
  setAiNote: (note: ReactNode | null) => void;
  aiEnhancing: boolean;
  doAiEnhance: () => void;
};

export default function WorkOrderActivityPanels({
  activities,
  totalCount,
  pendingSevenElevenCount,
  hasMore,
  loadingMore,
  onLoadMore,
  fieldNoteText,
  setFieldNoteText,
  doPostNote,
  onCopyWorkOrder,
  aiNote,
  setAiNote,
  aiEnhancing,
  doAiEnhance,
  workOrderId,
  isManager,
  currentUser,
  activityMenuId,
  setActivityMenuId,
  setPendingDelete,
  setModal,
  isLoading,
  doMarkSevenElevenSynced,
  doMarkContractorAttention,
  doAcknowledgeContractorAttention,
}: WorkOrderActivityPanelsProps) {
  const [generalText, setGeneralText] = useState("");
  const [generalChannel, setGeneralChannel] = useState<"internal_note" | "contractor_message">(
    isManager ? "internal_note" : "contractor_message",
  );
  const { sevenEleven, general } = splitWorkOrderActivities(activities);
  const loadedPendingSevenEleven = sevenEleven.filter(
    activity => activity.requiresSevenElevenSync && !activity.syncedToSevenElevenAt,
  ).length;
  const pendingSevenEleven = typeof pendingSevenElevenCount === "number"
    ? Math.max(pendingSevenElevenCount, loadedPendingSevenEleven)
    : loadedPendingSevenEleven;
  const posting = isLoading("postNote_" + workOrderId);

  const postDraft = async (
    channel: "field_note" | "internal_note" | "contractor_message",
    value: string,
    clear: (next: string) => void,
  ) => {
    const text = value.trim();
    if (!text || posting) return;
    clear("");
    const saved = await doPostNote(workOrderId, channel, text);
    if (saved === false) clear(value);
  };

  const entryListProps = {
    workOrderId,
    isManager,
    currentUser,
    activityMenuId,
    setActivityMenuId,
    setPendingDelete,
    setModal,
    isLoading,
    doMarkSevenElevenSynced,
    doMarkContractorAttention,
    doAcknowledgeContractorAttention,
  };

  return (
    <section aria-label="Work order updates and conversation" style={{ display: "grid", gap: 16 }}>
      <div className="card" style={{ overflow: "hidden", borderColor: `${T.accent}55` }}>
        <div style={{ padding: "18px 20px", background: T.accentSoft, borderBottom: `1px solid ${T.accent}33` }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 750, color: T.ink }}>7-Eleven updates / job notes</div>
              <div style={{ marginTop: 4, maxWidth: 650, fontSize: 11, lineHeight: 1.5, color: T.muted }}>
                Post service notes here. Check in, Pause (parts) / checkout, and Job Completed are also added here automatically and alert P1 for a portal update.
              </div>
            </div>
            <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ padding: "4px 8px", borderRadius: 999, background: pendingSevenEleven ? T.warnSoft : T.successSoft, color: pendingSevenEleven ? "#73560C" : T.success, border: `1px solid ${pendingSevenEleven ? `${T.warn}55` : `${T.success}44`}`, fontSize: 10, fontWeight: 700 }}>
                {pendingSevenEleven ? `${pendingSevenEleven} awaiting portal update` : "Portal updates current"}
              </span>
              <span style={{ fontSize: 10, fontWeight: 700, color: T.accent }}>{sevenEleven.length} loaded</span>
            </div>
          </div>
        </div>
        <div style={{ padding: 20 }}>
          <label htmlFor={`seven-eleven-note-${workOrderId}`} style={{ display: "block", fontSize: 11, fontWeight: 700, color: T.ink, marginBottom: 7 }}>
            New 7-Eleven job note
          </label>
          <textarea
            id={`seven-eleven-note-${workOrderId}`}
            aria-describedby={`seven-eleven-note-help-${workOrderId}`}
            value={fieldNoteText}
            onChange={event => setFieldNoteText(event.target.value)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void postDraft("field_note", fieldNoteText, setFieldNoteText);
              }
            }}
            rows={3}
            placeholder="Enter the service or job update that must be copied to 7-Eleven..."
            style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: "11px 13px", borderRadius: 10, border: `1px solid ${T.accent}55`, fontSize: 13, lineHeight: 1.5, fontFamily: "inherit", color: T.ink, background: T.surface, outline: "none" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8, marginBottom: 18 }}>
            <span id={`seven-eleven-note-help-${workOrderId}`} style={{ color: T.accent, fontSize: 10, fontWeight: 650 }}>
              Every note posted here creates a “Needs 7-Eleven update” alert.
            </span>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {isManager && (
                <button type="button" className="btn-soft" onClick={onCopyWorkOrder} style={{ minHeight: 40, padding: "8px 11px", fontSize: 11 }}>
                  Copy work order number
                </button>
              )}
              {isManager && (
                <button type="button" className="btn-soft" onClick={doAiEnhance} disabled={aiEnhancing} style={{ minHeight: 40, padding: "8px 11px", fontSize: 11, opacity: aiEnhancing ? 0.7 : 1, cursor: aiEnhancing ? "default" : "pointer" }}>
                  {aiEnhancing ? "Loading…" : "AI enhance notes · preview"}
                </button>
              )}
              <button
                type="button"
                className="btn-accent"
                onClick={() => void postDraft("field_note", fieldNoteText, setFieldNoteText)}
                disabled={posting || !fieldNoteText.trim()}
                style={{ minHeight: 40, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6, opacity: posting || !fieldNoteText.trim() ? 0.65 : 1, cursor: posting || !fieldNoteText.trim() ? "default" : "pointer" }}
              >
                {posting ? <><BtnSpinner />Posting...</> : "Post 7-Eleven update"}
              </button>
            </div>
          </div>
          {aiNote && (
            <div style={{ background: T.surfaceSoft, border: `1px dashed ${T.accent}`, borderRadius: 12, padding: 18, marginBottom: 16, animation: "fadeUp 0.3s" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.8 }}>✨ AI Enhance · preview</span>
                <button type="button" onClick={() => setAiNote(null)} className="btn-soft" style={{ minHeight: 32, padding: "4px 10px", fontSize: 10 }}>Close</button>
              </div>
              {aiNote === "__PREVIEW__" ? (
                <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.65 }}>
                  <div style={{ fontWeight: 600, color: T.ink, marginBottom: 6 }}>This feature is wired up and ready.</div>
                  When live, this rewrites the contractor&apos;s raw note into a polished, AFM-ready summary while keeping the technical details intact.
                </div>
              ) : (
                <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.65 }}>{aiNote}</div>
              )}
            </div>
          )}
          <ActivityEntryList
            {...entryListProps}
            activities={sevenEleven}
            emptyMessage="No 7-Eleven updates have been recorded on the loaded timeline."
          />
        </div>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ padding: "18px 20px", background: T.surfaceSoft, borderBottom: `1px solid ${T.borderSoft}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 750, color: T.ink }}>General chat &amp; activity</div>
              <div style={{ marginTop: 4, maxWidth: 650, fontSize: 11, lineHeight: 1.5, color: T.muted }}>
                Quotes, invoices, regular conversation, and internal or system activity stay here. Nothing posted here creates a 7-Eleven portal alert.
              </div>
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, color: T.muted }}>{general.length} loaded</span>
          </div>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 7 }}>
            <label htmlFor={`general-activity-note-${workOrderId}`} style={{ fontSize: 11, fontWeight: 700, color: T.ink }}>
              New general message
            </label>
            {isManager && (
              <label style={{ fontSize: 10, fontWeight: 700, color: T.muted }}>
                Visibility
                <select
                  aria-label="General message visibility"
                  value={generalChannel}
                  onChange={event => setGeneralChannel(event.target.value as "internal_note" | "contractor_message")}
                  style={{ marginLeft: 7, padding: "7px 28px 7px 9px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 11 }}
                >
                  <option value="internal_note">P1 internal only</option>
                  <option value="contractor_message">P1 + assigned contractor</option>
                </select>
              </label>
            )}
          </div>
          <textarea
            id={`general-activity-note-${workOrderId}`}
            value={generalText}
            onChange={event => setGeneralText(event.target.value)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void postDraft(isManager ? generalChannel : "contractor_message", generalText, setGeneralText);
              }
            }}
            rows={3}
            placeholder={isManager && generalChannel === "internal_note" ? "Add an internal P1 note..." : "Write a message to P1 and the assigned contractor..."}
            style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: "11px 13px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, lineHeight: 1.5, fontFamily: "inherit", color: T.ink, background: T.surfaceSoft, outline: "none" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8, marginBottom: 18 }}>
            <span style={{ color: T.subtle, fontSize: 10 }}>
              {isManager && generalChannel === "internal_note"
                ? "Visible only to authorized P1 staff."
                : "Visible to P1 and the assigned contractor; never sent to 7-Eleven."}
            </span>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void postDraft(isManager ? generalChannel : "contractor_message", generalText, setGeneralText)}
              disabled={posting || !generalText.trim()}
              style={{ minHeight: 40, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 6, opacity: posting || !generalText.trim() ? 0.65 : 1, cursor: posting || !generalText.trim() ? "default" : "pointer" }}
            >
              {posting ? <><BtnSpinner />Posting...</> : isManager && generalChannel === "internal_note" ? "Post internal note" : "Send message"}
            </button>
          </div>
          <ActivityEntryList
            {...entryListProps}
            activities={general}
            emptyMessage="No general chat or system activity on the loaded timeline."
          />
        </div>
      </div>

      {hasMore && (
        <button
          type="button"
          className="btn-soft"
          disabled={loadingMore}
          onClick={onLoadMore}
          style={{ width: "100%", justifyContent: "center" }}
        >
          {loadingMore
            ? <><BtnSpinnerDark />Loading activity...</>
            : `Load older activity (${activities.length} of ${totalCount ?? activities.length})`}
        </button>
      )}
    </section>
  );
}
