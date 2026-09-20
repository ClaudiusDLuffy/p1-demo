"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { T } from "../../lib/constants";
import {
  dateTimeInputPartsInTimeZone,
  storeLocalDateTimeToIso,
  timezoneForWorkOrder,
} from "../../lib/billingRules";
import { correctWorkOrderVisit } from "../../lib/db";
import {
  canOfferVisitCorrection,
  safeVisitCorrectionError,
  validateVisitCorrection,
} from "../../lib/visitCorrection";
import { requiresVisitDurationReview, VISIT_DURATION_REVIEW_MESSAGE } from "../../lib/visitDurationReview";
import {
  WORK_ORDER_BY_ID_KEY,
  WORK_ORDER_PAGES_KEY,
  WORK_ORDERS_KEY,
  workOrderDetailsKey,
} from "./queries";

const formatVisitTime = (value: string | null, timeZone: string) => {
  if (!value) return "In progress";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const inputParts = (value: string | null, timeZone: string) =>
  value
    ? dateTimeInputPartsInTimeZone(new Date(value), timeZone)
    : { date: "", time: "" };

type VisitTimelineVisit = {
  id: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  closureKind?: string | null;
  durationReviewRequired?: boolean;
};

type VisitTimelineProps = {
  workOrder: Record<string, unknown> & { id: string; status?: string | null };
  visits?: VisitTimelineVisit[];
  totalCount?: number | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  currentUser?: { role?: string | null } | null;
  fire?: (message: string) => void;
};

export default function VisitTimeline({
  workOrder,
  visits = [],
  totalCount,
  hasMore,
  onLoadMore,
  loadingMore = false,
  currentUser,
  fire,
}: VisitTimelineProps) {
  const queryClient = useQueryClient();
  const timeZone = timezoneForWorkOrder(workOrder);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    checkInDate: "",
    checkInTime: "",
    checkOutDate: "",
    checkOutTime: "",
    reason: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [rejectedCorrection, setRejectedCorrection] = useState<string | null>(null);
  const displayedTotal: number | null = typeof totalCount === "number" ? totalCount : null;
  const correctionFingerprint = editingId ? JSON.stringify([
    editingId, form.checkInDate, form.checkInTime, form.checkOutDate, form.checkOutTime, form.reason.trim(),
  ]) : "";

  const orderedVisits = useMemo(
    () => [...visits].sort((left, right) =>
      new Date(right.checkInAt || 0).getTime() - new Date(left.checkInAt || 0).getTime(),
    ),
    [visits],
  );

  const startEditing = (visit: VisitTimelineVisit) => {
    if (!visit.checkOutAt) return;
    const checkIn = inputParts(visit.checkInAt, timeZone);
    const checkOut = inputParts(visit.checkOutAt, timeZone);
    setEditingId(visit.id);
    setForm({
      checkInDate: checkIn.date,
      checkInTime: checkIn.time,
      checkOutDate: checkOut.date,
      checkOutTime: checkOut.time,
      reason: "",
    });
    setError("");
    setRejectedCorrection(null);
  };

  const save = async () => {
    if (!editingId || rejectedCorrection === correctionFingerprint) return;
    const attemptedCorrection = correctionFingerprint;
    setSaving(true);
    setError("");
    try {
      const checkInAt = storeLocalDateTimeToIso(
        form.checkInDate,
        form.checkInTime,
        timeZone,
      );
      const checkOutAt = storeLocalDateTimeToIso(
        form.checkOutDate,
        form.checkOutTime,
        timeZone,
      );
      const visit = (visits as Array<{
        id?: string;
        checkInAt?: string | null;
        checkOutAt?: string | null;
      }>).find(candidate => candidate.id === editingId);
      validateVisitCorrection({
        checkInAt,
        checkOutAt,
        reason: form.reason,
        originalCheckInAt: visit?.checkInAt,
        originalCheckOutAt: visit?.checkOutAt,
      });
      await correctWorkOrderVisit(editingId, checkInAt, checkOutAt, form.reason);
      setEditingId(null);
      fire?.("Visit times corrected and recorded in the audit history");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workOrderDetailsKey(workOrder.id) }),
        queryClient.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
        queryClient.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY }),
        queryClient.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY }),
        queryClient.invalidateQueries({ queryKey: ["work-order-visits", "billing", workOrder.id] }),
      ]).catch(() => {
        fire?.("Visit times were corrected, but the refreshed timeline is unavailable. Refresh the work order to see the saved times.");
      });
    } catch (caught: unknown) {
      const failure = safeVisitCorrectionError(caught);
      setError(failure.message);
      if (failure.code === "VISIT_TIME_OVERLAP" || failure.code === "VISIT_CHANGED") {
        setRejectedCorrection(attemptedCorrection);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
        <div>
          <div title="Total is exact at the last count refresh." style={{ fontSize: 13, fontWeight: 750, color: T.ink }}>Field visit timeline · {displayedTotal ?? `${visits.length} loaded`}</div>
          <div style={{ fontSize: 10, color: T.subtle, marginTop: 3 }}>
            Technician check-in and check-out times for this work order are shown in the store time zone ({timeZone}). Corrections require a reason and are audited.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {orderedVisits.map((visit, index) => {
          const editing = editingId === visit.id;
          const canOfferCorrection = canOfferVisitCorrection({
            role: currentUser?.role,
            workOrderStatus: workOrder.status,
            checkOutAt: visit.checkOutAt,
          });
          return (
            <div key={visit.id} style={{ padding: "10px 12px", border: `1px solid ${T.borderSoft}`, borderRadius: 9, background: T.surfaceSoft }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 11, color: T.ink }}>{displayedTotal !== null && displayedTotal > index ? `Visit ${displayedTotal - index}` : `Loaded visit ${index + 1}`}</strong>
                  <div style={{ marginTop: 3, fontSize: 11, color: T.muted }}>
                    {formatVisitTime(visit.checkInAt, timeZone)} → {formatVisitTime(visit.checkOutAt, timeZone)}
                  </div>
                </div>
                {canOfferCorrection && !editing && (
                  <button type="button" className="btn-soft" onClick={() => startEditing(visit)} style={{ padding: "6px 9px", fontSize: 10 }}>
                    Correct actual time
                  </button>
                )}
              </div>

              {requiresVisitDurationReview(visit) && (
                <div role="note" style={{ marginTop: 8, fontSize: 11, color: T.warn }}>{VISIT_DURATION_REVIEW_MESSAGE} Correcting times does not approve this duration.</div>
              )}
              {editing && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderSoft}`, display: "grid", gap: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <label style={{ fontSize: 10, color: T.muted }}>
                      Actual check-in date
                      <input type="date" value={form.checkInDate} onChange={event => setForm(current => ({ ...current, checkInDate: event.target.value }))} style={{ width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: `1px solid ${T.border}`, fontFamily: "inherit" }} />
                    </label>
                    <label style={{ fontSize: 10, color: T.muted }}>
                      Actual check-in time
                      <input type="time" value={form.checkInTime} onChange={event => setForm(current => ({ ...current, checkInTime: event.target.value }))} style={{ width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: `1px solid ${T.border}`, fontFamily: "inherit" }} />
                    </label>
                    <label style={{ fontSize: 10, color: T.muted }}>
                      Actual check-out date
                      <input type="date" value={form.checkOutDate} onChange={event => setForm(current => ({ ...current, checkOutDate: event.target.value }))} style={{ width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: `1px solid ${T.border}`, fontFamily: "inherit" }} />
                    </label>
                    <label style={{ fontSize: 10, color: T.muted }}>
                      Actual check-out time
                      <input type="time" value={form.checkOutTime} onChange={event => setForm(current => ({ ...current, checkOutTime: event.target.value }))} style={{ width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: `1px solid ${T.border}`, fontFamily: "inherit" }} />
                    </label>
                  </div>
                  <label style={{ fontSize: 10, color: T.muted }}>
                    Correction reason
                    <textarea value={form.reason} onChange={event => setForm(current => ({ ...current, reason: event.target.value }))} rows={2} placeholder="Explain why the recorded time was inaccurate" style={{ width: "100%", boxSizing: "border-box", marginTop: 4, padding: 8, borderRadius: 8, border: `1px solid ${T.border}`, fontFamily: "inherit", resize: "vertical" }} />
                  </label>
                  {error && <div role="alert" style={{ fontSize: 11, color: T.danger }}>{error}</div>}
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button type="button" className="btn-soft" disabled={saving} onClick={() => { setEditingId(null); setRejectedCorrection(null); }}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={saving || form.reason.trim().length < 5 || rejectedCorrection === correctionFingerprint} onClick={save} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {saving ? <><BtnSpinnerDark />Saving...</> : "Save correction"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {orderedVisits.length === 0 && (
          <div style={{ fontSize: 12, color: T.subtle }}>No visits have been recorded.</div>
        )}
      </div>

      {hasMore && (
        <button type="button" className="btn-soft" disabled={loadingMore} onClick={onLoadMore} style={{ width: "100%", justifyContent: "center", marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
          {loadingMore ? <><BtnSpinnerDark />Loading visits...</> : `Load older visits (${visits.length} loaded${displayedTotal === null ? "" : ` of ${displayedTotal} at last refresh`})`}
        </button>
      )}
    </div>
  );
}
