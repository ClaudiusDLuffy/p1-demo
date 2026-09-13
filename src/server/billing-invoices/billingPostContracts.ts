import type { NextRequest } from "next/server";
import { StaffInvoiceSaveSchema, type StaffInvoiceSaveCommand } from "../../lib/staffInvoiceContracts";
import { parseFinancialRequest } from "../../lib/financialHttpBoundary";

export type ParsedBillingSaveCommand = StaffInvoiceSaveCommand;

export async function parseBillingSaveRequest(request: NextRequest): Promise<ParsedBillingSaveCommand> {
  return parseFinancialRequest(request, StaffInvoiceSaveSchema);
}
