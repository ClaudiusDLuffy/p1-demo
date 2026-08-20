"use client";

import { useMemo } from "react";

import { CopyWorkOrderButton } from "../../components/ui/CopyWorkOrderButton";
import { T, PRIORITY, STATUS } from "../../lib/constants";
import { useCursorPagination } from "../../lib/useCursorPagination";
import { useWorkOrdersPageQuery } from "../work-orders/queries";
import type {
  StaffNotificationRead,
  StaffWorkFilter,
  StaffWorkProfile,
  StaffWorkRow,
  StaffWorkTodo,
} from "./workQueue";
import { buildStaffWorkRows, filterStaffWorkRows } from "./workQueue";

const FILTERS: { value: StaffWorkFilter; label: string }[] = [
  { value: "all", label: "All work" },
  { value: "unread", label: "Unread" },
  { value: "todo", label: "My to-do" },
  { value: "ready", label: "Ready to Bill" },
];

const chipStyle = (background: string, color: string) => ({
  display: "inline-flex",
  alignItems: "center",
  minHeight: 24,
  padding: "4px 8px",
  borderRadius: 999,
  background,
  color,
  fontSize: 10,
  fontWeight: 800,
  lineHeight: 1.2,
});

export default function StaffWorkHub({
  page,
  rows,
  filter,
  setFilter,
  staffProfiles,
  busyWorkOrderId,
  onOpenWorkOrder,
  onAddTodo,
  onCompleteTodo,
  onTransferTodo,
  onOpenBilling,
  todos = [],
  reads = [],
  currentUserId = "",
  summaryCounts,
}: {
  page: string;
  rows: StaffWorkRow[];
  filter: StaffWorkFilter;
  setFilter: (filter: StaffWorkFilter) => void;
  staffProfiles: StaffWorkProfile[];
  busyWorkOrderId: string | null;
  onOpenWorkOrder: (row: StaffWorkRow) => void;
  onAddTodo: (workOrderId: string) => void;
  onCompleteTodo: (workOrderId: string) => void;
  onTransferTodo: (workOrderId: string, ownerId: string) => void;
  onOpenBilling: (workOrderId: string) => void;
  todos?: StaffWorkTodo[];
  reads?: StaffNotificationRead[];
  currentUserId?: string;
  summaryCounts?: {
    all: number;
    unread: number;
    todo: number;
    ready: number;
  };
}) {
  const scope = filter === "unread"
    ? "staff_work_unread"
    : filter === "todo"
      ? "staff_work_todo"
      : filter === "ready"
        ? "staff_work_ready"
        : "staff_work";
  const {
    position,
    previous: previousPage,
    next: nextPage,
  } = useCursorPagination(scope);
  const workPageQuery = useWorkOrdersPageQuery({
    scope,
    sort: "newest",
    limit: 25,
    cursor: position.cursor,
  }, page === "staff_work");
  const pageRows = useMemo(
    () => {
      const pageWorkOrders = workPageQuery.data?.items || [];
      const pageTodos = pageWorkOrders
        .map(workOrder => (workOrder as typeof workOrder & { staffTodo?: StaffWorkTodo | null }).staffTodo)
        .filter((todo): todo is StaffWorkTodo => Boolean(todo));
      const pageReads = pageWorkOrders
        .map(workOrder => ({
          userId: currentUserId,
          workOrderId: workOrder.id,
          readThroughAt: String((workOrder as typeof workOrder & { staffReadThroughAt?: string | null }).staffReadThroughAt || ""),
        }))
        .filter(read => Boolean(read.readThroughAt));

      return buildStaffWorkRows({
        workOrders: pageWorkOrders,
        todos: pageTodos.length ? pageTodos : todos,
        reads: pageReads.length ? pageReads : reads,
        profiles: staffProfiles,
        readyWorkOrderIds: new Set(
          pageWorkOrders
            .filter(workOrder => ["pending_invoice", "pending_payment"].includes(workOrder.status))
            .map(workOrder => workOrder.id),
        ),
        currentUserId,
      });
    },
    [currentUserId, reads, staffProfiles, todos, workPageQuery.data?.items],
  );
  const visibleRows = useMemo(
    () => workPageQuery.data
      ? filterStaffWorkRows(pageRows, filter)
      : filterStaffWorkRows(rows, filter),
    [filter, pageRows, rows, workPageQuery.data],
  );
  const myTodoCount = summaryCounts?.todo ?? rows.filter(row => row.isMyTodo).length;
  const unreadCount = summaryCounts?.unread ?? rows.filter(row => row.isUnread).length;
  const readyCount = summaryCounts?.ready ?? rows.filter(row => row.isReadyToBill).length;
  const filterCounts: Record<StaffWorkFilter, number> = {
    all: summaryCounts?.all ?? rows.length,
    unread: unreadCount,
    todo: myTodoCount,
    ready: readyCount,
  };

  if (page !== "staff_work") return null;

  return (
    <div style={{ animation: "fadeUp 0.25s" }}>
      <div
        className="card"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          marginBottom: 16,
          padding: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ color: T.ink, fontSize: 14, fontWeight: 800 }}>One place for staff follow-up</div>
          <div style={{ color: T.muted, fontSize: 11, marginTop: 4 }}>
            Unread updates, personal follow-up, and Ready to Bill are merged by work order.
          </div>
          <div style={{ color: T.subtle, fontSize: 10, marginTop: 4, lineHeight: 1.45 }}>
            Unread is personal new activity. A 7-Eleven update is a specific activity still waiting to be copied; one work order can have both labels.
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: T.ink, fontSize: 14, fontWeight: 800 }}>{myTodoCount} / 5</div>
          <div style={{ color: T.subtle, fontSize: 10 }}>personal to-do slots used</div>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="My Work filters"
        style={{ display: "flex", gap: 8, marginBottom: 14, overflowX: "auto", paddingBottom: 2 }}
      >
        {FILTERS.map(item => {
          const active = filter === item.value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(item.value)}
              style={{
                flex: "0 0 auto",
                minHeight: 38,
                padding: "8px 12px",
                borderRadius: 9,
                border: `1px solid ${active ? T.accent : T.border}`,
                background: active ? T.accentSoft : T.surface,
                color: active ? T.accent : T.inkSoft,
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              {item.label} · {filterCounts[item.value]}
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {visibleRows.map(row => {
          const workOrder = row.workOrder;
          const status = STATUS[workOrder.status];
          const priority = PRIORITY[workOrder.priority];
          const busy = busyWorkOrderId === workOrder.id;
          return (
            <article key={workOrder.id} className="card" style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: "1 1 360px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => onOpenWorkOrder(row)}
                      className="mono"
                      style={{ border: 0, background: "none", padding: 0, color: T.accent, fontSize: 13, fontWeight: 800, cursor: "pointer" }}
                    >
                      {workOrder.id}
                    </button>
                    <CopyWorkOrderButton value={workOrder.id} />
                    {row.isUnread && <span style={chipStyle("#DBEAFE", "#1D4ED8")}>Unread</span>}
                    {row.isReadyToBill && <span style={chipStyle("#DCFCE7", "#166534")}>Ready to Bill</span>}
                    {row.todo && (
                      <span style={chipStyle(row.isMyTodo ? "#FEE2E2" : "#F3E8FF", row.isMyTodo ? "#991B1B" : "#6B21A8")}>
                        {row.isMyTodo ? "My to-do" : `${row.todoOwner?.name || "Staff"}'s to-do`}
                      </span>
                    )}
                  </div>
                  <div style={{ color: T.ink, fontSize: 13, fontWeight: 650, marginTop: 8, overflowWrap: "anywhere" }}>
                    Store #{workOrder.store || "-"} · {workOrder.summary || workOrder.description || "No summary"}
                  </div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 }}>
                    {priority && <span style={chipStyle(priority.bg, priority.color)}>{priority.label}</span>}
                    {status && <span style={chipStyle(status.bg, status.color)}>{status.label}</span>}
                    {row.actionReasons.map(reason => (
                      <span key={reason} style={chipStyle(T.surfaceSoft, T.muted)}>{reason}</span>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap", flex: "1 1 300px" }}>
                  {row.todo ? (
                    <>
                      <select
                        aria-label={`To-do owner for ${workOrder.id}`}
                        value={row.todo.ownerId}
                        disabled={busy}
                        onChange={event => onTransferTodo(workOrder.id, event.target.value)}
                        style={{ minHeight: 36, maxWidth: 180, padding: "7px 9px", borderRadius: 8, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontFamily: "inherit", fontSize: 11 }}
                      >
                        {staffProfiles.map(profile => (
                          <option key={profile.id} value={profile.id}>{profile.name}</option>
                        ))}
                      </select>
                      {row.isMyTodo && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onCompleteTodo(workOrder.id)}
                          className="btn-soft"
                          style={{ minHeight: 36, padding: "8px 11px", fontSize: 11 }}
                        >
                          Complete to-do
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || myTodoCount >= 5}
                      onClick={() => onAddTodo(workOrder.id)}
                      className="btn-soft"
                      title={myTodoCount >= 5 ? "Complete or transfer an item before adding another" : undefined}
                      style={{ minHeight: 36, padding: "8px 11px", fontSize: 11, opacity: myTodoCount >= 5 ? 0.5 : 1 }}
                    >
                      Add to my to-do
                    </button>
                  )}
                  {row.isReadyToBill && (
                    <button
                      type="button"
                      onClick={() => onOpenBilling(workOrder.id)}
                      className="btn-accent"
                      style={{ minHeight: 36, padding: "8px 11px", fontSize: 11 }}
                    >
                      Create invoice
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenWorkOrder(row)}
                    className="btn-soft"
                    style={{ minHeight: 36, padding: "8px 11px", fontSize: 11 }}
                  >
                    Open
                  </button>
                </div>
              </div>
            </article>
          );
        })}

        {visibleRows.length === 0 && (
          <div className="card" style={{ padding: 34, textAlign: "center", color: T.subtle, fontSize: 13 }}>
            Nothing is waiting in this view.
          </div>
        )}
      </div>
      <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ color: T.muted, fontSize: 11 }}>
          {workPageQuery.isFetching
            ? "Loading work…"
            : `${workPageQuery.data?.totalCount || 0} items · page ${position.page}`}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn-soft" disabled={position.page <= 1 || workPageQuery.isFetching} onClick={previousPage}>Previous</button>
          <button type="button" className="btn-soft" disabled={!workPageQuery.data?.hasMore || workPageQuery.isFetching} onClick={() => nextPage(workPageQuery.data?.nextCursor || null)}>Next</button>
        </span>
      </div>
    </div>
  );
}
