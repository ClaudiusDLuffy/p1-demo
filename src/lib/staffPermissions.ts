export const STAFF_PERMISSION = {
  quickBooksExport: "quickbooks_export",
  // Legacy restricted role. Keep this separate from the additive export
  // capability so an accountant can retain ordinary staff access.
  invoiceController: "invoice_controller",
} as const;

export type StaffPermission = typeof STAFF_PERMISSION[keyof typeof STAFF_PERMISSION];

export type StaffPermissionProfile = {
  staffPermissions?: string[] | null;
};

export function hasStaffPermission(
  profile: StaffPermissionProfile | null | undefined,
  permission: StaffPermission,
): boolean {
  return Array.isArray(profile?.staffPermissions)
    && profile.staffPermissions.includes(permission);
}

export function isInvoiceController(
  profile: StaffPermissionProfile | null | undefined,
): boolean {
  return hasStaffPermission(profile, STAFF_PERMISSION.invoiceController);
}

export function canExportQuickBooks(
  profile: StaffPermissionProfile | null | undefined,
): boolean {
  return hasStaffPermission(profile, STAFF_PERMISSION.quickBooksExport);
}
