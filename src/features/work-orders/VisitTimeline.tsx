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

export default function VisitTimeline({
  workOrder,
  visits = [],
  totalCount,
  hasMore,
  onLoadMore,
  loadingMore = false,
  currentUser,
  fire,
}: any) {
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
  const displayedTotal = totalCount ?? visits.length;

  const orderedVisits = useMemo(
    () => [...visits].sort((left: any, right: any) =>
      new Date(right.checkInAt || 0).getTime() - new Date(left.checkInAt || 0).getTime(),
    ),
    [visits],
  );

  const startEditing = (visit: any) => {
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
  };

  const save = async () => {
    if (!editingId) return;
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
      await correctWorkOrderVisit(editingId, checkInAt, checkOutAt, form.reason);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workOrderDetailsKey(workOrder.id) }),
        queryClient.invalidateQueries({ queryKey: WORK_ORDERS_KEY }),
        queryClient.invalidateQueries({ queryKey: WORK_ORDER_PAGES_KEY }),
        queryClient.invalidateQueries({ queryKey: WORK_ORDER_BY_ID_KEY }),
        queryClient.invalidateQueries({ queryKey: ["work-order-visits", "billing", workOrder.id] }),
      ]);
      setEditingId(null);
      fire?.("Visit times corrected and recorded in the audit history");
    } catch (caught: any) {
      setError(caught?.message || "Visit times could not be corrected");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 750, color: T.ink }}>Visit history · {displayedTotal}</div>
          <div style={{ fontSize: 10, color: T.subtle, marginTop: 3 }}>
            Times are shown in the store time zone ({timeZone}). Corrections require a reason and are audited.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {orderedVisits.map((visit: any, index: number) => {
          const editing = editingId === visit.id;
          const isStaff = ["manager", "dispatcher", "back_office"].includes(currentUser?.role);
          const checkedOutAt = new Date(visit.checkOutAt || 0).getTime();
          const contractorWindowOpen = workOrder.status !== "closed"
            && Number.isFinite(checkedOutAt)
            && checkedOutAt >= Date.now() - 24 * 60 * 60 * 1000;
          const canOfferCorrection = Boolean(
            visit.checkOutAt && (isStaff || contractorWindowOpen),
          );
          return (
            <div key={visit.id} style={{ padding: "10px 12px", border: `1px solid ${T.borderSoft}`, borderRadius: 9, background: T.surfaceSoft }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 11, color: T.ink }}>Visit {displayedTotal - index}</strong>
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
                    <button type="button" className="btn-soft" disabled={saving} onClick={() => setEditingId(null)}>Cancel</button>
                    <button type="button" className="btn-primary" disabled={saving || form.reason.trim().length < 5} onClick={save} style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
          {loadingMore ? <><BtnSpinnerDark />Loading visits...</> : `Load older visits (${visits.length} of ${displayedTotal})`}
        </button>
      )}
    </div>
  );
}
