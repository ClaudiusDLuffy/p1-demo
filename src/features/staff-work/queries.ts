import { useQuery } from "@tanstack/react-query";

import { supabase } from "../../lib/supabase/client";
import type { Database } from "../../lib/supabase/database.types";
import type { StaffNotificationRead, StaffWorkTodo } from "./workQueue";

export const STAFF_WORK_TODOS_KEY = ["staff-work-todos"] as const;
export const STAFF_NOTIFICATION_READS_KEY = ["staff-notification-reads"] as const;

type StaffWorkTodoRow = Database["public"]["Tables"]["staff_work_order_todos"]["Row"];
type StaffNotificationReadRow = Database["public"]["Tables"]["staff_work_order_notification_reads"]["Row"];

const mapTodo = (todo: StaffWorkTodoRow): StaffWorkTodo => ({
  id: todo.id,
  workOrderId: todo.work_order_id,
  ownerId: todo.owner_id,
  createdBy: todo.created_by,
  note: todo.note || null,
  createdAt: todo.created_at,
  updatedAt: todo.updated_at,
});

const mapRead = (read: StaffNotificationReadRow): StaffNotificationRead => ({
  userId: read.user_id,
  workOrderId: read.work_order_id,
  readThroughAt: read.read_through_at,
});

export async function loadStaffWorkTodos(): Promise<StaffWorkTodo[]> {
  const sb = supabase();
  const { data, error } = await sb
    .from("staff_work_order_todos")
    .select("*")
    .is("completed_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(mapTodo);
}

export async function loadStaffNotificationReads(): Promise<StaffNotificationRead[]> {
  const sb = supabase();
  const { data, error } = await sb
    .from("staff_work_order_notification_reads")
    .select("*");
  if (error) throw error;
  return (data || []).map(mapRead);
}

export function useStaffWorkTodosQuery(enabled = true) {
  return useQuery({
    queryKey: STAFF_WORK_TODOS_KEY,
    queryFn: loadStaffWorkTodos,
    staleTime: 15_000,
    enabled,
  });
}

export function useStaffNotificationReadsQuery(enabled = true) {
  return useQuery({
    queryKey: STAFF_NOTIFICATION_READS_KEY,
    queryFn: loadStaffNotificationReads,
    staleTime: 15_000,
    enabled,
  });
}

export async function addStaffWorkTodo(workOrderId: string, note?: string | null) {
  const sb = supabase();
  const { data, error } = await sb.rpc("add_work_order_to_my_todos", {
    p_work_order_id: workOrderId,
    p_note: note || null,
  });
  if (error) throw error;
  return data;
}

export async function completeStaffWorkTodo(workOrderId: string) {
  const sb = supabase();
  const { data, error } = await sb.rpc("complete_my_work_order_todo", {
    p_work_order_id: workOrderId,
  });
  if (error) throw error;
  return data;
}

export async function transferStaffWorkTodo(workOrderId: string, ownerId: string) {
  const sb = supabase();
  const { data, error } = await sb.rpc("transfer_work_order_todo", {
    p_work_order_id: workOrderId,
    p_new_owner_id: ownerId,
  });
  if (error) throw error;
  return data;
}

export async function markStaffWorkOrderRead(workOrderId: string, readThroughAt: string) {
  const sb = supabase();
  const { data, error } = await sb.rpc("mark_staff_work_order_read", {
    p_work_order_id: workOrderId,
    p_read_through_at: readThroughAt,
  });
  if (error) throw error;
  return data;
}
