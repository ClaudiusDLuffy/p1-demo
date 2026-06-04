import { z } from "zod";

export const WorkOrderSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  status: z.enum(["open", "in_progress", "paused", "completed", "cancelled"]),
  contractor_id: z.string().uuid().nullable(),
  nte: z.number().nullable(),
  created_at: z.string(),
});

export const InvoiceSchema = z.object({
  id: z.string().uuid(),
  work_order_id: z.string().uuid(),
  invoice_number: z.string().min(1),
  status: z.enum(["draft", "submitted", "approved", "paid"]),
  total: z.number().nonnegative(),
  created_at: z.string(),
});

export const InvoiceLineSchema = z.object({
  id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  description: z.string().min(1),
  qty: z.number().positive(),
  rate: z.number().positive(),
});

export const PhotoSchema = z.object({
  id: z.string().uuid(),
  work_order_id: z.string().uuid(),
  storage_path: z.string().min(1),
  uploader_id: z.string().uuid(),
  created_at: z.string(),
});

export type WorkOrder = z.infer<typeof WorkOrderSchema>;
export type Invoice = z.infer<typeof InvoiceSchema>;
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;
export type Photo = z.infer<typeof PhotoSchema>;
