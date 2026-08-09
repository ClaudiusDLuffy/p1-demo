import {
  getWorkOrderActionReasons,
  workOrderHasPendingSevenElevenSync,
  type WorkOrderViewRow,
} from "../../lib/workOrderView";

export type StaffWorkFilter = "all" | "unread" | "todo" | "ready";

export type StaffWorkTodo = {
  id: string;
  workOrderId: string;
  ownerId: string;
  createdBy: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StaffNotificationRead = {
  userId: string;
  workOrderId: string;
  readThroughAt: string;
};

export type StaffWorkActivity = {
  enteredByRole?: string | null;
  createdAt?: string | null;
};

export type StaffWorkOrder = WorkOrderViewRow & {
  id: string;
  status: string;
  store?: string | null;
  summary?: string | null;
  description?: string | null;
  activities?: StaffWorkActivity[];
};

export type StaffWorkProfile = {
  id: string;
  name?: string | null;
};

export type StaffWorkRow = {
  workOrder: StaffWorkOrder;
  todo: StaffWorkTodo | null;
  todoOwner: StaffWorkProfile | null;
  isMyTodo: boolean;
  isUnread: boolean;
  latestNotificationAt: string | null;
  isReadyToBill: boolean;
  actionReasons: string[];
};

const timestamp = (value: string | null | undefined) => {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};

export function latestContractorActivityAt(workOrder: StaffWorkOrder): string | null {
  const contractorActivities = (workOrder?.activities || [])
    .filter(activity => activity?.enteredByRole === "contractor")
    .map(activity => activity.createdAt)
    .filter((value): value is string => Boolean(value))
    .sort((left: string, right: string) => timestamp(right) - timestamp(left));

  return contractorActivities[0] || null;
}

export function buildStaffWorkRows({
  workOrders,
  todos,
  reads,
  profiles,
  readyWorkOrderIds,
  currentUserId,
}: {
  workOrders: StaffWorkOrder[];
  todos: StaffWorkTodo[];
  reads: StaffNotificationRead[];
  profiles: StaffWorkProfile[];
  readyWorkOrderIds: Set<string>;
  currentUserId: string;
}): StaffWorkRow[] {
  const todoByWorkOrder = new Map(todos.map(todo => [todo.workOrderId, todo]));
  const readByWorkOrder = new Map(reads.map(read => [read.workOrderId, read]));
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));

  return workOrders
    .filter(workOrder => workOrder.status !== "closed")
    .map(workOrder => {
      const todo = todoByWorkOrder.get(workOrder.id) || null;
      const latestNotificationAt = latestContractorActivityAt(workOrder);
      const read = readByWorkOrder.get(workOrder.id);
      const isUnread = Boolean(
        latestNotificationAt
        && timestamp(latestNotificationAt) > timestamp(read?.readThroughAt),
      );
      const isReadyToBill = readyWorkOrderIds.has(workOrder.id);
      const actionReasons = getWorkOrderActionReasons(workOrder, true)
        .filter(reason => reason !== "Unread activity");

      return {
        workOrder,
        todo,
        todoOwner: todo ? profileById.get(todo.ownerId) || null : null,
        isMyTodo: todo?.ownerId === currentUserId,
        isUnread,
        latestNotificationAt,
        isReadyToBill,
        actionReasons,
      };
    })
    .filter(row =>
      row.isUnread
      || row.todo
      || row.isReadyToBill
      || row.actionReasons.length > 0
    )
    .sort((left, right) => {
      const sevenElevenDifference = Number(
        workOrderHasPendingSevenElevenSync(right.workOrder),
      ) - Number(workOrderHasPendingSevenElevenSync(left.workOrder));
      if (sevenElevenDifference) return sevenElevenDifference;

      const unreadDifference = Number(right.isUnread) - Number(left.isUnread);
      if (unreadDifference) return unreadDifference;

      const myTodoDifference = Number(right.isMyTodo) - Number(left.isMyTodo);
      if (myTodoDifference) return myTodoDifference;

      const readyDifference = Number(right.isReadyToBill) - Number(left.isReadyToBill);
      if (readyDifference) return readyDifference;

      return timestamp(
        right.latestNotificationAt || right.workOrder.updatedAt || right.workOrder.createdAt,
      ) - timestamp(
        left.latestNotificationAt || left.workOrder.updatedAt || left.workOrder.createdAt,
      );
    });
}

export function filterStaffWorkRows(rows: StaffWorkRow[], filter: StaffWorkFilter) {
  if (filter === "unread") return rows.filter(row => row.isUnread);
  if (filter === "todo") return rows.filter(row => row.isMyTodo);
  if (filter === "ready") return rows.filter(row => row.isReadyToBill);
  return rows;
}
