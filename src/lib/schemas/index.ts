import { z } from "zod";

export const WorkOrderSchema = z.object({
  id: z.string().min(1),
  summary: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  status: z.enum([
    "unassigned", "assigned", "wip", "parts", "capital", "pending_capital_completion",
    "completed", "pending_invoice", "pending_approval",
    "pending_payment", "closed"
  ]),
  priority: z.enum(["p1", "p2", "p3", "p4", "p5"]).optional().nullable(),
  contractor_id: z.string().optional().nullable(),
  nte: z.number().optional().nullable(),
  store_number: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  functional_status: z.string().optional().nullable(),
  dispatched_at: z.string().optional().nullable(),
  created_at: z.string(),
  updated_at: z.string().optional().nullable(),
  closed_at: z.string().optional().nullable(),
  nte_flagged: z.boolean().optional().nullable(),
  nte_flag_threshold: z.number().optional().nullable(),
  nte_flag_amount: z.number().optional().nullable(),
  is_capital: z.boolean().optional().nullable(),
  technician_on_job: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
})

export type WorkOrder = z.infer<typeof WorkOrderSchema>

export const InvoiceSchema = z.object({
  id: z.string().uuid(),
  num: z.string().min(1),
  work_order_id: z.string().optional().nullable(),
  invoice_type: z.enum(["contractor", "staff"]).optional().nullable(),
  store_number: z.string().optional().nullable(),
  store_address: z.string().optional().nullable(),
  contractor_id: z.string().optional().nullable(),
  cme: z.string().optional().nullable(),
  invoice_date: z.string().optional().nullable(),
  service_date: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
  state: z.enum(["draft", "submitted", "approved", "rejected", "revised", "paid"]),
  subtotal: z.number(),
  sales_tax: z.number().optional().nullable(),
  total: z.number(),
  pdf_storage_path: z.string().optional().nullable(),
  rejection_reason: z.string().optional().nullable(),
  review_revision: z.number().int().positive().optional(),
  rejected_at: z.string().optional().nullable(),
  rejected_by: z.string().uuid().optional().nullable(),
  resubmitted_at: z.string().optional().nullable(),
  resubmitted_by: z.string().uuid().optional().nullable(),
  created_at: z.string().optional().nullable(),
})

export type Invoice = z.infer<typeof InvoiceSchema>

export const InvoiceLineSchema = z.object({
  id: z.string().uuid().optional(),
  invoice_id: z.string().uuid(),
  position: z.number().int().optional(),
  type: z.string().min(1),
  description: z.string().min(1),
  qty: z.number().positive(),
  rate: z.number().nonnegative(),
  amount: z.number().optional(),
})

export type InvoiceLine = z.infer<typeof InvoiceLineSchema>

export const PhotoSchema = z.object({
  id: z.string().uuid().optional(),
  work_order_id: z.string().min(1),
  storage_path: z.string().min(1),
  uploader_id: z.string().uuid().optional().nullable(),
  uploader_name: z.string().optional().nullable(),
  created_at: z.string().optional().nullable(),
})

export type Photo = z.infer<typeof PhotoSchema>

export const CreateWorkOrderSchema = z.object({
  wot: z.string().min(1, "WOT number is required"),
  incidentId: z.string().optional(),
  store: z.string().optional(),
  city: z.string().optional(),
  addr: z.string().optional(),
  afm: z.string().optional(),
  afmEmail: z.string().email("Invalid email").optional().or(z.literal("")),
  lineOfService: z.string().optional(),
  businessService: z.string().optional(),
  category: z.string().optional(),
  subCategory: z.string().optional(),
  priority: z.enum(["p1", "p2", "p3", "p4", "p5"]).optional(),
  nte: z.string().optional(),
  assign: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
})

export type CreateWorkOrderForm = z.infer<typeof CreateWorkOrderSchema>

export const CreateInvoiceLineSchema = z.object({
  type: z.string().min(1),
  desc: z.string(),
  qty: z.number().positive("Must be greater than 0"),
  // Rate fields start EMPTY (contractor enters their own number); an empty
  // number input arrives as NaN via valueAsNumber, which z.number() rejects
  // as an invalid type — surface that as a friendly "Enter a rate".
  rate: z.number({ error: "Enter a rate" }).nonnegative("Must be 0 or greater"),
}).superRefine((line, context) => {
  const descriptionOptional = /^(travel|truck charge)$/i.test(line.type.trim());
  if (!descriptionOptional && !line.desc.trim()) {
    context.addIssue({
      code: "custom",
      path: ["desc"],
      message: "Description is required",
    });
  }
})

export const CreateInvoiceSchema = z.object({
  num: z.string().min(1, "Invoice number is required"),
  invoiceDate: z.string().min(1, "Invoice date is required"),
  serviceDate: z.string().min(1, "Service date is required"),
  terms: z.string().min(1),
  tax: z.string().optional(),
  cme: z.string().optional(),
  uploadOnly: z.boolean().optional(),
  uploadedTotal: z.string().optional(),
  lines: z.array(CreateInvoiceLineSchema),
}).superRefine((invoice, ctx) => {
  if (invoice.uploadOnly) {
    const uploadedTotal = Number(invoice.uploadedTotal);
    if (!Number.isFinite(uploadedTotal) || uploadedTotal <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["uploadedTotal"],
        message: "Enter the total shown on the uploaded invoice",
      });
    }
    return;
  }

  if (invoice.lines.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["lines"],
      message: "At least one line item is required",
    });
  }
})

export type CreateInvoiceForm = z.infer<typeof CreateInvoiceSchema>

export const WorkReportPartSchema = z.object({
  name: z.string().min(1, "Part name is required"),
  partNumber: z.string().optional(),
  qty: z.number().positive("Quantity must be positive"),
})

export const WorkReportSchema = z.object({
  technicianName: z.string().optional(),
  arrivalTime: z.string().min(1, "Arrival time is required"),
  departureTime: z.string().min(1, "Departure time is required"),
  workPerformed: z.string().min(1, "Work performed is required"),
  partsUsed: z.array(WorkReportPartSchema).optional(),
  resolutionCode: z.string().optional(),
  resolutionNotes: z.string().optional(),
})

export type WorkReportForm = z.infer<typeof WorkReportSchema>

export const ChangePasswordSchema = z.object({
  password: z.string().min(8, "Minimum 8 characters"),
  confirm: z.string().min(8, "Minimum 8 characters"),
}).refine(d => d.password === d.confirm, {
  message: "Passwords do not match",
  path: ["confirm"],
})

export type ChangePasswordForm = z.infer<typeof ChangePasswordSchema>
