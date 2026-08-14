export const STAFF_PERMISSION = {
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
