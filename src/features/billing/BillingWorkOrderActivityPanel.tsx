"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import { T } from "../../lib/constants";
import { getPhotoUrl } from "../../lib/db";
import {
  billingActivityLabel,
  type BillingActivityRecord,
  isStaffBillingActivityViewer,
  visibleBillingActivities,
} from "../../lib/billingActivity";
import { timezoneForWorkOrder } from "../../lib/billingRules";

type BillingVisit = {
  id?: string;
  checkInAt?: string | null;
  checkOutAt?: string | null;
};

type BillingWorkOrder = Record<string, unknown> & {
  activities?: BillingActivityRecord[];
  visits?: BillingVisit[];
  photos?: string[];
  startTimeRaw?: string | null;
  endTimeRaw?: string | null;
};

type BillingActivityPanelProps = {
  currentUser?: { role?: string | null } | null;
  workOrder?: BillingWorkOrder | null;
};

const localDateTime = (value: string | null | undefined, timeZone: string) => {
  if (!value) return "Open";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

export default function BillingWorkOrderActivityPanel({ currentUser, workOrder }: BillingActivityPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [resolvedPhotos, setResolvedPhotos] = useState<{
    key: string;
    urls: Record<string, string>;
  }>({ key: "", urls: {} });
  const staffViewer = isStaffBillingActivityViewer(currentUser?.role);
  const timeZone = timezoneForWorkOrder(workOrder);
  const activities = useMemo(
    () => visibleBillingActivities(workOrder?.activities || [], currentUser?.role),
    [currentUser?.role, workOrder?.activities],
  );
  const visits = useMemo(() => {
    const recorded = (workOrder?.visits || []).filter(visit => visit?.checkInAt);
    if (recorded.length > 0) return recorded;
    if (!workOrder?.startTimeRaw) return [];
    return [{
      id: "legacy",
      checkInAt: workOrder.startTimeRaw,
      checkOutAt: workOrder.endTimeRaw || null,
    }];
  }, [workOrder]);
  const photos = useMemo(() => workOrder?.photos || [], [workOrder?.photos]);
  const photoKey = photos.join("\u0000");
  const photoUrls = resolvedPhotos.key === photoKey ? resolvedPhotos.urls : {};
  const photosLoading = expanded
    && photos.length > 0
    && resolvedPhotos.key !== photoKey;

  useEffect(() => {
    if (!staffViewer || !expanded || photos.length === 0) {
      return;
    }
    let active = true;
    const objectUrls: string[] = [];
    void Promise.all(photos.map(async (path: string) => {
      try {
        const url = await getPhotoUrl(path);
        if (url?.startsWith("blob:")) objectUrls.push(url);
        return [path, url] as const;
      } catch {
        return [path, null] as const;
      }
    })).then(entries => {
      if (!active) {
        for (const url of objectUrls) URL.revokeObjectURL(url);
        return;
      }
      setResolvedPhotos({
        key: photoKey,
        urls: Object.fromEntries(entries.filter(([, url]) => !!url)),
      });
    });
    return () => {
      active = false;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [expanded, photoKey, photos, staffViewer]);

  // This is an intentional hard boundary. Even if the component is imported
  // into a contractor screen later, it renders nothing for a contractor role.
  if (!staffViewer) return null;

  return (
    <aside
      aria-label="Staff work-order activity"
      style={{
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 12,
        background: T.surfaceSoft,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          padding: "13px 14px",
          border: "none",
          background: T.surface,
          color: T.ink,
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <span>
          <strong style={{ display: "block", fontSize: 12 }}>Work-order activity</strong>
          <span style={{ display: "block", marginTop: 2, fontSize: 10, color: T.subtle }}>
            Staff only · read only
          </span>
        </span>
        <span aria-hidden="true" style={{ color: T.subtle }}>{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div style={{ maxHeight: "68vh", overflowY: "auto", padding: 12 }}>
          {!workOrder ? (
            <div style={{ padding: "18px 8px", textAlign: "center", fontSize: 11, color: T.subtle }}>
              Select a work order to see its visits, notes, status changes, and photos.
            </div>
          ) : (
            <>
              <section style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 7, fontSize: 9, fontWeight: 800, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.7 }}>
                  Check in / check out
                </div>
                {visits.length === 0 ? (
                  <div style={{ fontSize: 11, color: T.subtle }}>No visits recorded.</div>
                ) : visits.map((visit, index: number) => (
                  <div key={visit.id || index} style={{ padding: "8px 9px", marginBottom: 6, borderRadius: 8, background: T.surface, border: `1px solid ${T.borderSoft}`, fontSize: 10, lineHeight: 1.5 }}>
                    <strong style={{ color: T.ink }}>Visit {index + 1}</strong>
                    <div style={{ color: T.muted }}>In: {localDateTime(visit.checkInAt, timeZone)}</div>
                    <div style={{ color: T.muted }}>Out: {localDateTime(visit.checkOutAt, timeZone)}</div>
                  </div>
                ))}
              </section>

              <section style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 7, fontSize: 9, fontWeight: 800, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.7 }}>
                  Notes and status
                </div>
                {activities.length === 0 ? (
                  <div style={{ fontSize: 11, color: T.subtle }}>No matching activity recorded.</div>
                ) : activities.slice(0, 60).map(activity => (
                  <div key={activity.id} style={{ padding: "8px 9px", marginBottom: 6, borderRadius: 8, background: T.surface, border: `1px solid ${T.borderSoft}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 3, fontSize: 9 }}>
                      <strong style={{ color: T.accent }}>{billingActivityLabel(activity)}</strong>
                      <span style={{ color: T.subtle, textAlign: "right" }}>{activity.time || localDateTime(activity.createdAt, timeZone)}</span>
                    </div>
                    <div style={{ color: T.ink, fontSize: 10, lineHeight: 1.45, overflowWrap: "anywhere" }}>{activity.text}</div>
                    {activity.author && <div style={{ marginTop: 3, color: T.subtle, fontSize: 9 }}>By {activity.author}</div>}
                  </div>
                ))}
              </section>

              <section>
                <div style={{ marginBottom: 7, fontSize: 9, fontWeight: 800, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.7 }}>
                  Photos ({photos.length})
                </div>
                {photosLoading && photos.length > 0 && <div style={{ marginBottom: 7, fontSize: 10, color: T.subtle }}>Loading thumbnails…</div>}
                {photos.length === 0 ? (
                  <div style={{ fontSize: 11, color: T.subtle }}>No photos recorded.</div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 7 }}>
                    {photos.map((path: string, index: number) => (
                      <div key={path || index} style={{ aspectRatio: "1", overflow: "hidden", borderRadius: 8, border: `1px solid ${T.borderSoft}`, background: T.surface }}>
                        {photoUrls[path] ? (
                          <img src={photoUrls[path]} alt={`Work order photo ${index + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        ) : (
                          <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 6, color: T.subtle, fontSize: 9, textAlign: "center" }}>Photo unavailable</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
